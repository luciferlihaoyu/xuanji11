import { describe, it, expect, beforeAll, vi } from "vitest";

// 本文件用真实 SQLite（不 mock connection），而 connection 导入期会经 env.ts 强校验环境变量：
// 缺失即 process.exit(1)，整个测试文件会静默变成「无法运行」→ 零保护。故在导入前注入占位值。
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "file::memory:";
  process.env.ADMIN_USERNAME ||= "test";
  process.env.ADMIN_PASSWORD ||= "test-password";
});

import Database from "better-sqlite3";
import { _setDbForTests, _resetDbForTests } from "../queries/connection";

/**
 * FTS5 trigram BM25 验证：中文 3 字滑窗匹配、名次排序、同步钩子。
 * 真实 SQLite 内存库（不 mock）。
 */
let rawDb: Database.Database | null = null;
function _rawDb(): Database.Database {
  if (!rawDb) throw new Error("测试库未初始化");
  return rawDb;
}

describe("fts-search BM25", () => {
  beforeAll(() => {
    const raw = new Database(":memory:");
    rawDb = raw;
    raw.exec(`
      CREATE TABLE document_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documentId INTEGER NOT NULL,
        content TEXT NOT NULL,
        chunkIndex INTEGER DEFAULT 0,
      
      charStart INTEGER,
      charEnd INTEGER,
      pageStart INTEGER,
      pageEnd INTEGER,
      sectionPath TEXT,
      contentHash TEXT
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

  it("FTS 孤儿（指向已删 chunk）会被清理；dryRun 只报数不删", async () => {
    const { ensureFts, pruneFtsOrphans } = await import("./fts-search");
    ensureFts();
    const raw = _rawDb();
    // 造两条孤儿：rowid 在 document_chunks 里不存在
    raw.exec(`INSERT INTO chunks_fts(rowid, content) VALUES (9001, '已被删除的历史分块'), (9002, '另一个孤儿')`);
    const before = (raw.prepare(`SELECT COUNT(*) c FROM chunks_fts`).get() as { c: number }).c;

    const dry = pruneFtsOrphans({ dryRun: true });
    expect(dry.orphans).toBe(2);
    expect(dry.pruned).toBe(0);
    expect((raw.prepare(`SELECT COUNT(*) c FROM chunks_fts`).get() as { c: number }).c).toBe(before);

    const real = pruneFtsOrphans();
    expect(real.orphans).toBe(2);
    expect(real.pruned).toBe(2);
    const after = (raw.prepare(`SELECT COUNT(*) c FROM chunks_fts`).get() as { c: number }).c;
    expect(after).toBe(before - 2);
    // 幂等：再清一次没有可清的了
    expect(pruneFtsOrphans().pruned).toBe(0);
  });

  it("孤儿把 ftsCount 抬到高于 chunkCount 时，ensureFts 仍要补齐缺失 chunk（原判据会被孤儿骗过）", async () => {
    const raw = _rawDb();
    raw.exec(`DELETE FROM chunks_fts`);
    // 只回填一半 chunk，再塞大量孤儿，使 ftsCount > chunkCount
    raw.exec(`INSERT INTO chunks_fts(rowid, content) SELECT id, content FROM document_chunks WHERE id <= 2`);
    raw.exec(`INSERT INTO chunks_fts(rowid, content) SELECT 5000 + value, '孤儿' || value FROM (WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 20) SELECT value FROM seq)`);
    expect((raw.prepare(`SELECT COUNT(*) c FROM chunks_fts`).get() as { c: number }).c)
      .toBeGreaterThan((raw.prepare(`SELECT COUNT(*) c FROM document_chunks`).get() as { c: number }).c);

    const { _resetFtsReadyForTests, ensureFts } = await import("./fts-search");
    _resetFtsReadyForTests();
    ensureFts();
    const missing = (raw.prepare(
      `SELECT COUNT(*) c FROM document_chunks c WHERE NOT EXISTS (SELECT 1 FROM chunks_fts f WHERE f.rowid = c.id)`
    ).get() as { c: number }).c;
    expect(missing).toBe(0);

    // 还原共享测试库状态（本用例改了 chunks_fts，后续检索用例依赖原始 4 行）
    const { pruneFtsOrphans } = await import("./fts-search");
    pruneFtsOrphans();
    _resetFtsReadyForTests();
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
    const newId = Number((raw.prepare("SELECT last_insert_rowid() id").get() as { id: number }).id);
    const { syncChunkToFts, bm25Search } = await import("./fts-search");
    syncChunkToFts(newId, "量子纠缠是量子力学的核心现象");
    const hits = bm25Search("量子纠缠", 10);
    expect(hits.some((h) => h.documentId === 9)).toBe(true);
  });

  it("syncChunkToFts 在模块未初始化时也必须真写进去（生产事故复现：报成功但 FTS 没落库）", async () => {
    // 复现 2026-11-12 生产验收发现的形状：进程刚起、ftsReady=false 时，
    // 旧实现 `if (!ftsReady) return;` 会**静默跳过**写入 —— 文档入库那刻
    // chunks_fts 里没有这一行，而调用方已经把 vectorized 置 true、对外报"索引成功"，
    // 关键词腿要等下一次检索触发 ensureFts() 回填才补上（实测 FTS 命中 0/1 → 检索后 1/1）。
    const { getRawDb } = await import("../queries/connection");
    const raw = getRawDb();
    raw.prepare("INSERT INTO document_chunks(documentId, content, chunkIndex) VALUES (77, '灵犀渡海处 潮声入耳时', 0)").run();
    const newId = Number((raw.prepare("SELECT last_insert_rowid() id").get() as { id: number }).id);

    // 关键：把模块拉回"未初始化"状态 —— 这正是刚启动的进程的样子
    const { _resetFtsReadyForTests, syncChunkToFts } = await import("./fts-search");
    _resetFtsReadyForTests();

    syncChunkToFts(newId, "灵犀渡海处 潮声入耳时");

    // 断言**落库**（不是"能被搜到"——能被搜到会被后续 ensureFts 回填掩盖）：
    // 写入后立刻查 FTS 表，该行必须在。
    const row = raw.prepare("SELECT COUNT(*) c FROM chunks_fts WHERE rowid = ?").get(newId) as { c: number };
    expect(row.c).toBe(1);
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
