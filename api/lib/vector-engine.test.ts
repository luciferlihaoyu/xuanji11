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
