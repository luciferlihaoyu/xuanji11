import { describe, expect, it, vi, beforeEach } from "vitest";
import type { KbDocument } from "@db/schema";
import { getDb } from "../queries/connection";
import { vectorEngine } from "./vector";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./vector", () => ({
  vectorEngine: {
    indexDocumentChunks: vi.fn(),
    deleteByDocumentId: vi.fn(),
    insertBatch: vi.fn(async () => {}),
    size: 0,
  },
}));

// 模拟 embed：每个文本返回固定维度向量
vi.mock("./vector-service", () => ({
  embedTextsWithFallback: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  ensureCorrectDimension: vi.fn(async () => {}),
}));

import { chunkText, indexDocumentById, tryIndexDocumentById, startReindexAll, getReindexProgress } from "./document-indexer";

function fakeDocument(overrides: Partial<KbDocument> = {}): KbDocument {
  return {
    id: 1,
    folderId: null,
    title: "测试文档",
    content: "第一段内容。第二段内容。",
    format: "markdown",
    tags: null,
    metadata: null,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    deletedReason: null,
    mergedIntoId: null,
    ...overrides,
  };
}

function createFakeDb(docs: readonly KbDocument[]) {
  const inserted: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([...docs])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((rows: unknown) => {
        inserted.push(rows);
        return Promise.resolve([{ insertId: 1 }]);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  };
  return { db, inserted };
}

describe("chunkText", () => {
  it("returns empty array for empty text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("returns single chunk for short text", () => {
    expect(chunkText("你好，世界")).toEqual(["你好，世界"]);
  });

  it("splits long text into overlapping chunks", () => {
    const long = "甲".repeat(500) + "。" + "乙".repeat(500) + "。" + "丙".repeat(500);
    const chunks = chunkText(long, 800, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(800);
    }
    // 相邻分块应有重叠内容
    expect(chunks[1].startsWith(chunks[0].slice(-100).slice(0, 10))).toBe(true);
  });

  // ==== 回归：尾块退化 bug（原第 32 行 start += Math.max(slice.length - overlap, 1)）====
  // 机理：文档尾部剩余长度 ≤ overlap 时 slice.length - overlap ≤ 0，Math.max 兜底成 1，
  // 游标每轮只前进 1 字符，把尾部每一个后缀都当独立 chunk 吐出（100→99→…→1 字符）。
  // 生产事故：doc 6130（9397 字符）被切成 106 块 = 6 正常块 + 100 个递减垃圾块；
  // 全库 93.5%（209,205 块）不足 100 字符、含单字块；向量库灌水导致 hybrid 检索贴 50s 超时。
  it("生产复现：9397 字符长文应切 14 块，不得出现递减碎片与单字块", () => {
    const text = "x".repeat(9397); // 无句边界，隔离尾块退化路径（不受断行修剪干扰）
    const chunks = chunkText(text, 800, 100);
    expect(chunks.length).toBe(14); // 设计期望 ceil((9397-800)/(800-100)) + 1 = 14
    expect(Math.min(...chunks.map((c) => c.length))).toBeGreaterThan(1); // 禁止单字块
    expect(chunks.some((c, i) => i > 0 && c === chunks[i - 1].slice(1))).toBe(false); // 禁止「右移一位」退化指纹
  });

  it("小尾块（≤ maxChars）只输出一次后立即终止，不再递减", () => {
    const text = "z".repeat(2950); // 4 个满块 + 150 字符尾块
    const chunks = chunkText(text, 800, 100);
    expect(chunks.map((c) => c.length)).toEqual([800, 800, 800, 800, 150]); // 修复前：尾块 150 后继续吐 100,99,…,1 共 100+ 块
  });

  it("尾块修复不丢内容：相邻重叠恰为 overlap，且拼接可重建全文", () => {
    const text = "x".repeat(2950);
    const chunks = chunkText(text, 800, 100);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].slice(0, 100)).toBe(chunks[i - 1].slice(-100)); // overlap 语义保持
    }
    let rebuilt = chunks[0];
    for (let i = 1; i < chunks.length; i++) rebuilt += chunks[i].slice(100);
    expect(rebuilt).toBe(text); // 一个字符都不丢
  });

  it("参数化：不同 maxChars/overlap 组合同样不尾块退化（非硬编码 800/100）", () => {
    const c1 = chunkText("a".repeat(780), 300, 50); // 修复前：3 块后尾块退化 50 个（50,49,…,1），共 53 块
    expect(c1.map((c) => c.length)).toEqual([300, 300, 280]);
    const c2 = chunkText("b".repeat(630), 200, 20); // 修复前：4 块后尾块退化 20 个，共 25 块
    expect(c2.map((c) => c.length)).toEqual([200, 200, 200, 90]);
    expect(c1.every((c) => c.length > 1)).toBe(true);
    expect(c2.every((c) => c.length > 1)).toBe(true);
  });

  it("正常路径保持：含句边界长文仍产出 ≤maxChars 的块、块数符合设计期望、无碎块", () => {
    const doc = ("段落".repeat(300) + "。\n").repeat(10); // 6020 字符，触发断行修剪路径
    const chunks = chunkText(doc, 800, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(11); // 设计期望约 ceil((6020-800)/700)+1=9，修剪使步长变短容差 +2；修复前此处会追加 100 个递减碎块
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(800);
      expect(chunk.length).toBeGreaterThan(10); // 修复后不得出现 1~9 字符碎块（修复前存在）
    }
  });
});

describe("indexDocumentById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when the document does not exist", async () => {
    const { db } = createFakeDb([]);
    vi.mocked(getDb).mockReturnValue(db as never);
    await expect(indexDocumentById(999)).rejects.toThrow("文档不存在");
  });

  it("cleans up vectors and skips when content is empty", async () => {
    const { db } = createFakeDb([fakeDocument({ content: "  " })]);
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await indexDocumentById(1);

    expect(result).toEqual({ chunks: 0, skipped: true });
    expect(vectorEngine.deleteByDocumentId).toHaveBeenCalledWith(1);
    expect(vectorEngine.insertBatch).not.toHaveBeenCalled();
  });

  it("chunks content, stores chunks and indexes into the vector engine", async () => {
    const doc = fakeDocument({ id: 7, content: "第一段内容。第二段内容。" });
    const { db, inserted } = createFakeDb([doc]);
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await indexDocumentById(7);

    expect(result).toEqual({ chunks: 1, skipped: false });
    expect(db.delete).toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual([
      { documentId: 7, content: "第一段内容。第二段内容。", chunkIndex: 0 },
    ]);
    // 新实现：embed 后真正写入 vec 表（insertBatch），不再调空壳 indexDocumentChunks
    expect(vectorEngine.insertBatch).toHaveBeenCalledTimes(1);
    const [entries] = vi.mocked(vectorEngine.insertBatch).mock.calls[0] as unknown as [
      Array<{ id: string; vector: number[]; metadata: Record<string, unknown> }>,
    ];
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("chunk-7-0");
    expect(entries[0].vector).toEqual([0.1, 0.2, 0.3]);
    expect(entries[0].metadata.documentId).toBe("7");
    expect(db.update).toHaveBeenCalled();
  });
});

describe("tryIndexDocumentById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("swallows indexing errors and reports skip", async () => {
    const { db } = createFakeDb([]);
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await tryIndexDocumentById(999);

    expect(result).toEqual({ chunks: 0, skipped: true });
  });
});

describe("startReindexAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("indexes every document with content and tracks progress", async () => {
    const docs = [
      fakeDocument({ id: 1, content: "文档一内容。" }),
      fakeDocument({ id: 2, content: "文档二内容。" }),
    ];
    const { db } = createFakeDb(docs);
    vi.mocked(getDb).mockReturnValue(db as never);

    const initial = startReindexAll();
    expect(initial.running).toBe(true);

    // 幂等：运行中再次调用直接返回当前进度，不启动第二个任务
    const again = startReindexAll();
    expect(again.running).toBe(true);

    // 等待后台任务完成（每篇 100ms 间隔 + 两篇文档）
    const deadline = Date.now() + 10_000;
    while (getReindexProgress().running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const final = getReindexProgress();
    expect(final.running).toBe(false);
    expect(final.total).toBe(2);
    expect(final.done).toBe(2);
    expect(final.failed).toBe(0);
    expect(final.chunksTotal).toBe(2);
    expect(final.finishedAt).toBeDefined();
    expect(vectorEngine.insertBatch).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("counts failures without aborting the whole run", async () => {
    const docs = [
      fakeDocument({ id: 1, content: "正常文档。" }),
      fakeDocument({ id: 2, content: "触发失败的文档。" }),
    ];
    const { db } = createFakeDb(docs);
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(vectorEngine.insertBatch)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("embedding API down"));

    startReindexAll();
    const deadline = Date.now() + 10_000;
    while (getReindexProgress().running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const final = getReindexProgress();
    expect(final.done).toBe(2);
    expect(final.failed).toBe(1);
    expect(final.chunksTotal).toBe(1);
    expect(final.lastError).toContain("embedding API down");
  }, 15_000);
});
