import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";
import { tryIndexDocumentById } from "./lib/document-indexer";
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

vi.mock("./lib/vector", () => ({
  vectorEngine: { deleteByDocumentId: vi.fn().mockResolvedValue(3) },
}));

vi.mock("./lib/document-indexer", () => ({
  tryIndexDocumentById: vi.fn().mockResolvedValue({ chunks: 2 }),
  indexDocumentById: vi.fn(),
  startReindexAll: vi.fn(),
  getReindexProgress: vi.fn(),
}));

// folder / document_set_folder 测试不 mock document-removal / title-normalize

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

function readOnlyAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["documents:read"] };
}

function writeAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["documents:read", "documents:write"] };
}

function authHeaders(): Headers {
  return new Headers({ Authorization: "Bearer test-key" });
}

function resultText(res: { result: unknown }): string {
  const result = res.result as { content: Array<{ type: string; text: string }> };
  return result.content[0]?.text ?? "";
}

/**
 * 创建一张与 db/schema.ts 兼容的内存 SQLite 库，覆盖本测试用到的五张表。
 * json 列用 TEXT，timestamp_ms 列用 INTEGER。
 */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
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
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
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
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  return drizzle(sqlite, { schema: { ...schema, ...relations } });
}

describe("MCP folder tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
  });

  it("exposes the three folder tools in tools/list", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const tools = (res.result as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name);
      expect(names).toContain("folder_create");
      expect(names).toContain("folder_list");
      expect(names).toContain("document_set_folder");
    }
  });

  it("folder_create writes a row and returns id/name/parentId", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "folder_create", arguments: { name: "我的笔记" } },
      },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const payload = JSON.parse(resultText(res as { result: unknown }));
      expect(payload).toMatchObject({ name: "我的笔记", parentId: null });
      expect(typeof payload.id).toBe("number");
    }

    // 直查库
    const rows = (db as unknown as { select: () => { from: (t: unknown) => { all: () => unknown[] } } })
      .select()
      .from((schema as { kbFolders: unknown }).kbFolders)
      .all() as Array<{ id: number; name: string; parentId: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "我的笔记", parentId: null });
  });

  it("folder_create rejects duplicate sibling name as isError containing 'exists'", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    // 第一次创建
    const first = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "folder_create", arguments: { name: "重复名" } },
      },
      authHeaders(),
    );
    expect("result" in first).toBe(true);

    // 第二次同名
    const second = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "folder_create", arguments: { name: "重复名" } },
      },
      authHeaders(),
    );

    expect("result" in second).toBe(true);
    if ("result" in second) {
      const result = second.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text ?? "").toContain("exists");
    }
  });

  it("folder_create with non-existent parentId returns isError", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "folder_create", arguments: { name: "子目录", parentId: 999 } },
      },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
    }
  });

  it("folder_list counts documents per folder", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    // 先建一个 folder
    const created = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "folder_create", arguments: { name: "归档" } },
      },
      authHeaders(),
    );
    expect("result" in created).toBe(true);
    const folderId = JSON.parse(resultText(created as { result: unknown })).id as number;

    // 插入 2 篇 kb_documents 指向它
    const insertDocs = (
      db as unknown as { insert: (t: unknown) => { values: (v: unknown) => { run: () => unknown } } }
    ).insert((schema as { kbDocuments: unknown }).kbDocuments);
    insertDocs.values({ title: "doc1", folderId, format: "markdown" }).run();
    insertDocs.values({ title: "doc2", folderId, format: "markdown" }).run();

    // 调 folder_list
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "folder_list", arguments: {} } },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const list = JSON.parse(resultText(res as { result: unknown })) as Array<{
        id: number;
        name: string;
        parentId: number | null;
        documentCount: number;
      }>;
      const target = list.find((f) => f.id === folderId);
      expect(target).toBeDefined();
      expect(target?.documentCount).toBe(2);
    }
  });

  describe("document_set_folder", () => {
    it("moves an existing document and does not call tryIndexDocumentById", async () => {
      const db = createTestDb();
      vi.mocked(getDb).mockReturnValue(db);
      const { handleMcpRequest } = await import("./mcp-server");

      // 建一个 folder
      const folderRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: { name: "folder_create", arguments: { name: "目标" } },
        },
        authHeaders(),
      );
      const folderId = JSON.parse(resultText(folderRes as { result: unknown })).id as number;

      // 直接 insert 一篇文档（模拟 document_write 的副作用，不经 MCP）
      const insertDoc = (
        db as unknown as { insert: (t: unknown) => { values: (v: unknown) => { run: () => unknown } } }
      ).insert((schema as { kbDocuments: unknown }).kbDocuments);
      const inserted = insertDoc.values({ title: "散落文档", format: "markdown" }).run() as { lastInsertRowid: number | bigint };
      const docId = Number(inserted.lastInsertRowid);

      // 清掉 document-indexer 的调用记录
      vi.mocked(tryIndexDocumentById).mockClear();

      const res = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 31,
          method: "tools/call",
          params: { name: "document_set_folder", arguments: { id: docId, folderId } },
        },
        authHeaders(),
      );

      expect("result" in res).toBe(true);
      if ("result" in res) {
        const payload = JSON.parse(resultText(res as { result: unknown }));
        expect(payload).toEqual({ success: true, id: docId, folderId });
      }

      // 直查库 folderId 应已更新
      const docRows = (
        db as unknown as {
          select: () => {
            from: (t: unknown) => {
              all: () => Array<{ id: number; folderId: number | null }>;
            };
          };
        }
      )
        .select()
        .from((schema as { kbDocuments: unknown }).kbDocuments)
        .all() as Array<{ id: number; folderId: number | null }>;
      const target = docRows.find((r) => r.id === docId);
      expect(target?.folderId).toBe(folderId);

      // 关键：不能触发索引重建
      expect(tryIndexDocumentById).not.toHaveBeenCalled();
    });

    it("returns isError when document id does not exist", async () => {
      const db = createTestDb();
      vi.mocked(getDb).mockReturnValue(db);
      const { handleMcpRequest } = await import("./mcp-server");

      const folderRes = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 40,
          method: "tools/call",
          params: { name: "folder_create", arguments: { name: "任何" } },
        },
        authHeaders(),
      );
      const folderId = JSON.parse(resultText(folderRes as { result: unknown })).id as number;

      const res = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 41,
          method: "tools/call",
          params: { name: "document_set_folder", arguments: { id: 999, folderId } },
        },
        authHeaders(),
      );

      expect("result" in res).toBe(true);
      if ("result" in res) {
        const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
      }
    });
  });
});
