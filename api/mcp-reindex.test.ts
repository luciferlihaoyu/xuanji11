import { describe, expect, it, vi, beforeEach } from "vitest";
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

vi.mock("./lib/document-indexer", () => ({
  tryIndexDocumentById: vi.fn(),
  startReindexAll: vi.fn(),
  getReindexProgress: vi.fn(),
}));

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
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve([{ insertId: 77 }])),
    })),
  };
}

describe("MCP kb.reindex tools", () => {
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

    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ id: 77, chunks: 3 });
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

    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ success: true, id: 55, chunks: 5 });
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

    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ success: true, id: 55, chunks: 0 });
    expect(tryIndexDocumentById).not.toHaveBeenCalled();
  });
});
