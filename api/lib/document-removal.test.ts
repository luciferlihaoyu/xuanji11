import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import { deleteDocumentCascade, previewDocumentDeletion, purgeDocumentsCascade } from "./document-removal";

/**
 * document-removal 真实级联删除单测（内存 SQLite，真 drizzle 事务路径）。
 * 线上曾因 async 事务回调炸 "Transaction function cannot return a promise"，
 * 这里用真实 better-sqlite3 驱动兜住回归。
 */

vi.mock("./vector", () => ({
  vectorEngine: {
    deleteByDocumentId: vi.fn().mockResolvedValue(2),
    countByDocumentId: vi.fn().mockResolvedValue(2),
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
      updatedAt INTEGER NOT NULL DEFAULT 0,
      -- dd7eef6 加入软删除字段（手写 DDL 必须与 @db/schema 对齐，否则 insert 直接报 no column）
      deletedAt INTEGER,
      deletedReason TEXT,
      mergedIntoId INTEGER
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

describe("purgeDocumentsCascade（多条一次性彻底删除：文件夹删除 / 批量彻底删除共用）", () => {
  beforeEach(() => {
    vi.mocked(vectorEngine.deleteByDocumentId).mockClear();
    vi.mocked(vectorEngine.deleteByDocumentId).mockResolvedValue(2);
  });

  it("逐篇走级联：chunks 与图谱节点/边全部清干净，计数如实汇总", async () => {
    const db = createDb();
    const a = seedDocument(db, true);
    const b = seedDocument(db, true);
    const keep = seedDocument(db, true);

    const r = await purgeDocumentsCascade(db, vectorEngine as never, [a, b]);

    expect(r.purged).toBe(2);
    expect(r.failed).toEqual([]);
    expect(r.deletedChunks).toBe(4);
    expect(r.deletedNodes).toBe(2);
    expect(r.deletedEdges).toBe(4);
    const docIds = db.select().from(schema.kbDocuments).all().map((d) => d.id);
    expect(docIds).toEqual([keep]);
    const orphanChunks = db.select().from(schema.documentChunks).all().filter((c) => c.documentId === a || c.documentId === b);
    expect(orphanChunks).toEqual([]);
    // 保留篇的图谱节点与边仍在（不能误删别的文档的图谱）
    const nodeTitles = db.select().from(schema.knowledgeNodes).all().map((n) => n.title);
    expect(nodeTitles).toContain("t");
  });

  it("其中一篇不存在时不中断其余：如实报 failed，不谎报 purged", async () => {
    const db = createDb();
    const a = seedDocument(db, false);

    const r = await purgeDocumentsCascade(db, vectorEngine as never, [a, 999999]);

    expect(r.purged).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.id).toBe(999999);
    expect(String(r.failed[0]!.error)).toContain("999999");
  });
});

describe("previewDocumentDeletion（破坏性操作 dryRun：只报数，不改数据）", () => {
  beforeEach(() => {
    vi.mocked(vectorEngine.deleteByDocumentId).mockClear();
    vi.mocked(vectorEngine.deleteByDocumentId).mockResolvedValue(2);
    vi.mocked(vectorEngine.countByDocumentId).mockClear();
    vi.mocked(vectorEngine.countByDocumentId).mockResolvedValue(2);
  });

  it("报告将删除的 chunks/vectors/图谱节点边，且一行都不删", async () => {
    const db = createDb();
    const docId = seedDocument(db, true);
    const snapshot = () => ({
      docs: db.select().from(schema.kbDocuments).all().length,
      chunks: db.select().from(schema.documentChunks).all().length,
      nodes: db.select().from(schema.knowledgeNodes).all().length,
      edges: db.select().from(schema.knowledgeEdges).all().length,
    });
    const before = snapshot();

    const preview = await previewDocumentDeletion(db, vectorEngine, docId);

    expect(preview.id).toBe(docId);
    expect(preview.title).toBe("t");
    expect(preview.format).toBe("markdown");
    expect(preview.wouldDelete).toEqual({ chunks: 2, vectors: 2, graphNodes: 1, graphEdges: 2 });
    // 核心不变量：预览绝不修改数据，也不调用破坏性向量删除
    expect(snapshot()).toEqual(before);
    expect(vectorEngine.deleteByDocumentId).not.toHaveBeenCalled();
  });

  it("预览数字与真实级联删除结果逐项一致（不谎报）", async () => {
    const db = createDb();
    const docId = seedDocument(db, true);
    const preview = await previewDocumentDeletion(db, vectorEngine, docId);
    const real = await deleteDocumentCascade(db, vectorEngine, docId);
    expect(preview.wouldDelete).toEqual({
      chunks: real.deletedChunks,
      vectors: real.deletedVectors,
      graphNodes: real.deletedNodes,
      graphEdges: real.deletedEdges,
    });
  });

  it("文档不存在 → 抛 Document not found（与级联删除同口径），且不查向量", async () => {
    const db = createDb();
    await expect(previewDocumentDeletion(db, vectorEngine, 999)).rejects.toThrow("Document not found: 999");
    expect(vectorEngine.countByDocumentId).not.toHaveBeenCalled();
  });

  it("无图谱节点时 nodes/edges 为 0，向量计数照实调用", async () => {
    const db = createDb();
    const docId = seedDocument(db, false);
    vi.mocked(vectorEngine.countByDocumentId).mockResolvedValue(0);
    const preview = await previewDocumentDeletion(db, vectorEngine, docId);
    expect(preview.wouldDelete).toEqual({ chunks: 2, vectors: 0, graphNodes: 0, graphEdges: 0 });
    expect(vectorEngine.countByDocumentId).toHaveBeenCalledWith(docId);
  });
});
