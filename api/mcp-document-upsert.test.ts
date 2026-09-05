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

// document_upsert 测试不 mock document-removal / title-normalize（用真实实现）

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

/** 与 schema 对齐的最小内存库；用真实 drizzle 实例。 */
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

function countKbDocuments(db: unknown): number {
  return (
    db as {
      select: () => { from: (t: unknown) => { all: () => unknown[] } };
    }
  )
    .select()
    .from((schema as { kbDocuments: unknown }).kbDocuments)
    .all().length;
}

describe("MCP document_upsert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
  });

  it("creates a new document on first call", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "document_upsert", arguments: { title: "第一份文档" } },
      },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const payload = JSON.parse(resultText(res as { result: unknown }));
      expect(payload).toMatchObject({ action: "created" });
      expect(typeof payload.id).toBe("number");
    }
    expect(countKbDocuments(db)).toBe(1);
  });

  it("updates the same document on second call with identical title", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    const first = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "document_upsert", arguments: { title: "重复标题" } },
      },
      authHeaders(),
    );
    const firstPayload = JSON.parse(resultText(first as { result: unknown })) as {
      id: number;
      action: string;
    };
    expect(firstPayload.action).toBe("created");

    const second = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "document_upsert", arguments: { title: "重复标题", content: "新内容" } },
      },
      authHeaders(),
    );
    const secondPayload = JSON.parse(resultText(second as { result: unknown })) as {
      id: number;
      action: string;
    };

    expect(secondPayload.action).toBe("updated");
    expect(secondPayload.id).toBe(firstPayload.id);
    expect(countKbDocuments(db)).toBe(1);
  });

  it("treats titles that differ only by a [xxx] prefix as the same document", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    const first = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "document_upsert", arguments: { title: "[OpenClaw记忆/agent/x] 场景: 天宫" } },
      },
      authHeaders(),
    );
    const firstPayload = JSON.parse(resultText(first as { result: unknown })) as {
      id: number;
      action: string;
    };
    expect(firstPayload.action).toBe("created");

    const second = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "document_upsert", arguments: { title: "场景: 天宫" } },
      },
      authHeaders(),
    );
    const secondPayload = JSON.parse(resultText(second as { result: unknown })) as {
      id: number;
      action: string;
    };

    expect(secondPayload.action).toBe("updated");
    expect(secondPayload.id).toBe(firstPayload.id);
    expect(countKbDocuments(db)).toBe(1);
  });

  it("treats titles that differ only by whitespace/case as the same document", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    const first = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: { name: "document_upsert", arguments: { title: "Hello World" } },
      },
      authHeaders(),
    );
    const firstPayload = JSON.parse(resultText(first as { result: unknown })) as {
      id: number;
      action: string;
    };
    expect(firstPayload.action).toBe("created");

    const second = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "document_upsert", arguments: { title: "  hello  world " } },
      },
      authHeaders(),
    );
    const secondPayload = JSON.parse(resultText(second as { result: unknown })) as {
      id: number;
      action: string;
    };

    expect(secondPayload.action).toBe("updated");
    expect(secondPayload.id).toBe(firstPayload.id);
    expect(countKbDocuments(db)).toBe(1);
  });

  it("calls tryIndexDocumentById when content is provided", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");

    vi.mocked(tryIndexDocumentById).mockClear();

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: { name: "document_upsert", arguments: { title: "有内容的文档", content: "hello world" } },
      },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const payload = JSON.parse(resultText(res as { result: unknown })) as { id: number; action: string };
      expect(payload.action).toBe("created");
      expect(typeof payload.id).toBe("number");
    }
    expect(tryIndexDocumentById).toHaveBeenCalled();
  });
});
