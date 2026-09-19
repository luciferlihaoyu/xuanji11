/**
 * P0-3 MCP 现代化单测：工具注解、cursor 分页、破坏性操作 dryRun。
 * 端到端走 handleMcpRequest（JSON-RPC），用内存 SQLite 真库（不 mock DB）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";
import { vectorEngine } from "./lib/vector";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./lib/auth", async () => {
  const actual = await vi.importActual<typeof import("./lib/auth")>("./lib/auth");
  return { ...actual, authenticateApiKey: vi.fn() };
});

vi.mock("./local-auth", () => ({ authenticateLocalRequest: vi.fn() }));

vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));

vi.mock("./lib/vector", () => ({
  vectorEngine: {
    deleteByDocumentId: vi.fn().mockResolvedValue(2),
    countByDocumentId: vi.fn().mockResolvedValue(2),
  },
}));

vi.mock("./lib/document-indexer", () => ({
  tryIndexDocumentById: vi.fn().mockResolvedValue({ chunks: 2 }),
  indexDocumentById: vi.fn(),
  startReindexAll: vi.fn(),
  getReindexProgress: vi.fn(),
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

const ALL_SCOPES = [
  "documents:read",
  "documents:write",
  "backups:read",
  "backups:write",
  "workflows:read",
  "workflows:execute",
];

function fullAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ALL_SCOPES };
}

function authHeaders(): Headers {
  return new Headers({ Authorization: "Bearer test-key" });
}

function resultText(res: { result: unknown }): string {
  const result = res.result as { content: Array<{ type: string; text: string }> };
  return result.content[0]?.text ?? "";
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderId INTEGER,
      title TEXT NOT NULL,
      content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown',
      tags TEXT,
      metadata TEXT,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      deletedAt INTEGER,
      deletedReason TEXT,
      mergedIntoId INTEGER
    );
    CREATE TABLE kb_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parentId INTEGER,
      icon TEXT DEFAULT 'folder',
      sortOrder INTEGER DEFAULT 0,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documentId INTEGER NOT NULL,
      itemId INTEGER,
      content TEXT NOT NULL,
      chunkIndex INTEGER NOT NULL DEFAULT 0,
      embedding TEXT,
      embeddingModel TEXT,
      metadata TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE knowledge_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      type TEXT NOT NULL DEFAULT 'concept',
      posX REAL DEFAULT 0,
      posY REAL DEFAULT 0,
      style TEXT,
      metadata TEXT,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId INTEGER NOT NULL,
      targetId INTEGER NOT NULL,
      label TEXT,
      type TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE backup_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      sourcePath TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      filesTotal INTEGER DEFAULT 0,
      filesDone INTEGER DEFAULT 0,
      filesFailed INTEGER DEFAULT 0,
      manifest TEXT,
      config TEXT,
      cron TEXT,
      enabled TEXT NOT NULL DEFAULT 'false',
      nextRunAt INTEGER,
      keepLastN INTEGER DEFAULT 7,
      maxRetries INTEGER DEFAULT 3,
      retryCount INTEGER DEFAULT 0,
      error TEXT,
      startedAt INTEGER,
      completedAt INTEGER,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      canvas TEXT,
      triggers TEXT,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  return drizzle(sqlite, { schema: { ...schema, ...relations } });
}

type TestDb = ReturnType<typeof createTestDb>;

function seedFolder(db: TestDb, name: string): number {
  const r = db.insert(schema.kbFolders).values({ name }).run() as unknown as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

function seedBackupJob(db: TestDb, target: string): number {
  const r = db.insert(schema.backupJobs).values({ target, sourcePath: "/x", status: "pending" }).run() as unknown as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

function seedWorkflow(db: TestDb, name: string): number {
  const r = db.insert(schema.workflows).values({ name, status: "draft" }).run() as unknown as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

function seedDocument(db: TestDb, title: string, chunks: number, withGraph: boolean): number {
  const r = db.insert(schema.kbDocuments).values({ title, content: "c", format: "markdown" }).run() as unknown as { lastInsertRowid: number | bigint };
  const id = Number(r.lastInsertRowid);
  for (let i = 0; i < chunks; i++) {
    db.insert(schema.documentChunks).values({ documentId: id, content: `c${i}`, chunkIndex: i }).run();
  }
  if (withGraph) {
    const node = db
      .insert(schema.knowledgeNodes)
      .values({ title, type: "document", metadata: { documentId: String(id) } })
      .run() as unknown as { lastInsertRowid: number | bigint };
    const other = db.insert(schema.knowledgeNodes).values({ title: "o", type: "concept" }).run() as unknown as { lastInsertRowid: number | bigint };
    db.insert(schema.knowledgeEdges)
      .values({ sourceId: Number(node.lastInsertRowid), targetId: Number(other.lastInsertRowid), type: "related" })
      .run();
  }
  return id;
}

async function callTool(name: string, args: Record<string, unknown>, id = 99) {
  const { handleMcpRequest } = await import("./mcp-server");
  return handleMcpRequest(
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    authHeaders(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: fullAuth() });
  vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
  vi.mocked(vectorEngine.countByDocumentId).mockResolvedValue(2);
});

describe("P0-3 工具注解（annotations）", () => {
  it("每个工具都带完整注解，且分类正确", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, authHeaders());
    const tools = (res as { result: { tools: Array<{ name: string; annotations?: Record<string, unknown>; title?: string }> } }).result.tools;

    expect(tools.length).toBeGreaterThanOrEqual(29);
    const missing = tools.filter((t) => !t.annotations).map((t) => t.name);
    expect(missing).toEqual([]);

    for (const t of tools) {
      const a = t.annotations as Record<string, unknown>;
      expect(typeof a.title, `${t.name}.title 应为非空字符串`).toBe("string");
      expect((a.title as string).length, `${t.name}.title 不应为空`).toBeGreaterThan(0);
      for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof a[key], `${t.name}.${key} 应为布尔`).toBe("boolean");
      }
    }

    const byName = new Map(tools.map((t) => [t.name, t.annotations as Record<string, unknown>]));
    // 只读工具
    for (const n of ["knowledge_search", "document_read", "folder_list", "backup_list", "workflow_list", "kb.reindex_status", "zvec.stats", "analytics.get", "keywords.extract"]) {
      expect(byName.get(n)?.readOnlyHint, `${n} 应为只读`).toBe(true);
      expect(byName.get(n)?.destructiveHint, `${n} 不应破坏性`).toBe(false);
    }
    // 破坏性工具：仅 document_delete 与集合删除
    expect(byName.get("document_delete")?.destructiveHint).toBe(true);
    expect(byName.get("document_delete")?.readOnlyHint).toBe(false);
    expect(byName.get("zvec.deleteCollection")?.destructiveHint).toBe(true);
    // 幂等语义
    expect(byName.get("document_upsert")?.idempotentHint).toBe(true);
    expect(byName.get("document_set_folder")?.idempotentHint).toBe(true);
    expect(byName.get("kb.reindex_all")?.idempotentHint).toBe(true);
    expect(byName.get("document_delete")?.idempotentHint).toBe(false);
    expect(byName.get("backup_trigger")?.idempotentHint).toBe(false);
    // 触达外部系统/网络的工具
    expect(byName.get("backup_trigger")?.openWorldHint).toBe(true);
    expect(byName.get("workflow_execute")?.openWorldHint).toBe(true);
    expect(byName.get("knowledge_search")?.openWorldHint).toBe(false);
  });

  it("tools/list 顺序确定（同一进程内多次调用完全一致）", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const a = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, authHeaders());
    const b = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, authHeaders());
    const names = (r: unknown) => (r as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names(a)).toEqual(names(b));
    expect(new Set(names(a)).size).toBe(names(a).length);
  });
});

describe("P0-3 cursor 分页", () => {
  it("folder_list 分页：nextCursor 可续页，最后一页为 null", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    seedFolder(db, "A");
    seedFolder(db, "B");
    seedFolder(db, "C");

    const p1 = await callTool("folder_list", { limit: 2 });
    const page1 = JSON.parse(resultText(p1 as { result: unknown })) as { items: Array<{ name: string }>; nextCursor: string | null; total: number };
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const p2 = await callTool("folder_list", { limit: 2, cursor: page1.nextCursor as string }, 100);
    const page2 = JSON.parse(resultText(p2 as { result: unknown })) as { items: Array<{ name: string }>; nextCursor: string | null; total: number };
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    // 两页不重叠
    const all = [...page1.items, ...page2.items].map((f) => f.name).sort();
    expect(all).toEqual(["A", "B", "C"]);
  });

  it("非法 cursor → isError 且不静默返回第一页", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    seedFolder(db, "A");
    const res = await callTool("folder_list", { limit: 1, cursor: "not-a-real-cursor!!" });
    const r = res as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]?.text).toContain("Invalid cursor");
  });

  it("backup_list / workflow_list 同样返回分页信封", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    seedBackupJob(db, "alist");
    seedBackupJob(db, "s3");
    seedWorkflow(db, "wf1");

    const b = JSON.parse(resultText((await callTool("backup_list", { limit: 1 })) as { result: unknown })) as { items: unknown[]; nextCursor: string | null; total: number };
    expect(b.total).toBe(2);
    expect(b.items).toHaveLength(1);
    expect(b.nextCursor).not.toBeNull();

    const w = JSON.parse(resultText((await callTool("workflow_list", { limit: 10 })) as { result: unknown })) as { items: unknown[]; nextCursor: string | null; total: number };
    expect(w.total).toBe(1);
    expect(w.items).toHaveLength(1);
    expect(w.nextCursor).toBeNull();
  });

  it("backup_list 的 status 过滤与分页叠加生效", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    seedBackupJob(db, "a");
    seedBackupJob(db, "b");
    const r = JSON.parse(resultText((await callTool("backup_list", { status: "running", limit: 10 })) as { result: unknown })) as { items: unknown[]; total: number };
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });

  it("工具 inputSchema 声明了 cursor / limit", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, authHeaders());
    const tools = (res as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools;
    for (const name of ["folder_list", "backup_list", "workflow_list"]) {
      const props = tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
      expect(Object.keys(props), `${name} 应声明 cursor/limit`).toEqual(expect.arrayContaining(["cursor", "limit"]));
    }
  });
});

describe("P0-3 破坏性操作 dryRun", () => {
  it("document_delete dryRun=true 只报影响面，绝不删数据", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const docId = seedDocument(db, "待删文档", 3, true);

    const res = await callTool("document_delete", { id: docId, dryRun: true });
    const payload = JSON.parse(resultText(res as { result: unknown })) as {
      dryRun: boolean;
      id: number;
      title: string;
      wouldDelete: { chunks: number; vectors: number; graphNodes: number; graphEdges: number };
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.id).toBe(docId);
    expect(payload.title).toBe("待删文档");
    expect(payload.wouldDelete).toEqual({ chunks: 3, vectors: 2, graphNodes: 1, graphEdges: 1 });

    // 数据必须原封不动
    expect(db.select().from(schema.kbDocuments).all()).toHaveLength(1);
    expect(db.select().from(schema.documentChunks).all()).toHaveLength(3);
    expect(db.select().from(schema.knowledgeNodes).all()).toHaveLength(2);
    expect(db.select().from(schema.knowledgeEdges).all()).toHaveLength(1);
    expect(vectorEngine.deleteByDocumentId).not.toHaveBeenCalled();
  });

  it("dryRun 缺省仍为真删（向后兼容），删除后数据消失", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const docId = seedDocument(db, "真删", 2, false);

    const res = await callTool("document_delete", { id: docId });
    const payload = JSON.parse(resultText(res as { result: unknown })) as { success: boolean; deletedChunks: number };
    expect(payload.success).toBe(true);
    expect(payload.deletedChunks).toBe(2);
    expect(db.select().from(schema.kbDocuments).all()).toHaveLength(0);
  });

  it("dryRun 对不存在的文档返回 isError（与真删同口径）", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const res = await callTool("document_delete", { id: 12345, dryRun: true });
    const r = res as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]?.text).toContain("Document not found");
  });

  it("document_delete 的 inputSchema 声明 dryRun", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, authHeaders());
    const tools = (res as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools;
    const props = tools.find((t) => t.name === "document_delete")?.inputSchema.properties ?? {};
    expect(Object.keys(props)).toContain("dryRun");
  });
});
