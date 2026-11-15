import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { User } from "@db/schema";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import type { AuthInfo } from "./lib/auth";

// env.ts 启动校验需要（同款既有测试文件，防并行 worker 偶发红）
vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./queries/connection", () => ({ getDb: vi.fn(), getRawDb: vi.fn() }));
vi.mock("./lib/vector", () => ({
  vectorEngine: { deleteByDocumentId: vi.fn(async () => 2) },
}));
vi.mock("./lib/vector-service", () => ({ searchVectors: vi.fn(async () => []) }));
vi.mock("./lib/edge-writer", () => ({ insertEdge: vi.fn(async () => undefined) }));

import { getDb, getRawDb } from "./queries/connection";
import { knowledgeRouter } from "./knowledge-router";
import { ensureFts, _resetFtsReadyForTests } from "./lib/fts-search";

/**
 * knowledge.deleteNode 的 FTS 原子化回归（审查 Standards「吞错形状」渠道 3/3）。
 * 旧形：try { deleteDocumentFromFts } catch warn → chunks 照删——FTS 一旦损坏就静默留孤儿。
 * 根治后：FTS 清理与 chunks 删除同事务，失败整体拒绝。
 */
function createDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE kb_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      parentId INTEGER REFERENCES kb_folders(id), icon TEXT,
      sortOrder INTEGER DEFAULT 0, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, folderId INTEGER REFERENCES kb_folders(id),
      title TEXT NOT NULL, content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown', tags TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER, deletedReason TEXT, mergedIntoId INTEGER
    );
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, documentId INTEGER NOT NULL REFERENCES kb_documents(id),
      itemId INTEGER, content TEXT NOT NULL,
      chunkIndex INTEGER NOT NULL DEFAULT 0, embedding TEXT, embeddingModel TEXT, metadata TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0,
      charStart INTEGER, charEnd INTEGER, pageStart INTEGER, pageEnd INTEGER,
      sectionPath TEXT, contentHash TEXT
    );
    CREATE TABLE knowledge_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT,
      type TEXT NOT NULL DEFAULT 'concept',
      posX REAL DEFAULT 0, posY REAL DEFAULT 0, style TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId INTEGER NOT NULL REFERENCES knowledge_nodes(id),
      targetId INTEGER NOT NULL REFERENCES knowledge_nodes(id), label TEXT,
      type TEXT NOT NULL DEFAULT 'related', weight REAL DEFAULT 1, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      evidence TEXT, evidenceDocumentId INTEGER, evidenceChunkId INTEGER
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entityType TEXT NOT NULL, entityId INTEGER NOT NULL,
      action TEXT NOT NULL, actorId INTEGER, details TEXT, createdAt INTEGER NOT NULL DEFAULT 0
    );
  `);
  return drizzle(sqlite, { schema: { ...schema, ...relations } });
}

function fakeUser(): User {
  return {
    id: 1, unionId: "local_admin", name: "admin", email: null, avatar: null, role: "admin",
    createdAt: new Date(), updatedAt: new Date(), lastSignInAt: new Date(),
  };
}

function caller(): ReturnType<typeof knowledgeRouter.createCaller> {
  return knowledgeRouter.createCaller({
    req: new Request("http://localhost:3000/"),
    resHeaders: new Headers(),
    user: fakeUser(),
    auth: { type: "session", userId: 1 } as AuthInfo,
  } as never);
}

/** 建一个绑定文档的图谱节点（metadata.documentId 用字符串——线上 97% 的形状，T1-02 口径） */
function seedDocNode(db: ReturnType<typeof createDb>, docId: number): number {
  const res = db
    .insert(schema.knowledgeNodes)
    .values({ title: "节点", type: "document", metadata: { documentId: String(docId) }, createdAt: new Date(), updatedAt: new Date() })
    .run() as unknown as { lastInsertRowid: number | bigint };
  return Number(res.lastInsertRowid);
}

function seedDocumentWithChunk(db: ReturnType<typeof createDb>): number {
  const res = db
    .insert(schema.kbDocuments)
    .values({ title: "绑文档的节点篇", content: "x", format: "markdown", createdAt: new Date(), updatedAt: new Date() })
    .run() as unknown as { lastInsertRowid: number | bigint };
  const docId = Number(res.lastInsertRowid);
  db.insert(schema.documentChunks)
    .values({ documentId: docId, content: "块内容", chunkIndex: 0, createdAt: new Date() })
    .run();
  return docId;
}

describe("knowledge.deleteNode FTS 原子化（渠道 3/3）", () => {
  it("健康态：FTS 行随 chunks 一并清干净，节点与边删除成功", async () => {
    const db = createDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(getRawDb).mockReturnValue(db.$client as never);
    _resetFtsReadyForTests();

    const docId = seedDocumentWithChunk(db);
    const nodeId = seedDocNode(db, docId);
    ensureFts(); // 建表+回填，fts 有该块行

    const r = await caller().deleteNode({ id: nodeId });
    expect(r.success).toBe(true);
    expect(db.select().from(schema.documentChunks).all().length).toBe(0);
    expect((db.$client as Database.Database).prepare("SELECT COUNT(*) c FROM chunks_fts").get()).toEqual({ c: 0 });
    expect(db.select().from(schema.knowledgeNodes).all().length).toBe(0);
  });

  it("FTS 损坏时 deleteNode 整体拒绝：chunks 保留、节点也保留（旧形吞错照删=永久孤儿）", async () => {
    const db = createDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(getRawDb).mockReturnValue(db.$client as never);
    _resetFtsReadyForTests();

    const docId = seedDocumentWithChunk(db);
    const nodeId = seedDocNode(db, docId);
    ensureFts();
    (db.$client as Database.Database).exec("DROP TABLE chunks_fts; CREATE VIEW chunks_fts AS SELECT 1 AS x;");
    _resetFtsReadyForTests();

    await expect(caller().deleteNode({ id: nodeId })).rejects.toThrow();

    // 原子性：FTS 没清成则 chunks 不许动（旧形会照删 → 孤儿）
    expect(db.select().from(schema.documentChunks).all().length).toBe(1);
    // 整体失败：节点行也必须还在（旧形 FTS warn 后照样删到底）
    expect(db.select().from(schema.knowledgeNodes).all().length).toBe(1);
  });
});
