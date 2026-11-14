import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // env.ts 对必填变量存在性校验，缺了就 process.exit(1)（本仓既有测试同法补）
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import { insertEdge, EdgeEvidenceError } from "./edge-writer";

/**
 * T4-01 统一写边出口的规矩（PLAN：宁可少边，不要无据之边）：
 *  - evidence.text 空白/缺省 → 拒写并抛明确错误（不静默降级）；
 *  - 落库三列俱全：evidence（截断 500）+ evidenceDocumentId + evidenceChunkId；
 *  - chunkId 不给时按 documentId 取该文档 chunkIndex=0 自动补（诚实补位非造假——
 *    补的是真存在的 chunk 主键）；两者都拿不到 → 拒；
 *  - executor 可传 tx（auto-link 同步事务用）。
 */

function createDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE knowledge_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, type TEXT, metadata TEXT);
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId INTEGER NOT NULL, targetId INTEGER NOT NULL,
      label TEXT, type TEXT NOT NULL DEFAULT 'related', weight REAL DEFAULT 1,
      createdBy INTEGER, createdAt INTEGER NOT NULL DEFAULT 0,
      evidence TEXT, evidenceDocumentId INTEGER, evidenceChunkId INTEGER
    );
    CREATE TABLE kb_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT);
    CREATE TABLE document_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, documentId INTEGER, chunkIndex INTEGER, content TEXT, charStart INTEGER, charEnd INTEGER, pageStart INTEGER, pageEnd INTEGER, sectionPath TEXT, contentHash TEXT);
  `);
  sqlite
    .prepare("INSERT INTO knowledge_nodes (id, title, content, type, metadata) VALUES (?,?,?,?,?)")
    .run(1, "源节点", "源内容首句。后面还有内容。", "document", JSON.stringify({ documentId: "77" }));
  sqlite.prepare("INSERT INTO knowledge_nodes (id, title, type) VALUES (?,?,?)").run(2, "目标节点", "concept");
  sqlite.prepare("INSERT INTO kb_documents (id, title, content) VALUES (?,?,?)").run(77, "证据文档", "第一段正文。第二段正文。");
  sqlite
    .prepare("INSERT INTO document_chunks (id, documentId, chunkIndex, content) VALUES (?,?,?,?)")
    .run(500, 77, 0, "第一段正文。第二段正文。");
  sqlite
    .prepare("INSERT INTO document_chunks (id, documentId, chunkIndex, content) VALUES (?,?,?,?)")
    .run(501, 77, 1, "第三段。");
  return drizzle(sqlite, { schema });
}

let db: ReturnType<typeof createDb>;
let raw: Database.Database;
beforeEach(() => {
  db = createDb();
  raw = (db as unknown as { $client: Database.Database }).$client;
});

describe("edge-writer.insertEdge（唯一写边出口）", () => {
  it("无 evidence → 拒写：抛 EdgeEvidenceError 且库里一行都没多", async () => {
    await expect(insertEdge({ sourceId: 1, targetId: 2, type: "references" }, db)).rejects.toBeInstanceOf(EdgeEvidenceError);
    expect(raw.prepare("SELECT COUNT(*) c FROM knowledge_edges").get()).toEqual({ c: 0 });
  });

  it("evidence.text 纯空白同样拒写（trim 后为空=无据）", async () => {
    await expect(
      insertEdge({ sourceId: 1, targetId: 2, type: "contains", evidence: { text: "   " } }, db),
    ).rejects.toBeInstanceOf(EdgeEvidenceError);
  });

  it("三列俱全：显式 text+documentId+chunkId 原样落库", async () => {
    const { id } = await insertEdge(
      { sourceId: 1, targetId: 2, type: "references", evidence: { text: "引用依据：第二段", documentId: 77, chunkId: 501 } },
      db,
    );
    const row = raw.prepare("SELECT * FROM knowledge_edges WHERE id=?").get(id) as Record<string, unknown>;
    expect(row.evidence).toBe("引用依据：第二段");
    expect(row.evidenceDocumentId).toBe(77);
    expect(row.evidenceChunkId).toBe(501);
  });

  it("只给 text 不给位置 → 从 source 节点的 metadata.documentId 反查并自动补 chunk0（补位是真行，非编造）", async () => {
    const { id } = await insertEdge({ sourceId: 1, targetId: 2, type: "sequence", evidence: { text: "顺序依据" } }, db);
    const row = raw.prepare("SELECT * FROM knowledge_edges WHERE id=?").get(id) as Record<string, unknown>;
    expect(row.evidenceDocumentId).toBe(77);
    expect(row.evidenceChunkId).toBe(500); // chunkIndex=0 的主键
  });

  it("source 无文档、target 也无从反查 → 连 documentId 都补不出时仍必须写入吗？——不：无 text 才拒；有 text 无位置允许落库（位置列 NULL，巡检 edges_without_evidence 只看 evidence 列）", async () => {
    const raw2 = (db as unknown as { $client: Database.Database }).$client;
    raw2.prepare("INSERT INTO knowledge_nodes (id, title, type) VALUES (?,?,?)").run(3, "孤立节点", "concept");
    const { id } = await insertEdge({ sourceId: 2, targetId: 3, type: "related", evidence: { text: "相关：共同主题" } }, db);
    const row = raw.prepare("SELECT * FROM knowledge_edges WHERE id=?").get(id) as Record<string, unknown>;
    expect(row.evidence).toBe("相关：共同主题");
    expect(row.evidenceDocumentId).toBeNull();
    expect(row.evidenceChunkId).toBeNull();
  });

  it("evidence 超 500 字 → 截断存 500（摘录而非全文，防库膨胀）", async () => {
    const long = "证".repeat(600);
    const { id } = await insertEdge({ sourceId: 1, targetId: 2, type: "references", evidence: { text: long } }, db);
    const row = raw.prepare("SELECT evidence FROM knowledge_edges WHERE id=?").get(id) as { evidence: string };
    expect(row.evidence).toHaveLength(500);
  });

  it("executor 可传 tx（同步事务形态，auto-link 用）：给 db 形态 executor 也能跑", async () => {
    const { id } = await insertEdge({ sourceId: 1, targetId: 2, type: "extends", evidence: { text: "扩展自源节点首句" } }, db);
    expect(id).toBeGreaterThan(0);
  });

  it("label/weight/createdBy 原样透传，不被 evidence 逻辑吞掉", async () => {
    const { id } = await insertEdge(
      { sourceId: 1, targetId: 2, type: "references", label: "引用", weight: 0.8, createdBy: 3, evidence: { text: "依据" } },
      db,
    );
    const row = raw.prepare("SELECT * FROM knowledge_edges WHERE id=?").get(id) as Record<string, unknown>;
    expect([row.label, row.weight, row.createdBy]).toEqual(["引用", 0.8, 3]);
  });
});
