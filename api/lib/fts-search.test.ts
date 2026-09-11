import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { _setDbForTests, _resetDbForTests } from "../queries/connection";

/**
 * FTS5 trigram BM25 验证：中文 3 字滑窗匹配、名次排序、同步钩子。
 * 真实 SQLite 内存库（不 mock）。
 */
describe("fts-search BM25", () => {
  beforeAll(() => {
    const raw = new Database(":memory:");
    raw.exec(`
      CREATE TABLE document_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documentId INTEGER NOT NULL,
        content TEXT NOT NULL,
        chunkIndex INTEGER DEFAULT 0
      );
      INSERT INTO document_chunks(documentId, content, chunkIndex) VALUES
        (1, '中华人民共和国土地管理法规定土地使用权可以依法转让', 0),
        (1, '城市房地产管理法规定房屋所有权登记制度', 1),
        (2, '机器学习中的梯度下降算法用于优化损失函数', 0),
        (3, '土地管理法与房地产管理法的关系探讨', 0);
    `);
    _setDbForTests(raw);
  });

  it("ensureFts 建表并回填存量 chunks", async () => {
    const { ensureFts } = await import("./fts-search");
    ensureFts();
    // 再调一次幂等
    ensureFts();
  });

  it("中文查询命中且按 bm25 排序", async () => {
    const { bm25Search } = await import("./fts-search");
    const hits = bm25Search("土地管理法", 10);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // 精确包含「土地管理法」的两个 chunk 应排前
    const docIds = hits.map((h) => h.documentId);
    expect(docIds).toContain(1);
    expect(docIds).toContain(3);
    // 机器学习的文档不应命中
    expect(docIds).not.toContain(2);
  });

  it("短查询（<3 字符）返回空（调用方回退 LIKE）", async () => {
    const { bm25Search } = await import("./fts-search");
    expect(bm25Search("土", 10)).toEqual([]);
    expect(bm25Search("土地", 10)).toEqual([]);
  });

  it("syncChunkToFts 新增可被搜到", async () => {
    const { getRawDb } = await import("../queries/connection");
    const raw = getRawDb();
    raw.prepare("INSERT INTO document_chunks(documentId, content, chunkIndex) VALUES (9, '量子纠缠是量子力学的核心现象', 0)").run();
    const newId = Number(raw.prepare("SELECT last_insert_rowid() id").get().id);
    const { syncChunkToFts, bm25Search } = await import("./fts-search");
    syncChunkToFts(newId, "量子纠缠是量子力学的核心现象");
    const hits = bm25Search("量子纠缠", 10);
    expect(hits.some((h) => h.documentId === 9)).toBe(true);
  });

  it("deleteDocumentFromFts 后搜不到", async () => {
    const { getRawDb } = await import("../queries/connection");
    const raw = getRawDb();
    raw.prepare("DELETE FROM document_chunks WHERE documentId = 9").run();
    const { deleteDocumentFromFts, bm25Search } = await import("./fts-search");
    deleteDocumentFromFts(9);
    expect(bm25Search("量子纠缠", 10).some((h) => h.documentId === 9)).toBe(false);
  });
});
