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
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
    
      evidence TEXT,
      evidenceDocumentId INTEGER,
      evidenceChunkId INTEGER
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

// ============ T4-03 图谱一致性巡检（只报不修） ============
import { auditGraphIntegrity } from "./graph-maintenance";

function createAuditDb(withSettings = false) {
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
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      evidence TEXT, evidenceDocumentId INTEGER, evidenceChunkId INTEGER
    );
    INSERT INTO kb_documents(id, title, createdAt) VALUES (10, '真实文档', 0);
    INSERT INTO knowledge_nodes(id, title, type) VALUES (100, '甲', 'document'), (200, '乙', 'concept'), (300, '丙', 'tag');
  `);
  if (withSettings) {
    sqlite.exec("CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL DEFAULT 0);");
  }
  return sqlite;
}

function seedEdges(sqlite: Database.Database, rows: Array<[number, number, number, string, number, string | null]>) {
  const st = sqlite.prepare("INSERT INTO knowledge_edges (id, sourceId, targetId, type, createdAt, evidence) VALUES (?,?,?,?,?,?)");
  for (const [id, s, t, type, createdAt, evidence] of rows) st.run(id, s, t, type, createdAt ?? 0, evidence);
}

describe("auditGraphIntegrity（T4-03 五类只读判据）", () => {
  it("干净图 → healthy:true，五类全零", () => {
    const sqlite = createAuditDb();
    seedEdges(sqlite, [[1, 100, 200, "references", 0, "有据"]]);
    _setDbForTests(sqlite as never);
    const r = auditGraphIntegrity();
    expect(r.healthy).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("self_loop：source=target 的边被点名", () => {
    const sqlite = createAuditDb();
    seedEdges(sqlite, [[1, 100, 100, "related", 0, "x"], [2, 100, 200, "related", 0, "y"]]);
    _setDbForTests(sqlite as never);
    const r = auditGraphIntegrity();
    const hit = r.issues.find((i) => i.kind === "self_loop");
    expect(hit?.count).toBe(1);
    expect(hit?.detail).toContain("1");
  });

  it("duplicate_edge：同 source/target/type 多行 → 计冗余行数", () => {
    const sqlite = createAuditDb();
    seedEdges(sqlite, [
      [1, 100, 200, "references", 0, "a"],
      [2, 100, 200, "references", 0, "b"],
      [3, 100, 200, "references", 0, "c"],
      [4, 200, 100, "references", 0, "d"],
    ]);
    _setDbForTests(sqlite as never);
    const hit = auditGraphIntegrity().issues.find((i) => i.kind === "duplicate_edge");
    expect(hit?.count).toBe(2); // 三行组冗余2，第四行反向不算
  });

  it("dangling_edge：端点节点不存在（且不属文档 id 空间）→ 归 dangling 不归 namespace", () => {
    const sqlite = createAuditDb();
    seedEdges(sqlite, [[1, 100, 999999, "related", 0, "x"]]);
    _setDbForTests(sqlite as never);
    const r = auditGraphIntegrity();
    expect(r.issues.find((i) => i.kind === "dangling_edge")?.count).toBe(1);
    expect(r.issues.find((i) => i.kind === "namespace_mismatch")).toBeUndefined();
  });

  it("namespace_mismatch：sourceId 落在 kb_documents id 空间而非 nodes（CA-234 历史 bug 形状）", () => {
    const sqlite = createAuditDb();
    seedEdges(sqlite, [[1, 10, 200, "contains", 0, "x"]]); // 10=文档 id，不是节点 id
    _setDbForTests(sqlite as never);
    const r = auditGraphIntegrity();
    expect(r.issues.find((i) => i.kind === "namespace_mismatch")?.count).toBe(1);
    // 同一条不该再被计成 dangling（分类互斥）
    expect(r.issues.find((i) => i.kind === "dangling_edge")).toBeUndefined();
  });

  it("edges_without_evidence：无 cutoff 时静默（存量不追溯 R7）；有 cutoff 只数新边", () => {
    const sqlite = createAuditDb(true);
    seedEdges(sqlite, [
      [1, 100, 200, "references", 5000, null],
      [2, 200, 300, "references", 5000, "旧有据"],
      [3, 100, 300, "references", 5000, null],
    ]);
    _setDbForTests(sqlite as never);
    expect(auditGraphIntegrity().issues.find((i) => i.kind === "edges_without_evidence")).toBeUndefined();
    sqlite.prepare("INSERT INTO system_settings (key, value, updatedAt) VALUES (?,?,?)").run("edge_evidence_cutoff_ms", "1000", 0);
    const r = auditGraphIntegrity();
    expect(r.issues.find((i) => i.kind === "edges_without_evidence")?.count).toBe(2);
    // 全旧 → 零
    sqlite.prepare("UPDATE system_settings SET value=? WHERE key=?").run("9999", "edge_evidence_cutoff_ms");
    expect(auditGraphIntegrity().issues.find((i) => i.kind === "edges_without_evidence")).toBeUndefined();
  });

  it("related/similar 类型不在证据必填四类：cutoff 后无据也不点名", () => {
    const sqlite = createAuditDb(true);
    sqlite.prepare("INSERT INTO system_settings (key, value, updatedAt) VALUES (?,?,?)").run("edge_evidence_cutoff_ms", "0", 0);
    seedEdges(sqlite, [[1, 100, 200, "related", 5000, null], [2, 100, 300, "similar", 5000, null]]);
    _setDbForTests(sqlite as never);
    expect(auditGraphIntegrity().issues.find((i) => i.kind === "edges_without_evidence")).toBeUndefined();
  });

  it("无 system_settings 表（lite 库）→ 不因缺表崩溃，其余判据照常", () => {
    const sqlite = createAuditDb(false);
    seedEdges(sqlite, [[1, 100, 100, "related", 0, "x"]]);
    _setDbForTests(sqlite as never);
    const r = auditGraphIntegrity();
    expect(r.issues.find((i) => i.kind === "self_loop")?.count).toBe(1);
  });
});
