import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * P2 FTS 孤儿根治（碧霄 2026-11-14，AGENTS.md「reindexDocument 每篇残留 0.8 条」待派单根治）：
 * clearDocumentIndex 旧形——deleteDocumentFromFts 失败只 console.warn 吞掉，chunks 照删不误，
 * FTS 行就成永久孤儿（回填只补缺行不清孤儿，fts-search.ts:43 注释自证）。
 * 根治：删 FTS（按 id 直删）与删 chunks 进同一个事务——要么都成，要么都不动，失败大声抛。
 * 本文件用真实 SQLite（原子性必须真引擎验证）；vector/vector-service 是边界，mock。
 */
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "file::memory:";
  process.env.ADMIN_USERNAME ||= "test";
  process.env.ADMIN_PASSWORD ||= "test-password";
  process.env.JWT_SECRET ||= "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./vector", () => ({
  vectorEngine: {
    deleteByDocumentId: vi.fn(async () => 0),
    insertBatch: vi.fn(async () => {}),
    size: 0,
  },
}));
vi.mock("./vector-service", () => ({
  embedTextsWithOutcome: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [0.1, 0.2, 0.3]),
    identity: { model: "test-embedding-model", dimension: 3 },
    degraded: false,
  })),
  ensureCorrectDimension: vi.fn(async () => {}),
  getLastEmbeddingIdentity: vi.fn(() => null),
  HASH_FALLBACK_MODEL: "__hash_fallback__",
}));

import Database from "better-sqlite3";
import { _setDbForTests, _resetDbForTests } from "../queries/connection";
import * as schema from "@db/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";

function freshDb() {
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderId INTEGER, title TEXT NOT NULL DEFAULT 't', content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown', tags TEXT, metadata TEXT,
      createdBy INTEGER, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER, deletedReason TEXT, mergedIntoId INTEGER
    );
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documentId INTEGER NOT NULL, itemId INTEGER,
      content TEXT NOT NULL, chunkIndex INTEGER NOT NULL DEFAULT 0,
      embedding TEXT, embeddingModel TEXT, metadata TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0,
      charStart INTEGER, charEnd INTEGER, pageStart INTEGER, pageEnd INTEGER,
      sectionPath TEXT, contentHash TEXT
    );
    CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER);
  `);
  return { raw, db: drizzle(raw, { schema }) };
}

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const LONG = "土地管理法与房地产管理法的交叉讨论：土地使用权可以依法转让，城市房地产登记实行属地原则。".repeat(60);

function seedDoc(content: string): number {
  const res = db.insert(schema.kbDocuments)
    .values({ title: "测试", content, createdAt: new Date(0), updatedAt: new Date(0) })
    .run() as unknown as { lastInsertRowid: number | bigint };
  return Number(res.lastInsertRowid);
}

beforeEach(async () => {
  vi.clearAllMocks();
  const made = freshDb();
  raw = made.raw;
  db = made.db;
  _setDbForTests(raw);
  const fts = await import("./fts-search");
  fts._resetFtsReadyForTests?.();
});

describe("② clearDocumentIndex 原子化：FTS 失败必须连 chunks 一起回滚", () => {
  it("FTS 删除炸了 → indexDocumentById 抛错，旧 chunks 原封不动（不产孤儿）", async () => {
    const { indexDocumentById } = await import("./document-indexer");
    const docId = seedDoc(LONG);
    await indexDocumentById(docId); // 先健康索引一次
    const chunkCountBefore = raw.prepare("SELECT COUNT(*) c FROM document_chunks WHERE documentId = ?").get(docId) as { c: number };
    expect(chunkCountBefore.c).toBeGreaterThan(1);

    // 注入边界故障：fts 表名换成不可写的视图，DELETE 必炸（模拟生产并发 BUSY 之类真故障）
    raw.exec("DROP TABLE chunks_fts; CREATE VIEW chunks_fts AS SELECT 1 AS x;");
    const fts = await import("./fts-search");
    fts._resetFtsReadyForTests();
    const { vectorEngine } = await import("./vector");
    vi.mocked(vectorEngine.deleteByDocumentId).mockClear();

    await expect(indexDocumentById(docId)).rejects.toThrow();

    const after = raw.prepare("SELECT COUNT(*) c FROM document_chunks WHERE documentId = ?").get(docId) as { c: number };
    expect(after.c).toBe(chunkCountBefore.c); // 现行代码：warn 吞掉 → chunks 被删 → 旧 FTS 行变永久孤儿
    expect(vectorEngine.deleteByDocumentId).not.toHaveBeenCalled(); // 清理整体中止，向量不该被单独撕掉
  });

  it("健康重建后零孤儿（性质锁定）", async () => {
    const { indexDocumentById } = await import("./document-indexer");
    const docId = seedDoc(LONG);
    await indexDocumentById(docId);
    db.update(schema.kbDocuments).set({ content: LONG + "追加一段不同的结尾内容用来改变全部块的哈希。".repeat(20) })
      .where(eq(schema.kbDocuments.id, docId)).run();
    await indexDocumentById(docId);

    const fts = await import("./fts-search");
    const dry = fts.pruneFtsOrphans({ dryRun: true });
    expect(dry.orphans).toBe(0);
    const counts = raw.prepare("SELECT (SELECT COUNT(*) FROM document_chunks) c1, (SELECT COUNT(*) FROM chunks_fts) c2").get() as { c1: number; c2: number };
    expect(counts.c2).toBe(counts.c1);
  });
});

import { eq } from "drizzle-orm";

describe("②b fts-search 提供按 id 直删的导出（事务内可用，不依赖 chunks 表存活）", () => {
  it("deleteChunksFromFtsByIds 存在且空数组无害、不存在 id 无害", async () => {
    const fts = await import("./fts-search");
    expect(typeof (fts as Record<string, unknown>).deleteChunksFromFtsByIds).toBe("function");
    expect(() => fts.deleteChunksFromFtsByIds([])).not.toThrow();
    expect(() => fts.deleteChunksFromFtsByIds([999999])).not.toThrow();
    // 真删：建一个 chunk + fts 行，按 id 删掉
    const res = db.insert(schema.documentChunks).values({ documentId: 77, content: "测试内容一二三", chunkIndex: 0 }).run() as unknown as { lastInsertRowid: number | bigint };
    const chunkId = Number(res.lastInsertRowid);
    fts.syncChunkToFts(chunkId, "测试内容一二三");
    expect(fts.pruneFtsOrphans({ dryRun: true }).orphans).toBe(0);
    fts.deleteChunksFromFtsByIds([chunkId]);
    const left = raw.prepare("SELECT COUNT(*) c FROM chunks_fts WHERE rowid = ?").get(chunkId) as { c: number };
    expect(left.c).toBe(0);
  });
});

afterEach(() => {
  _resetDbForTests();
});
