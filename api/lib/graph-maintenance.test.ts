import { describe, expect, it, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "file::memory:";
  process.env.ADMIN_USERNAME ||= "test";
  process.env.ADMIN_PASSWORD ||= "test-password";
});

import { _setDbForTests } from "../queries/connection";
import { pruneGraphOrphans } from "./graph-maintenance";

/**
 * 图谱孤儿清理（线上巡检 graph_orphans 的显式维护动作）。
 * 真实内存 SQLite，口径与 index-health 的巡检判定严格一致。
 */
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderId INTEGER, title TEXT NOT NULL, content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown', tags TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER, deletedReason TEXT, mergedIntoId INTEGER
    );
    CREATE TABLE knowledge_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT,
      type TEXT NOT NULL DEFAULT 'concept', posX REAL DEFAULT 0, posY REAL DEFAULT 0,
      style TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sourceId INTEGER NOT NULL, targetId INTEGER NOT NULL,
      label TEXT, type TEXT NOT NULL DEFAULT 'related', weight REAL DEFAULT 1, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO kb_documents(id, title, content, createdAt, updatedAt) VALUES (10, '存活文档', 'x', 0, 0);
    -- 存活文档的图谱节点（必须保留）
    INSERT INTO knowledge_nodes(id, title, type, metadata, createdAt, updatedAt)
      VALUES (100, '存活文档节点', 'document', '{"documentId":10}', 0, 0);
    -- 孤儿节点：documentId=999 的文档已不存在
    INSERT INTO knowledge_nodes(id, title, type, metadata, createdAt, updatedAt)
      VALUES (200, '孤儿文档节点', 'document', '{"documentId":999}', 0, 0);
    -- 概念节点与 tag 节点（非 document，永远不是孤儿）
    INSERT INTO knowledge_nodes(id, title, type, metadata, createdAt, updatedAt)
      VALUES (300, '概念节点', 'concept', NULL, 0, 0), (400, '标签节点', 'tag', '{"documentId":999}', 0, 0);
    -- document 类型但 metadata 无 documentId：巡检口径不计入孤儿（NULL NOT IN → NULL）
    INSERT INTO knowledge_nodes(id, title, type, metadata, createdAt, updatedAt)
      VALUES (500, '无 documentId 的文档节点', 'document', '{"source":"legacy"}', 0, 0);
    -- 边：100↔300 健康边；200↔300 与 400↔200 是被孤儿牵连的边
    INSERT INTO knowledge_edges(id, sourceId, targetId, label, type, createdAt, updatedAt) VALUES
      (1000, 100, 300, 'related', 'related', 0, 0),
      (1001, 200, 300, 'tag', 'related', 0, 0),
      (1002, 400, 200, 'tag', 'related', 0, 0);
  `);
  db = drizzle(sqlite, { schema: { ...schema, ...relations } });
  _setDbForTests(sqlite as never);
});

describe("pruneGraphOrphans", () => {
  it("dryRun 只报数：孤儿节点 1 个、牵连边 2 条，一行都不删", () => {
    const r = pruneGraphOrphans({ dryRun: true });
    expect(r).toMatchObject({ orphans: 1, edges: 2, prunedNodes: 0, prunedEdges: 0 });
    expect(db.select().from(schema.knowledgeNodes).all()).toHaveLength(5);
    expect(db.select().from(schema.knowledgeEdges).all()).toHaveLength(3);
  });

  it("真删：删掉孤儿节点及其牵连边，存活节点/健康边/非 document 节点一律不动", () => {
    const r = pruneGraphOrphans();
    expect(r).toMatchObject({ orphans: 1, edges: 2, prunedNodes: 1, prunedEdges: 2 });
    const nodes = db.select().from(schema.knowledgeNodes).all().map((n) => n.id).sort();
    expect(nodes).toEqual([100, 300, 400, 500]);
    const edges = db.select().from(schema.knowledgeEdges).all().map((e) => e.id);
    expect(edges).toEqual([1000]);
  });

  it("幂等：再清一次没有可清的了", () => {
    expect(pruneGraphOrphans()).toMatchObject({ orphans: 0, edges: 0, prunedNodes: 0, prunedEdges: 0 });
  });

  it("`documentId` 为空的 document 节点不算孤儿（与巡检口径一致，避免误删）", () => {
    const ids = db.select().from(schema.knowledgeNodes).all().map((n) => n.id);
    expect(ids).toContain(500);
  });
});
