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
    // 原空壳分块索引方法已删除（2026-11 清理死代码）：它只删旧向量、不 embed、不写 FTS，
    // 正是「入库成功但检索查不到」那次假成功的源头。写向量的唯一路径是 insertBatch。
    deleteByDocumentId: vi.fn(),
    insertBatch: vi.fn(async () => {}),
    size: 0,
  },
}));

// 嵌入服务是**边界**（网络调用 + 模型），按仓库惯例整体 mock。
// 关键变化（评审 B2）：生产 indexer 现在只认 `embedTextsWithOutcome` —— 模型身份随**本次调用**
// 的结果一起返回（{vectors, identity, degraded}），不再去读进程级单例。
// `getLastEmbeddingIdentity` 仍保留桩，但用途反转了：本文件用它证明「索引器的降级判定**不看**它」
// （单例说什么都不影响本次结果，见 A4 的两个方向）。
vi.mock("./vector-service", () => ({
  embedTextsWithOutcome: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [0.1, 0.2, 0.3]),
    identity: { model: "test-embedding-model", dimension: 3 },
    degraded: false,
  })),
  ensureCorrectDimension: vi.fn(async () => {}),
  getLastEmbeddingIdentity: vi.fn((): { model: string; dimension: number } | null => null),
  HASH_FALLBACK_MODEL: "__hash_fallback__",
}));

import { chunkText, indexDocumentById, tryIndexDocumentById, startReindexAll, getReindexProgress } from "./document-indexer";
import { embedTextsWithOutcome, getLastEmbeddingIdentity, HASH_FALLBACK_MODEL } from "./vector-service";

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
  /** 捕获每次 update().set(payload) 的载荷，供断言 metadata 落库内容 */
  const updates: Array<Record<string, unknown>> = [];
  /**
   * 内存行（会随 update 真实变化）——为了钉住 ⑥「mergeDocumentMetadata 读最新行再合并」：
   * 若只是把入口快照整块覆盖，第二次索引就看不到第一次写下的 embeddingDegraded 标记。
   * select 读的是这里，update 写回的也是这里，语义与真库一致（同 dsh 其他内存库 harness）。
   */
  const stored: Array<Record<string, unknown>> = docs.map((doc) => ({ ...doc }));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(stored.map((row) => ({ ...row })))),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
    // insert 桩：补 .returning() 桩，与生产 drizzle better-sqlite3 对齐。
    // 生产代码（document-indexer.ts:92-96）走 `db.insert(t).values(rows).returning({ id, content })`
    // 取回自增主键，供 syncChunkToFts 写 FTS5。旧桩 values() 直接返回 Promise（MySQL 风格的
    // [{ insertId }]），于是 .returning 不是函数 → 3 个用例在未改动源码上就红。
    insert: vi.fn(() => ({
      values: vi.fn((rows: Array<{ content?: string }>) => {
        inserted.push(rows);
        return {
          // 返回 Promise<{id, content}[]>，id 模拟自增主键
          returning: vi.fn((_cols?: unknown) =>
            Promise.resolve(rows.map((row, index) => ({ id: index + 1, content: row.content })))
          ),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        // 真实落库：metadata 的合并结果写回内存行（生产 indexer 传的已是合并后的整块）
        if (payload && typeof payload === "object" && "metadata" in payload) {
          for (const row of stored) row.metadata = payload.metadata;
        }
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  };
  return { db, inserted, updates, stored };
}

describe("chunkText", () => {
  it("returns empty array for empty text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("切点不劈开 UTF-16 代理对：chunk 内不得出现孤立代理或 U+FFFD（T1-01）", () => {
    const LONE =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // "甲"×799（码元 0..798）+ 📊（2 码元：高代理恰在 index 799、低代理在 800）+ "乙"×600
    // 默认 maxChars=800 ⇒ 首刀 slice(0,800) 末尾正是孤立高代理（生产 3 条坏块的成因形状）
    const text = "甲".repeat(799) + "📊" + "乙".repeat(600);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(LONE.test(c)).toBe(false);
      expect(c.includes("\uFFFD")).toBe(false);
    }
    // 完整性：拼回（重叠段只留首现）应覆盖原文全部非空白内容
    const joined = chunks.join("");
    expect(joined).toContain("📊");
  });

  it("overlap 窗口起点劈裂：起点落在 emoji 低代理上时，下一块开头不得是孤立低代理（doc 1995 形状，T1-01）", () => {
    const LONE =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // 复刻 doc 1995 的精确形状：
    // "甲"×691 → 📊 占码元 691-692 → "乙"×98（码元 693..790）→ "\n" 在码元 791
    // 窗口0 [0,800)：lastBreak="\n"@791 ⇒ 截断 [0,792)（emoji 完整在块0 内）
    // start' = 792-100 = 692 = 恰好落在 📊 的低代理上 ⇒ 旧实现块1 开头即孤立低代理
    const text =
      "甲".repeat(691) + "📊" + "乙".repeat(98) + "\n" + "丙".repeat(700);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(LONE.test(c)).toBe(false);
      expect(c.includes("\uFFFD")).toBe(false);
    }
    // emoji 内容不丢失：两处 📊 均完整出现
    expect(chunks.join("")).toContain("📊");
    // 块1 若以丙开头则说明孤立低代理已被切掉、甲乙段落保留在块0
    expect(chunks[0]).toContain("📊");
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
    // 新实现：embed 后真正写入 vec 表（insertBatch），不再调那个空壳分块索引方法
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

  // ==== 事故防线：嵌入服务全挂时必须拒绝写 hash 伪向量 ====
  // 2026-09-21 线上事故：嵌入 API 挂掉 → embedWithFallback 全部失败 → hashFallbackEmbeddings
  // 生成伪向量且不抛错 → 全库回填两分钟写入 550+ 篇 hash 伪向量，检索质量归零而 failed=0
  // 毫无异常信号。本用例锁死新语义：宁可不写向量腿，也不让无语义向量污染 vec 表。
  //
  // 评审 B1（最严重的一处）：守卫位置前移后，降级路径必须在**任何破坏性写之前**返回。
  // 旧实现的顺序是「先 deleteByDocumentId 清旧向量 → 再判定降级 → 抛错」，
  // 于是嵌入服务一挂，重建索引就把旧的真向量删光却不写新的 —— 净损失，比写伪向量更糟。
  it("B1：降级时旧索引产物一条都不动（不删旧向量、不写 chunks），只落降级标记后抛错", async () => {
    // Given: 一篇已经索引过的文档（metadata 里 beta 字段用于验证不整块覆盖）。
    const doc = fakeDocument({ id: 42, content: "第一段内容。第二段内容。" });
    const { db, inserted, updates, stored } = createFakeDb([doc]);
    vi.mocked(getDb).mockReturnValue(db as never);
    // 嵌入服务全挂：本次调用返回 hash 伪向量，身份如实是 __hash_fallback__
    vi.mocked(embedTextsWithOutcome).mockResolvedValueOnce({
      vectors: [[0.5, 0.5, 0.5]],
      identity: { model: HASH_FALLBACK_MODEL, dimension: 1536 },
      degraded: true,
    });

    // When / Then: 抛错让调用方看见（消息必须点名「拒绝写入 hash 伪向量」）
    await expect(indexDocumentById(42)).rejects.toThrow("拒绝写入 hash 伪向量");

    // ① 旧向量必须保住（B1 的核心）：deleteByDocumentId 一次都不许调用
    expect(vectorEngine.deleteByDocumentId).not.toHaveBeenCalled();
    // ② 旧 chunks 也不许被清（clearDocumentIndex 里的 db.delete(documentChunks) 没发生过）
    expect(db.delete).not.toHaveBeenCalled();
    // ③ 没有新 chunks 落库（既不删旧的，也不插新的 → 既有索引原样可用）
    expect(inserted).toHaveLength(0);
    // ④ 向量表零写入
    expect(vectorEngine.insertBatch).not.toHaveBeenCalled();
    // ⑤ 只写一次 metadata：如实标注降级（vectorized:false + embeddingDegraded:true）
    expect(updates).toHaveLength(1);
    const metadata = updates[0].metadata as Record<string, unknown>;
    expect(metadata.vectorized).toBe(false);
    expect(metadata.embeddingDegraded).toBe(true);
    // 真库落库结果同口径（不是只看 set 载荷）
    expect(stored[0]!.metadata).toMatchObject({ vectorized: false, embeddingDegraded: true });
  });

  // ⑥（评审 D）：降级标记必须能被清除——只写不清 = 嵌入服务恢复后文档仍自称降级，反向失真。
  it("D：降级后重建成功 → metadata 的降级标记被显式清成 false（不是 undefined）", async () => {
    // Given: 一篇历史上被标过降级的文档（模拟上一轮嵌入服务故障留下的标记）
    const doc = fakeDocument({ id: 51, content: "第一段内容。", metadata: { source: "upload" } });
    const { db, stored } = createFakeDb([doc]);
    vi.mocked(getDb).mockReturnValue(db as never);

    // 第一轮：嵌入服务全挂 → 降级
    vi.mocked(embedTextsWithOutcome).mockResolvedValueOnce({
      vectors: [[0.5, 0.5, 0.5]],
      identity: { model: HASH_FALLBACK_MODEL, dimension: 1536 },
      degraded: true,
    });
    await expect(indexDocumentById(51)).rejects.toThrow("拒绝写入 hash 伪向量");
    expect(stored[0]!.metadata).toMatchObject({ vectorized: false, embeddingDegraded: true });

    // 第二轮：服务恢复 → 真嵌入，标记必须被清掉
    vi.mocked(embedTextsWithOutcome).mockResolvedValueOnce({
      vectors: [[0.1, 0.2, 0.3]],
      identity: { model: "qwen3.7-text-embedding-flash", dimension: 3 },
      degraded: false,
    });
    await expect(indexDocumentById(51)).resolves.toEqual({ chunks: 1, skipped: false });

    const metadata = stored[0]!.metadata as Record<string, unknown>;
    expect(metadata.vectorized).toBe(true);
    expect(metadata.embeddingDegraded).toBe(false); // 是 false，不是 undefined
    // mergeDocumentMetadata 读最新行再合并：既有键不许被入口快照整块覆盖掉
    expect(metadata.source).toBe("upload");
  });

  // 评审 B2（一）：写入向量表的模型身份必须来自**本次调用**，不是进程级单例。
  it("B2：insertBatch 的 embeddingModel 来自本次 outcome.identity，而不是全局单例", async () => {
    const doc = fakeDocument({ id: 43, content: "正常内容。" });
    const { db } = createFakeDb([doc]);
    vi.mocked(getDb).mockReturnValue(db as never);
    // 本次真嵌入用的是 A 模型
    vi.mocked(embedTextsWithOutcome).mockResolvedValueOnce({
      vectors: [[0.1, 0.2, 0.3]],
      identity: { model: "qwen3.7-text-embedding-flash", dimension: 1024 },
      degraded: false,
    });
    // 但全局单例此刻被别的嵌入调用（并发语义检索等）覆盖成了 B 模型
    vi.mocked(getLastEmbeddingIdentity).mockReturnValueOnce({ model: "另一个模型的伪身份", dimension: 1536 });

    await indexDocumentById(43);

    const [entries] = vi.mocked(vectorEngine.insertBatch).mock.calls[0] as unknown as [
      Array<{ id: string; metadata: Record<string, unknown> }>,
    ];
    expect(entries[0]!.metadata.embeddingModel).toBe("qwen3.7-text-embedding-flash");
    expect(entries[0]!.metadata.embeddingModel).not.toBe("另一个模型的伪身份");
    expect(entries[0]!.metadata.embeddingDim).toBe(1024);
  });

  // 评审 B2（二）：降级判定同样不许看单例 —— 单例说是"真嵌入"，本次却是降级 → 仍必须拒绝。
  it("B2：单例声称是真嵌入也不影响降级判定（本次 degraded=true → 照旧拒写）", async () => {
    const doc = fakeDocument({ id: 44, content: "第一段内容。" });
    const { db } = createFakeDb([doc]);
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(embedTextsWithOutcome).mockResolvedValueOnce({
      vectors: [[0.5, 0.5, 0.5]],
      identity: { model: HASH_FALLBACK_MODEL, dimension: 1536 },
      degraded: true,
    });
    // 单例此刻是另一路真嵌入写的「好身份」——旧实现会据此把 hash 伪向量当真向量写进库
    vi.mocked(getLastEmbeddingIdentity).mockReturnValueOnce({ model: "qwen3.7-text-embedding-flash", dimension: 1024 });

    await expect(indexDocumentById(44)).rejects.toThrow("拒绝写入 hash 伪向量");
    expect(vectorEngine.insertBatch).not.toHaveBeenCalled();
    expect(vectorEngine.deleteByDocumentId).not.toHaveBeenCalled();
  });

  // 评审 B2（三）：反方向 —— 单例说是 hash，但本次是真嵌入 → 不许误判降级（好向量被丢）。
  it("B2：单例声称是 hash 兜底也不影响判定（本次 degraded=false → 正常写入）", async () => {
    const doc = fakeDocument({ id: 45, content: "正常内容。" });
    const { db, updates } = createFakeDb([doc]);
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(embedTextsWithOutcome).mockResolvedValueOnce({
      vectors: [[0.1, 0.2, 0.3]],
      identity: { model: "qwen3.7-text-embedding-flash", dimension: 3 },
      degraded: false,
    });
    vi.mocked(getLastEmbeddingIdentity).mockReturnValue({ model: HASH_FALLBACK_MODEL, dimension: 1536 });

    try {
      await expect(indexDocumentById(45)).resolves.toEqual({ chunks: 1, skipped: false });
      expect(vectorEngine.insertBatch).toHaveBeenCalledTimes(1);
      expect(updates[0]!.metadata).toMatchObject({ vectorized: true, embeddingDegraded: false });
    } finally {
      vi.mocked(getLastEmbeddingIdentity).mockReturnValue(null); // 还原，避免污染后续用例
    }
  });
});

describe("tryIndexDocumentById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 三态可辨（评审 S5）：文档"不存在"是真失败（failed=true），不是"文档本来就是空的"。
  it("swallows indexing errors and reports a real failure (not an empty-doc skip)", async () => {
    const { db } = createFakeDb([]);
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await tryIndexDocumentById(999);

    expect(result).toMatchObject({ chunks: 0, skipped: true, failed: true });
    expect(result.error).toContain("文档不存在");
  });

  // 同一个降级条件下，写文档路径的兜底钩子必须「不抛、如实报失败」——
  // 语义是「索引没成但文档还在」，调用方据此照常完成文档写入。
  it("hash 兜底时返回 failed 而不抛错（文档写入路径不受影响），且旧索引产物零破坏", async () => {
    const doc = fakeDocument({ id: 46, content: "第一段内容。" });
    const { db, inserted } = createFakeDb([doc]);
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(embedTextsWithOutcome).mockResolvedValueOnce({
      vectors: [[0.5, 0.5, 0.5]],
      identity: { model: HASH_FALLBACK_MODEL, dimension: 1536 },
      degraded: true,
    });

    const result = await tryIndexDocumentById(46);

    expect(result).toMatchObject({ chunks: 0, skipped: true, failed: true });
    expect(result.error).toContain("拒绝写入 hash 伪向量");
    expect(vectorEngine.insertBatch).not.toHaveBeenCalled();
    // B1：降级路径在破坏性写之前返回 —— 旧 chunks/向量一条都不删，新 chunks 一条不写
    expect(db.delete).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
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

// 可见性验收：嵌入服务全挂时，全量重建必须把每篇都计入 failed 并留下 lastError，
// 而不是 09-21 事故那样 failed=0 静默灌入 550+ 篇伪向量。
describe("startReindexAll 嵌入降级可见性", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("降级时逐篇计入 failed 并写 lastError，向量表零写入、旧索引零破坏", async () => {
    const docs = [fakeDocument({ id: 1, content: "文档一内容。" }), fakeDocument({ id: 2, content: "文档二内容。" })];
    const { db } = createFakeDb(docs);
    vi.mocked(getDb).mockReturnValue(db as never);
    // 本次每一篇的嵌入调用都降级（身份随结果返回，评审 B2）
    vi.mocked(embedTextsWithOutcome).mockResolvedValue({
      vectors: [[0.5, 0.5, 0.5]],
      identity: { model: HASH_FALLBACK_MODEL, dimension: 1536 },
      degraded: true,
    });

    try {
      startReindexAll();
      const deadline = Date.now() + 10_000;
      while (getReindexProgress().running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const final = getReindexProgress();
      expect(final.done).toBe(2);
      expect(final.failed).toBe(2); // 事故形状是 failed=0，这里必须是 2
      expect(final.chunksTotal).toBe(0); // 没有成功的索引
      expect(final.lastError).toContain("拒绝写入 hash 伪向量");
      expect(vectorEngine.insertBatch).not.toHaveBeenCalled(); // vec 表一颗伪向量都没进
      // B1：整轮重建一个破坏性动作都没有（旧索引完好，故障期不制造净损失）
      expect(db.delete).not.toHaveBeenCalled();
      expect(vectorEngine.deleteByDocumentId).not.toHaveBeenCalled();
    } finally {
      vi.mocked(embedTextsWithOutcome).mockResolvedValue({
        vectors: [[0.1, 0.2, 0.3]],
        identity: { model: "test-embedding-model", dimension: 3 },
        degraded: false,
      }); // 还原，避免污染后续用例
    }
  }, 15_000);
});
