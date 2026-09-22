import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { User } from "@db/schema";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import type { AuthInfo } from "./lib/auth";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));
vi.mock("./lib/vector", () => ({
  vectorEngine: {
    size: 0,
    deleteByDocumentId: vi.fn(async () => 2),
    countByDocumentId: vi.fn(async () => 2),
    insertBatch: vi.fn(async () => {}),
  },
}));

import { getDb } from "./queries/connection";
import { kbRouter } from "./kb-router";
import { vectorEngine } from "./lib/vector";

/**
 * kb-router 的破坏性删除路径回归。
 *
 * 背景（线上实测）：MCP document_delete 走级联（连图谱一起清），但控制台的
 * `kb.purgeDocument` 与「文件夹删除」只清向量/chunks/FTS，**漏掉图谱节点与边**
 * → 每次这类删除都留下 graph_orphans。本文件锁住「路由层必须走级联」这一接线，
 * 这是纯 lib 测试覆盖不到的地方。
 */
function createDb() {
  const sqlite = new Database(":memory:");
  // 线上真库的三条外键（PRAGMA foreign_key_list 实测），单测带上才拦得住 FK 违反类 bug
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, folderId INTEGER, title TEXT NOT NULL, content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown', tags TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER, deletedReason TEXT, mergedIntoId INTEGER
    );
    CREATE TABLE kb_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parentId INTEGER, icon TEXT,
      sortOrder INTEGER DEFAULT 0, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kb_document_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, documentId INTEGER NOT NULL REFERENCES kb_documents(id),
      versionNumber INTEGER NOT NULL, title TEXT NOT NULL, content TEXT, format TEXT, tags TEXT,
      contentHash TEXT, source TEXT, changedBy INTEGER, changeReason TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kb_ingestion_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, documentId INTEGER NOT NULL REFERENCES kb_documents(id),
      idempotencyKey TEXT, source TEXT, externalId TEXT, contentHash TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kb_search_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, mode TEXT, resultCount INTEGER,
      durationMs INTEGER, userId INTEGER, createdAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, documentId INTEGER NOT NULL REFERENCES kb_documents(id), itemId INTEGER, content TEXT NOT NULL,
      chunkIndex INTEGER NOT NULL DEFAULT 0, embedding TEXT, embeddingModel TEXT, metadata TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT, type TEXT NOT NULL DEFAULT 'concept',
      posX REAL DEFAULT 0, posY REAL DEFAULT 0, style TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sourceId INTEGER NOT NULL, targetId INTEGER NOT NULL, label TEXT,
      type TEXT NOT NULL DEFAULT 'related', weight REAL DEFAULT 1, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
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

function caller(): ReturnType<typeof kbRouter.createCaller> {
  return kbRouter.createCaller({
    req: new Request("http://localhost:3000/"),
    resHeaders: new Headers(),
    user: fakeUser(),
    auth: { type: "session", userId: 1 } as AuthInfo,
  } as never);
}

function seedDoc(db: ReturnType<typeof createDb>, folderId: number | null, withGraph: boolean): number {
  const res = db.insert(schema.kbDocuments)
    .values({ title: `doc-${Math.random().toString(36).slice(2, 7)}`, content: "c", format: "markdown", folderId, createdAt: new Date(0), updatedAt: new Date(0) })
    .run() as unknown as { lastInsertRowid: number | bigint };
  const id = Number(res.lastInsertRowid);
  db.insert(schema.documentChunks).values([
    { documentId: id, content: "c1", chunkIndex: 0, createdAt: new Date(0) },
    { documentId: id, content: "c2", chunkIndex: 1, createdAt: new Date(0) },
  ]).run();
  if (withGraph) {
    const node = db.insert(schema.knowledgeNodes)
      .values({ title: `node-${id}`, type: "document", metadata: { documentId: String(id) }, createdAt: new Date(0), updatedAt: new Date(0) })
      .run() as unknown as { lastInsertRowid: number | bigint };
    const nodeId = Number(node.lastInsertRowid);
    const other = db.insert(schema.knowledgeNodes)
      .values({ title: `concept-${id}`, type: "concept", createdAt: new Date(0), updatedAt: new Date(0) })
      .run() as unknown as { lastInsertRowid: number | bigint };
    db.insert(schema.knowledgeEdges).values([
      { sourceId: nodeId, targetId: Number(other.lastInsertRowid), label: "tag", type: "related", createdAt: new Date(0) },
    ]).run();
  }
  return id;
}

describe("kb-router 删除路径必须走级联（图谱不能漏）", () => {
  beforeEach(() => {
    vi.mocked(vectorEngine.deleteByDocumentId).mockClear();
  });

  it("purgeDocument：文档行、chunks、图谱节点与边一起清掉（旧实现漏图谱）", async () => {
    const db = createDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const docId = seedDoc(db, null, true);
    const keep = seedDoc(db, null, true);

    const r = await caller().purgeDocument({ id: docId });

    expect(r.success).toBe(true);
    expect(db.select().from(schema.kbDocuments).all().map((d) => d.id)).toEqual([keep]);
    expect(db.select().from(schema.documentChunks).all().filter((c) => c.documentId === docId)).toEqual([]);
    const nodeTitles = db.select().from(schema.knowledgeNodes).all().map((n) => n.title);
    expect(nodeTitles).not.toContain(`node-${docId}`);
    expect(nodeTitles).toContain(`node-${keep}`);
    const edges = db.select().from(schema.knowledgeEdges).all().map((e) => e.sourceId);
    expect(edges).not.toContain(undefined);
    expect(db.select().from(schema.knowledgeEdges).all()).toHaveLength(1);
  });

  it("deleteFolder：文件夹（含子孙）内全部文档走级联，图谱不留孤儿", async () => {
    const db = createDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const root = db.insert(schema.kbFolders).values({ name: "root", createdAt: new Date(0), updatedAt: new Date(0) }).run() as unknown as { lastInsertRowid: number | bigint };
    const rootId = Number(root.lastInsertRowid);
    const child = db.insert(schema.kbFolders).values({ name: "child", parentId: rootId, createdAt: new Date(0), updatedAt: new Date(0) }).run() as unknown as { lastInsertRowid: number | bigint };
    const childId = Number(child.lastInsertRowid);
    const a = seedDoc(db, rootId, true);
    const b = seedDoc(db, childId, true);
    const outside = seedDoc(db, null, true);

    const r = await caller().deleteFolder({ id: rootId });

    expect(r.success).toBe(true);
    expect(r.purgeFailed).toEqual([]);
    expect(r.removedFolderCount).toBe(2);
    expect(db.select().from(schema.kbDocuments).all().map((d) => d.id)).toEqual([outside]);
    const nodeTitles = db.select().from(schema.knowledgeNodes).all().map((n) => n.title);
    expect(nodeTitles).not.toContain(`node-${a}`);
    expect(nodeTitles).not.toContain(`node-${b}`);
    expect(nodeTitles).toContain(`node-${outside}`);
    expect(db.select().from(schema.kbFolders).all()).toEqual([]);
  });

  it("pruneGraphOrphans 路由入口：dryRun 报数不删，真删清掉孤儿", async () => {
    const db = createDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    const ghost = db.insert(schema.knowledgeNodes)
      .values({ title: "ghost", type: "document", metadata: { documentId: "999999" }, createdAt: new Date(0), updatedAt: new Date(0) })
      .run() as unknown as { lastInsertRowid: number | bigint };
    const ghostId = Number(ghost.lastInsertRowid);
    db.insert(schema.knowledgeNodes).values({ title: "healthy", type: "document", metadata: { documentId: "1" }, createdAt: new Date(0), updatedAt: new Date(0) }).run();
    seedDoc(db, null, false);

    const dry = await caller().pruneGraphOrphans({ dryRun: true });
    expect(dry).toMatchObject({ orphans: 1, prunedNodes: 0 });
    expect(db.select().from(schema.knowledgeNodes).all().map((n) => n.id)).toContain(ghostId);

    const real = await caller().pruneGraphOrphans({ dryRun: false });
    expect(real).toMatchObject({ orphans: 1, prunedNodes: 1 });
    expect(db.select().from(schema.knowledgeNodes).all().map((n) => n.id)).not.toContain(ghostId);
  });
});
