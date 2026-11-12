import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";
import { tryIndexDocumentById, startReindexAll, getReindexProgress } from "./lib/document-indexer";
import { vectorEngine } from "./lib/vector";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./lib/auth", async () => {
  const actual = await vi.importActual<typeof import("./lib/auth")>("./lib/auth");
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
  };
});

vi.mock("./local-auth", () => ({
  authenticateLocalRequest: vi.fn(),
}));

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

// 用 importActual 展开真模块：将来 document-indexer 新增导出时，替身**自动**跟着长，
// 不会再出现"No xxx export is defined on the mock"这种"生产加了依赖、替身忘了加"的红。
// （2026-11-12 天演评审：手抄导出清单的替身必然再次漂移。）
vi.mock("./lib/document-indexer", async () => {
  const actual = await vi.importActual<typeof import("./lib/document-indexer")>("./lib/document-indexer");
  return {
    ...actual,
    tryIndexDocumentById: vi.fn(),
    startReindexAll: vi.fn(),
    // 真实现（api/lib/document-indexer.ts:205）永远返回对象：getReindexProgress(): { ...progress }
    // 生产代码 handleKbReindexAll 会读 getReindexProgress().running（句柄复用逻辑 P0-4），
    // 替身不给默认值 → undefined.running 直接抛错，这条测试从那时起一直红。
    // vi.clearAllMocks() 只清调用记录、不清实现，故此默认实现可存活。
    getReindexProgress: vi.fn(() => ({ running: false, total: 0, done: 0, failed: 0, chunksTotal: 0 })),
    // P0-4 还引入了"活动回填句柄"依赖：handleKbReindexAll 会问 getActiveReindexTaskId()，
    // 句柄存在则复用（reused/adopted），不存在才新建。mock 工厂漏了这个导出 → vitest 直接抛
    // "No getActiveReindexTaskId export is defined on the mock"。返回 undefined = 当前无活动句柄。
    getActiveReindexTaskId: vi.fn(() => undefined),
  };
});

vi.mock("./lib/vector", () => ({
  vectorEngine: { size: 42 },
  initializeZvec: vi.fn(),
}));

vi.mock("./lib/vector-service", () => ({
  listCollections: vi.fn(),
  addDocumentsToCollection: vi.fn(),
  deleteCollection: vi.fn(),
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
  getStats: vi.fn(),
  initializeZvec: vi.fn(),
  vectorEngine: { size: 42 },
}));

function fakeUser(): User {
  return {
    id: 1,
    unionId: "local_admin",
    name: "admin",
    email: null,
    avatar: null,
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignInAt: new Date(),
  };
}

function docsAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["documents:read", "documents:write"] };
}

function readOnlyAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["documents:read"] };
}

function authHeaders(): Headers {
  return new Headers({ Authorization: "Bearer test-key" });
}

function resultText(res: { result: unknown }): string {
  const result = res.result as { content: Array<{ type: string; text: string }> };
  return result.content[0]?.text ?? "";
}

function createFakeDb() {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    // 应用已迁到 better-sqlite3：insert 结果读 lastInsertRowid（原 [{insertId}] 是 MySQL 口径遗留，
    // 会让 Number(undefined) → NaN，JSON 序列化成 null，测试于是断言到 id:null）
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve({ lastInsertRowid: 77, changes: 1 })),
    })),
  };
}

describe("MCP kb.reindex tools", () => {
  // 用例之间会泄漏 mockReturnValue：vi.clearAllMocks() **只清调用记录、不清实现/返回值**，
  // 后一条用例设的 mockReturnValue 会漏给后续用例 → 顺序耦合的幽灵绿/幽灵红。
  // resetAllMocks 会把实现复位回 vi.fn(impl) 的原始实现（默认实现因此存活），返回值则清空。
  afterEach(() => {
    vi.resetAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: docsAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
  });

  it("exposes kb.reindex_all and kb.reindex_status in tools/list", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, authHeaders());

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const tools = (res.result as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name);
      expect(names).toContain("kb.reindex_all");
      expect(names).toContain("kb.reindex_status");
    }
  });

  it("starts a full reindex with documents:write scope", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(startReindexAll).mockReturnValue({ running: true, total: 0, done: 0, failed: 0, chunksTotal: 0, startedAt: "2026-07-21T00:00:00Z" });

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kb.reindex_all", arguments: {} } },
      authHeaders(),
    );

    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toMatchObject({ running: true });
    expect(startReindexAll).toHaveBeenCalled();
  });

  it("rejects kb.reindex_all without documents:write scope", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: readOnlyAuth() });

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kb.reindex_all", arguments: {} } },
      authHeaders(),
    );

    expect("error" in res && res.error.code).toBe(-32603);
    expect(startReindexAll).not.toHaveBeenCalled();
  });

  it("returns reindex progress with vector size", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(getReindexProgress).mockReturnValue({ running: false, total: 160, done: 160, failed: 0, chunksTotal: 500 });

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kb.reindex_status", arguments: {} } },
      authHeaders(),
    );

    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({
      running: false,
      total: 160,
      done: 160,
      failed: 0,
      chunksTotal: 500,
      vectorSize: 42,
    });
  });
});

describe("MCP document_write auto-indexing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: docsAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);
  });

  it("indexes new documents that have content", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(tryIndexDocumentById).mockResolvedValue({ chunks: 3, skipped: false });

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "document_write", arguments: { title: "新文档", content: "一些内容" } },
      },
      authHeaders(),
    );

    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ id: 77, chunks: 3, indexed: true });
    expect(tryIndexDocumentById).toHaveBeenCalledWith(77);
  });

  it("does not index new documents without content", async () => {
    const { handleMcpRequest } = await import("./mcp-server");

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "document_write", arguments: { title: "空文档" } },
      },
      authHeaders(),
    );

    // 无内容的文档**没有 indexed 字段**：压根没索引过，不该宣称"索引成功"
    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ id: 77, chunks: 0 });
    expect(tryIndexDocumentById).not.toHaveBeenCalled();
  });

  it("reindexes when update includes content", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(tryIndexDocumentById).mockResolvedValue({ chunks: 5, skipped: false });

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "document_write", arguments: { id: 55, content: "更新后的内容" } },
      },
      authHeaders(),
    );

    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ success: true, id: 55, chunks: 5, indexed: true });
    expect(tryIndexDocumentById).toHaveBeenCalledWith(55);
  });

  it("does not reindex when update only changes the title", async () => {
    const { handleMcpRequest } = await import("./mcp-server");

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "document_write", arguments: { id: 55, title: "仅改标题" } },
      },
      authHeaders(),
    );

    // 仅改标题：没碰内容 → 没有索引动作 → 无 indexed 字段
    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ success: true, id: 55, chunks: 0 });
    expect(tryIndexDocumentById).not.toHaveBeenCalled();
  });
});
