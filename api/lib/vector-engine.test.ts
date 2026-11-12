/**
 * SqliteVecEngine 单测：覆盖 insert / search / deleteByDocumentId / clear 核心路径。
 * 使用：临时 SQLite 文件 + 加载 sqlite-vec 扩展（vec0）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";

let testDir: string;
let dim = 8;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "vec-test-"));
  const dbFile = join(testDir, "v.db");
  // 模拟 connection.ts 的初始化（这里直接 import 单测用的 raw db）
  process.env.SQLITE_PATH = dbFile;
  process.env.UPLOAD_DIR = testDir;
  process.env.BACKUP_TEMP_DIR = testDir;
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "x".repeat(40);
  process.env.JWT_SECRET = "x".repeat(64);
  process.env.EGRESS_ALLOW_PRIVATE_NET = "true";
});

afterAll(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("SqliteVecEngine", () => {
  it("insert + search 能找到自己", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    engine.clear(); // 测试间隔离
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    await engine.insert("a", vec, { documentId: "1", content: "hello" });
    const hits = await engine.search(vec, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe("a");
    expect(hits[0]!.score).toBeGreaterThan(0.99); // 自身相似度应接近 1
  });

  it("insertBatch + deleteByDocumentId 清理正确", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    engine.clear(); // 测试间隔离
    await engine.insertBatch([
      { id: "c1", vector: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], metadata: { documentId: "2", content: "x" } },
      { id: "c2", vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], metadata: { documentId: "2", content: "y" } },
      { id: "c3", vector: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], metadata: { documentId: "3", content: "z" } },
    ]);
    expect(engine.size).toBe(3);
    const removed = await engine.deleteByDocumentId("2");
    expect(removed).toBe(2);
    expect(engine.size).toBe(1);
  });

  it("clear() 全部清空", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    engine.clear();
    await engine.insert("a", [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], {});
    expect(engine.size).toBe(1);
    engine.clear();
    expect(engine.size).toBe(0);
  });

  it("healthCheck 返回 sqlite-vec 引擎", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    const h = await engine.healthCheck();
    expect(h.engine).toBe("sqlite-vec");
    expect(h.ok).toBe(true);
    expect(h.dimension).toBe(dim);
  });
});

describe("insertBatch 幂等（线上实测：重索引整库全篇 UNIQUE 失败）", () => {
  it("同一个 id 重复插入不报错，且不留下重复/陈旧向量", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    engine.clear();
    const v1 = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
    const v2 = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];

    await engine.insertBatch([{ id: "chunk-9-0", vector: v1, metadata: { documentId: "9", chunkIndex: 0 } }]);
    // 第二次插入同样的 id（重索引场景：文档已索引过）——原来这里抛
    // UNIQUE constraint failed: vec_chunk_meta.id（id 是 UNIQUE，而 ON CONFLICT 只覆盖 rowid）
    await expect(
      engine.insertBatch([{ id: "chunk-9-0", vector: v2, metadata: { documentId: "9", chunkIndex: 0 } }]),
    ).resolves.toBeUndefined();

    expect(await engine.countByDocumentId("9")).toBe(1);
    const hits = await engine.search(v2, 5);
    expect(hits.filter((h) => h.id === "chunk-9-0")).toHaveLength(1);
    // 旧向量必须被替换掉：用 v1 检索不该再命中同一条
    const oldHits = await engine.search(v1, 5);
    expect(oldHits.filter((h) => h.id === "chunk-9-0")).toHaveLength(1);
  });
});

describe("insertBatch 幂等（审查 MEDIUM：原断言用平行向量，判别力为零 → 变异体存活）", () => {
  it("同 id 覆盖写入后，vec 表与 meta 表都只剩 1 行（非平行向量，直接数 vec_chunks）", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    const { getRawDb } = await import("../queries/connection");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    engine.clear();
    // 两两正交的向量：cosine 不同，旧行若残留一定能被检索区分出来
    const v1 = [1, 0, 0, 0, 0, 0, 0, 0];
    const v2 = [0, 1, 0, 0, 0, 0, 0, 0];
    await engine.insertBatch([{ id: "chunk-11-0", vector: v1, metadata: { documentId: "11" } }]);
    await engine.insertBatch([{ id: "chunk-11-0", vector: v2, metadata: { documentId: "11" } }]);

    const raw = getRawDb();
    const vecRows = raw.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    const metaRows = raw.prepare("SELECT COUNT(*) AS n FROM vec_chunk_meta WHERE id = ?").get("chunk-11-0") as { n: number };
    // 只删 meta 不删 vec 的变异体会在这里变红（vec 表 2 行）
    expect(vecRows.n).toBe(1);
    expect(metaRows.n).toBe(1);
    expect(await engine.countByDocumentId("11")).toBe(1);

    // 覆盖后表里只剩新向量：用 v2 查相似度应高于用 v1 查（旧行若残留会拉高 v1 的相似度）
    const hitOld = await engine.search(v1, 3);
    const hitNew = await engine.search(v2, 3);
    expect(hitNew[0]?.id).toBe("chunk-11-0");
    expect(hitNew[0]!.score).toBeGreaterThan(hitOld[0]!.score);
  });

  it("降级引擎（sqlite-vec 不可用时）同样幂等：覆盖写入不累积重复向量", async () => {
    const { MemoryVectorEngine } = await import("./vector-engine");
    const engine = new MemoryVectorEngine(); // 降级引擎按 DIM_DEFAULT 构造（与 SqliteVecEngine 不同）
    const v = [1, 0, 0, 0, 0, 0, 0, 0];
    await engine.insertBatch([{ id: "chunk-12-0", vector: v, metadata: { documentId: "12" } }]);
    await engine.insertBatch([{ id: "chunk-12-0", vector: v, metadata: { documentId: "12" } }]);
    const health = await engine.healthCheck();
    expect(health.size).toBe(1);
    expect(await engine.countByDocumentId("12")).toBe(1);
  });
});

describe("countByDocumentId（供破坏性操作 dryRun 预览真实计数）", () => {
  it("按 documentId 计数，未知 id 为 0，删除后归零", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    engine.clear();
    const v = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
    await engine.insertBatch([
      { id: "d7-1", vector: v, metadata: { documentId: "7" } },
      { id: "d7-2", vector: v, metadata: { documentId: "7" } },
      { id: "d7-3", vector: v, metadata: { documentId: "7" } },
      { id: "d8-1", vector: v, metadata: { documentId: "8" } },
      { id: "d8-2", vector: v, metadata: { documentId: "8" } },
    ]);
    expect(await engine.countByDocumentId("7")).toBe(3);
    expect(await engine.countByDocumentId(8)).toBe(2);
    expect(await engine.countByDocumentId("999")).toBe(0);
    await engine.deleteByDocumentId("7");
    expect(await engine.countByDocumentId("7")).toBe(0);
    expect(await engine.countByDocumentId(8)).toBe(2);
  });
});

/**
 * 评审 S1：维度不匹配必须**抛错**且**一条都不写**。
 *
 * 旧实现在循环里对 `vector.length !== dim` 的条目 `continue` 静默跳过 →
 * 实际写入 0 条向量，而调用方（document-indexer）拿到"没抛错"就把文档标成
 * vectorized:true、显示「索引成功」。这就是「vectorized=true 却零向量」的假成功形状：
 * 用户以为文档已可语义检索，实际向量表里什么都没有，且没有任何异常信号。
 * 现在改为**前置全量校验**：任一条不符就抛错、整批中止。
 */
describe("insertBatch 维度校验（评审 S1：不许静默丢向量）", () => {
  it("维度不符 → 抛错，且向量表/元数据表一条都没写（原有行数不变）", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    const { getRawDb } = await import("../queries/connection");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim); // 本文件基座 dim = 8
    engine.clear();
    // 先放一条"既有"向量，用来证明失败批次既没新增也没破坏既有数据
    await engine.insertBatch([
      { id: "keep-1", vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], metadata: { documentId: "1" } },
    ]);
    const raw = getRawDb();
    const before = raw.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    expect(before.n).toBe(1);

    // 一批两条：一条维度正确、一条少一维（旧实现会静默丢掉那条，只写另一条）
    await expect(
      engine.insertBatch([
        { id: "ok-1", vector: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2], metadata: { documentId: "2" } },
        { id: "bad-1", vector: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3], metadata: { documentId: "2" } },
      ]),
    ).rejects.toThrow(/向量维度不匹配/);

    // ① 整批中止：连那条"维度正确"的也不许写（否则调用方分不清写了几条）
    const after = raw.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    expect(after.n).toBe(1);
    expect(engine.size).toBe(1);
    expect(await engine.countByDocumentId("2")).toBe(0);
    expect(await engine.countByDocumentId("1")).toBe(1);
    const metaBad = raw.prepare("SELECT COUNT(*) AS n FROM vec_chunk_meta WHERE id = ?").get("bad-1") as { n: number };
    const metaOk = raw.prepare("SELECT COUNT(*) AS n FROM vec_chunk_meta WHERE id = ?").get("ok-1") as { n: number };
    expect(metaBad.n).toBe(0);
    expect(metaOk.n).toBe(0);
  });

  it("全是零长度向量的空壳批次同样被拒（0 向量 ≠ 索引成功）", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    const { getRawDb } = await import("../queries/connection");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    engine.clear();
    const raw = getRawDb();

    // 这正是旧实现里"嵌入服务失败 → 返回 [] → 静默 continue → 0 条向量但 vectorized:true"的形状
    await expect(
      engine.insertBatch([
        { id: "empty-0", vector: [], metadata: { documentId: "3" } },
        { id: "empty-1", vector: [], metadata: { documentId: "3" } },
      ]),
    ).rejects.toThrow(/向量维度不匹配/);

    const rows = raw.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    expect(rows.n).toBe(0);
    expect(engine.size).toBe(0);
  });

  it("维度相符 → 正常写入，且行数与元数据一致", async () => {
    const { getVectorEngine, _resetVectorEngineForTests } = await import("./vector-engine");
    const { getRawDb } = await import("../queries/connection");
    _resetVectorEngineForTests();
    const engine = getVectorEngine(dim);
    engine.clear();
    const v = [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4];

    await expect(
      engine.insertBatch([
        { id: "chunk-5-0", vector: v, metadata: { documentId: "5", chunkIndex: 0 } },
        { id: "chunk-5-1", vector: v, metadata: { documentId: "5", chunkIndex: 1 } },
      ]),
    ).resolves.toBeUndefined();

    const raw = getRawDb();
    const vecRows = raw.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    expect(vecRows.n).toBe(2);
    expect(engine.size).toBe(2);
    expect(await engine.countByDocumentId("5")).toBe(2);
    const meta = raw.prepare("SELECT chunkIndex FROM vec_chunk_meta WHERE id = ?").get("chunk-5-1") as { chunkIndex: number };
    expect(meta.chunkIndex).toBe(1);
  });
});
