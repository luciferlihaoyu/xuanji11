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
