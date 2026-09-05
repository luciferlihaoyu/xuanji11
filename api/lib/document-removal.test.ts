import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import { deleteDocumentCascade } from "./document-removal";

/**
 * document-removal 真实级联删除单测（内存 SQLite，真 drizzle 事务路径）。
 * 线上曾因 async 事务回调炸 "Transaction function cannot return a promise"，
 * 这里用真实 better-sqlite3 驱动兜住回归。
 */

vi.mock("./vector", () => ({
  vectorEngine: {
    deleteByDocumentId: vi.fn().mockResolvedValue(2),
  },
}));

import { vectorEngine } from "./vector";

function createDb() {
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
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0
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
      createdAt INTEGER NOT NULL DEFAULT 0
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
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId INTEGER NOT NULL,
      targetId INTEGER NOT NULL,
      label TEXT,
      type TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0
    );
  `);
  return drizzle(sqlite, { schema: { ...schema, ...relations } });
}

function seedDocument(db: ReturnType<typeof createDb>, withGraph: boolean): number {
  const now = Date.now();
  const res = db
    .insert(schema.kbDocuments)
    .values({ title: "t", content: "c", format: "markdown", createdAt: new Date(now), updatedAt: new Date(now) })
    .run() as unknown as { lastInsertRowid: number | bigint };
  const docId = Number(res.lastInsertRowid);
  db.insert(schema.documentChunks)
    .values([
      { documentId: docId, content: "c1", chunkIndex: 0, createdAt: new Date(now) },
      { documentId: docId, content: "c2", chunkIndex: 1, createdAt: new Date(now) },
    ])
    .run();
  if (withGraph) {
    const node = db
      .insert(schema.knowledgeNodes)
      .values({
        title: "t",
        type: "document",
        metadata: { documentId: String(docId) },
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .run() as unknown as { lastInsertRowid: number | bigint };
    const nodeId = Number(node.lastInsertRowid);
    const other = db
      .insert(schema.knowledgeNodes)
      .values({ title: "o", type: "concept", createdAt: new Date(now), updatedAt: new Date(now) })
      .run() as unknown as { lastInsertRowid: number | bigint };
    const otherId = Number(other.lastInsertRowid);
    db.insert(schema.knowledgeEdges)
      .values([
        { sourceId: nodeId, targetId: otherId, type: "related", createdAt: new Date(now) },
        { sourceId: otherId, targetId: nodeId, type: "related", createdAt: new Date(now) },
      ])
      .run();
  }
  return docId;
}

describe("deleteDocumentCascade", () => {
  beforeEach(() => {
    vi.mocked(vectorEngine.deleteByDocumentId).mockClear();
    vi.mocked(vectorEngine.deleteByDocumentId).mockResolvedValue(2);
  });

  it("cascades chunks, graph nodes/edges, and the document row", async () => {
    const db = createDb();
    const docId = seedDocument(db, true);

    const r = await deleteDocumentCascade(db, vectorEngine, docId);

    expect(r.deletedChunks).toBe(2);
    expect(r.deletedNodes).toBe(1);
    expect(r.deletedEdges).toBe(2);
    expect(vectorEngine.deleteByDocumentId).toHaveBeenCalledWith(docId);

    const docs = db.select().from(schema.kbDocuments).all();
    const chunks = db.select().from(schema.documentChunks).all();
    const nodes = db.select().from(schema.knowledgeNodes).all();
    const edges = db.select().from(schema.knowledgeEdges).all();
    expect(docs).toHaveLength(0);
    expect(chunks).toHaveLength(0);
    // 只有 document 型节点被删；其他节点保留
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("concept");
    expect(edges).toHaveLength(0);
  });

  it("throws Document not found for missing id (and does not touch vectors)", async () => {
    const db = createDb();
    await expect(deleteDocumentCascade(db, vectorEngine, 999)).rejects.toThrow("Document not found: 999");
    expect(vectorEngine.deleteByDocumentId).not.toHaveBeenCalled();
  });

  it("keeps other documents intact", async () => {
    const db = createDb();
    const a = seedDocument(db, false);
    const b = seedDocument(db, false);

    await deleteDocumentCascade(db, vectorEngine, a);

    const docs = db.select().from(schema.kbDocuments).all();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe(b);
  });

  it("works when the document has no linked graph nodes", async () => {
    const db = createDb();
    const docId = seedDocument(db, false);

    const r = await deleteDocumentCascade(db, vectorEngine, docId);

    expect(r.deletedNodes).toBe(0);
    expect(r.deletedEdges).toBe(0);
    expect(r.deletedChunks).toBe(2);
    expect(db.select().from(schema.kbDocuments).all()).toHaveLength(0);
  });
});
