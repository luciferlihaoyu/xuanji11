/**
 * ingestFile 的归档口径（2026-10-01）。
 *
 * 文档该落进哪个知识库文件夹，由调用方传入的 folderId 决定 —— 此前 docValues.folderId
 * 被**写死为 null**，于是数据源同步进来的内容全部悬空、无法按源归档（用户诉求：
 * 「根据对应的数据源新建一个文件夹，对应数据源的数据资料都放进自己对应的文件夹」）。
 * 本文件钉住两条：传则落、不传则保持 null（既有调用方行为不变）。
 */
import * as fs from "fs";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fullSchema from "@db/schema";
import { getDb } from "../queries/connection";
import { ingestFile, resolveMimeType } from "./ingestion";
import { indexDocumentById } from "./document-indexer";

vi.hoisted(() => {
  // env.ts 对必填变量做存在性校验，缺了就 process.exit(1)（本仓既有测试都在 hoisted 里补）
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
  process.env.UPLOAD_DIR = `${process.env.TMPDIR || "/tmp"}/xuanji-ingest-test-${process.pid}`;
});

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));

// vectorEngine 是 Zvec 原生二进制，本容器加载不了；连同 vector-service 一起 mock（仓库既有测试惯例）
// 存量缺陷的复盘：旧 ingestFile 会调 vectorEngine 的空壳分块索引方法 —— 它只删旧向量后
// `return chunks.length`（既不 embed 也不写 FTS），ingestion 却把 `indexedCount > 0` 写成
// metadata.vectorized（恒 true）→「入库成功但两路都查不到」。该方法与那条路径本轮已一并删除，
// 桩也不必再存在；现在 ingestFile 只委托 indexDocumentById（下方单独 mock）。
vi.mock("./vector", () => ({
  vectorEngine: {
    size: 0,
    deleteByDocumentId: vi.fn(async () => 0),
    insertBatch: vi.fn(async () => {}),
  },
  initializeZvec: vi.fn(),
}));

// document-indexer 的真实现会走 embedTextsWithFallback / getLastEmbeddingIdentity /
// HASH_FALLBACK_MODEL / ensureCorrectDimension（本文件只用 importOriginal 保留 chunkText，
// 但模块在加载期就要解析这些具名导出，缺一个就是「No X export is defined on the mock」），
// 故 mock 必须把这些名字补齐，否则报的错与生产无关。
vi.mock("./vector-service", () => ({
  listCollections: vi.fn(),
  addDocumentsToCollection: vi.fn(),
  deleteCollection: vi.fn(),
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
  getStats: vi.fn(),
  initializeZvec: vi.fn(),
  vectorEngine: { size: 0 },
  embedTextsWithFallback: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  ensureCorrectDimension: vi.fn(async () => {}),
  getLastEmbeddingIdentity: vi.fn((): { model: string; dimension: number } | null => null),
  HASH_FALLBACK_MODEL: "__hash_fallback__",
}));

// ==== 本轮核心桩：把「真索引器」拦住，只观察 ingestFile 有没有委托它 ====
// 2026-11 缺陷：ingestFile 自己切块（embedding 全 null）+ 调已空壳化的
// vectorEngine 的空壳分块索引方法（只删向量、不 embed、不写 FTS），
// 然后把 metadata.vectorized 写成 `indexedCount > 0`（恒 true）、任务记 completed
// —— 用户看到「入库成功」，但该文档关键词腿和语义腿都查不到。
// 真路径只有一条：api/lib/document-indexer.ts 的 indexDocumentById（切块→FTS→向量→置 vectorized）。
vi.mock("./document-indexer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./document-indexer")>();
  return { ...actual, indexDocumentById: vi.fn() };
});

/** 与 schema 对齐的最小内存库；用真实 drizzle 实例（照抄本仓既有测试写法）。 */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE ingestion_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceType TEXT NOT NULL, sourceId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      totalItems INTEGER DEFAULT 0, processedItems INTEGER DEFAULT 0, failedItems INTEGER DEFAULT 0,
      error TEXT, retryCount INTEGER DEFAULT 0, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ingestion_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId INTEGER NOT NULL, externalId TEXT, name TEXT NOT NULL, mimeType TEXT, size INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT,
      sourceUrl TEXT, storagePath TEXT, documentId INTEGER, metadata TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderId INTEGER,
      title TEXT NOT NULL,
      content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown',
      tags TEXT,
      metadata TEXT,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER,
      deletedReason TEXT,
      mergedIntoId INTEGER
    );
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documentId INTEGER NOT NULL,
      itemId INTEGER,
      content TEXT NOT NULL,
      chunkIndex INTEGER NOT NULL DEFAULT 0,
      embedding TEXT,
      embeddingModel TEXT,
      metadata TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      type TEXT NOT NULL DEFAULT 'concept',
      posX REAL DEFAULT 0, posY REAL DEFAULT 0,
      style TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
  `);
  return sqlite;
}

function writeTempMarkdown(name: string, content: string): string {
  const dir = `${process.env.TMPDIR || "/tmp"}/xuanji-ingest-test-${process.pid}`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

describe("ingestFile 的文件夹归档口径", () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = createTestDb();
    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
  });

  it("传 folderId → 文档落进该文件夹（数据源按源归档的地基）", async () => {
    const file = writeTempMarkdown("归档-甲.md", "# 甲文\n\n这是正文内容。");
    const { documentId } = await ingestFile({
      sourceType: "datasource",
      fileName: "归档-甲.md",
      mimeType: "text/markdown",
      size: fs.statSync(file).size,
      storagePath: file,
      folderId: 42,
    });

    const row = raw
      .prepare("SELECT folderId, title FROM kb_documents WHERE id = ?")
      .get(documentId) as { folderId: number | null; title: string } | undefined;
    expect(row?.folderId).toBe(42);
  });

  it("不传 folderId → 保持 null（既有调用方行为不变，向后兼容）", async () => {
    const file = writeTempMarkdown("归档-乙.md", "# 乙文\n\n这是正文内容。");
    const { documentId } = await ingestFile({
      sourceType: "upload",
      fileName: "归档-乙.md",
      mimeType: "text/markdown",
      size: fs.statSync(file).size,
      storagePath: file,
    });

    const row = raw
      .prepare("SELECT folderId FROM kb_documents WHERE id = ?")
      .get(documentId) as { folderId: number | null } | undefined;
    expect(row?.folderId).toBeNull();
  });
});

/**
 * 入库必须走真索引路径（2026-11 缺陷）。
 *
 * 症状：上传页/数据源同步/网盘导入进来的文档，界面显示「入库成功」，但关键词检索与
 * 语义检索都查不到，除非手工再跑一次「重建索引」。
 * 根因：ingestFile 自己切块写 document_chunks（embedding 全 null），随后调用
 * vectorEngine 的空壳分块索引方法 —— 它在 sqlite-vec 引擎里只是 `deleteByDocumentId`
 * 之后 `return chunks.length`，既不 embed 也不写 FTS；而 metadata.vectorized 又被写成
 * `indexedCount > 0`（恒 true）、任务记 completed → 假成功。
 * 口径：切块/FTS/向量三件事统一由 indexDocumentById 负责（它也自己写 document_chunks，
 * 因此 ingestFile 再切一次就是双份）；成功才 completed，失败必须如实 failed + 原因。
 */
describe("ingestFile 的入库必须走真索引路径（切块 → FTS → 向量）", () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = createTestDb();
    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
    vi.mocked(indexDocumentById).mockReset();
  });

  function itemRow(itemId: number) {
    return raw
      .prepare("SELECT status, error, documentId FROM ingestion_items WHERE id = ?")
      .get(itemId) as { status: string; error: string | null; documentId: number | null } | undefined;
  }

  function jobRowOf(itemId: number) {
    const item = raw.prepare("SELECT jobId FROM ingestion_items WHERE id = ?").get(itemId) as { jobId: number };
    return raw
      .prepare("SELECT status, processedItems, failedItems FROM ingestion_jobs WHERE id = ?")
      .get(item.jobId) as { status: string; processedItems: number; failedItems: number };
  }

  async function ingest(name: string, content: string) {
    const file = writeTempMarkdown(name, content);
    return ingestFile({
      sourceType: "upload",
      fileName: name,
      mimeType: "text/markdown",
      size: fs.statSync(file).size,
      storagePath: file,
    });
  }

  it("成功路径：委托 indexDocumentById 索引，自己不再切块写 chunks，item 记 completed", async () => {
    vi.mocked(indexDocumentById).mockResolvedValue({ chunks: 3, skipped: false });
    // 正文刻意超过一个切块窗口（800 字），旧实现会切出多块并直接写库 —— 正是要禁止的行为
    const { itemId, documentId } = await ingest("真索引-甲.md", `${"第一段内容。".repeat(200)}尾巴`);

    expect(documentId).toBeTypeOf("number");
    // ① 必须把同一个 documentId 交给真索引器（而不是自己糊完就宣告成功）
    expect(indexDocumentById).toHaveBeenCalledTimes(1);
    expect(indexDocumentById).toHaveBeenCalledWith(documentId);

    // ② document_chunks 不得由 ingestFile 直接写入：切块由索引器负责，否则同一文档双份 chunks。
    //    本用例把索引器 mock 掉 → 表里应为 0 行（旧实现会在这里留下 >0 行）。
    const chunks = raw
      .prepare("SELECT COUNT(*) AS n FROM document_chunks WHERE documentId = ?")
      .get(documentId) as { n: number };
    expect(chunks.n).toBe(0);

    // ③ 只有索引器成功（未抛错）才允许写 completed
    expect(itemRow(itemId)?.status).toBe("completed");
    expect(itemRow(itemId)?.documentId).toBe(documentId);
    expect(jobRowOf(itemId)).toMatchObject({ status: "completed", processedItems: 1, failedItems: 0 });
  });

  it("失败路径：索引抛错 → item failed + error 含「索引失败」，文档保留，vectorized 不为 true", async () => {
    vi.mocked(indexDocumentById).mockRejectedValue(
      new Error("嵌入服务不可用：已拒绝写入 hash 伪向量（文档正文与关键词索引已保留）"),
    );

    const { itemId, documentId, indexed, reason } = await ingest("真索引-乙.md", "# 乙文\n\n这是正文内容。");

    // ① 入库失败必须如实可见，不能报成功
    expect(itemRow(itemId)?.status).toBe("failed");
    // ② 失败原因要能定位到是索引这一步，并带上索引器给的原始原因
    expect(itemRow(itemId)?.error).toContain("索引失败");
    expect(itemRow(itemId)?.error).toContain("嵌入服务不可用");
    // ③ 任务计数如实记为失败（与本文件 ensureLocalPath 失败那支同口径：job status completed + failedItems 1）
    expect(jobRowOf(itemId)).toMatchObject({ status: "completed", failedItems: 1 });
    // ③' 返回值必须自证"没索引成"并给出分类（评审 B3：调用方据此区分职责，别把格式问题归因成嵌入服务坏）
    expect(indexed).toBe(false);
    expect(reason).toBe("index_failed");

    // ④ 文档本身必须保留：正文可读、FTS 已在索引器内同步过，删掉等于把用户文件也弄丢
    const doc = raw
      .prepare("SELECT metadata FROM kb_documents WHERE id = ?")
      .get(documentId) as { metadata: string | null } | undefined;
    expect(doc).toBeDefined();
    // ⑤ **改强**（原断言 toMatchObject({vectorized:false}) 因 ingestFile 插入时即写 false 而近乎恒真）：
    //    整块 metadata 必须与入口那一句一字不差 —— ingestFile 绝不代索引器把 vectorized 写成 true，
    //    也不许偷偷加 embeddingDegraded 之类的"结论性"字段（结论只能由索引器给）。
    expect(JSON.parse(doc?.metadata ?? "{}")).toEqual({ source: "upload", vectorized: false });
  });

  /**
   * 并行的对照用例：把 ⑤ 那条断言放到"索引成功"的一侧，证明它不是恒真。
   * indexDocumentById 是**被 mock 的边界**（真索引器要 embed + 写 FTS + 写 vec 表），
   * 这里只复刻它的 metadata 契约（成功 → vectorized:true / embeddingDegraded:false），
   * 然后断言 ingestFile 跑完之后库里确实是 true —— 若 ingestFile 事后回写 metadata，
   * 就会把索引器的结论盖回 false，这条立刻变红。
   */
  it("对照：索引成功时 vectorized 必须变成 true（同一断言在另一侧可证伪）", async () => {
    vi.mocked(indexDocumentById).mockImplementation(async (docId: number) => {
      raw.prepare("UPDATE kb_documents SET metadata = ? WHERE id = ?").run(
        JSON.stringify({ source: "upload", vectorized: true, embeddingDegraded: false }),
        docId,
      );
      return { chunks: 1, skipped: false };
    });

    const { itemId, documentId, indexed } = await ingest("真索引-丁.md", "# 丁文\n\n这是正文内容。");

    expect(indexed).toBe(true);
    expect(itemRow(itemId)?.status).toBe("completed");
    const doc = raw
      .prepare("SELECT metadata FROM kb_documents WHERE id = ?")
      .get(documentId) as { metadata: string | null } | undefined;
    expect(JSON.parse(doc?.metadata ?? "{}")).toMatchObject({ vectorized: true, embeddingDegraded: false });
    expect(JSON.parse(doc?.metadata ?? "{}").vectorized).not.toBe(false);
  });

  it("不得出现假成功：失败路径下全库不存在 vectorized === true 的文档", async () => {
    vi.mocked(indexDocumentById).mockRejectedValue(new Error("嵌入服务不可用"));
    await ingest("真索引-丙.md", "# 丙文\n\n这是正文内容。");

    const rows = raw.prepare("SELECT id, metadata FROM kb_documents").all() as Array<{ id: number; metadata: string | null }>;
    expect(rows).toHaveLength(1); // 文档保留
    const lied = rows.filter((r) => (JSON.parse(r.metadata ?? "{}") as { vectorized?: unknown }).vectorized === true);
    // 「入库成功但查不到」的假成功，本质就是 vectorized 撒谎 → 一条都不许有
    expect(lied).toEqual([]);
  });
});

/**
 * 评审 B3 / B4（2026-11-11）。
 *
 * B3 的根因：NAS 等连接器**根本不产 mimeType**，下载通路只能传 "application/octet-stream"，
 * 于是每个文件都被判「格式不支持」→ 同步全红，而且错误还被归因成「嵌入服务不可用」
 * （一个谎换成另一个谎，把排查引向完全错误的方向）。有扩展名就能救回来。
 * B4 的根因：图谱节点原先建在索引之后 —— 索引一失败节点就永久缺失，
 * 而「重建索引」不会补建 knowledge_nodes，图谱检索与关系视图静默变空且无人发现。
 */
describe("ingestFile 的 mime 兜底 / 图谱节点 / 失败原因分类（B3 · B4）", () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = createTestDb();
    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
    vi.mocked(indexDocumentById).mockReset();
  });

  function itemRow(itemId: number) {
    return raw
      .prepare("SELECT status, error, mimeType, documentId FROM ingestion_items WHERE id = ?")
      .get(itemId) as { status: string; error: string | null; mimeType: string | null; documentId: number | null } | undefined;
  }

  it("B3：mime 只有 application/octet-stream 时按扩展名兜底 —— note.md 的正文必须被解析出来", async () => {
    vi.mocked(indexDocumentById).mockResolvedValue({ chunks: 1, skipped: false });
    const file = writeTempMarkdown("note.md", "# 标题\n\n这是 markdown 正文内容。");

    const result = await ingestFile({
      sourceType: "datasource",
      fileName: "note.md",
      mimeType: "application/octet-stream", // NAS 这类连接器给的就是它
      size: fs.statSync(file).size,
      storagePath: file,
    });

    // ① 不再是 unsupported：文档真的生成了，正文可读
    expect(result.indexed).toBe(true);
    expect(result.reason).toBeUndefined();
    const doc = raw
      .prepare("SELECT content, format FROM kb_documents WHERE id = ?")
      .get(result.documentId) as { content: string; format: string } | undefined;
    expect(doc?.content).toContain("这是 markdown 正文内容");
    expect(doc?.format).toBe("markdown");
    // ② 落库的 mime 是推断后的有效 mime（不是 octet-stream），按 mime 分流的后续环节才不会再判错
    expect(itemRow(result.itemId)?.mimeType).toBe("text/markdown");
    expect(itemRow(result.itemId)?.status).toBe("completed");
  });

  it("B3：上游给了有意义的 mime 就以它为准，不被扩展名覆盖", async () => {
    expect(resolveMimeType("note.md", "text/plain")).toBe("text/plain");
    expect(resolveMimeType("note.md", "application/octet-stream")).toBe("text/markdown");
    expect(resolveMimeType("note.txt", undefined)).toBe("text/plain");
    expect(resolveMimeType("doc.pdf", "")).toBe("application/pdf");
    // 既没 mime 也没认识的扩展名 → 仍是 octet-stream（保持"格式不支持"这条老路）
    expect(resolveMimeType("blob.bin", "application/octet-stream")).toBe("application/octet-stream");
  });

  it("B4：索引失败时图谱节点依然建立（重建索引不会补建 knowledge_nodes）", async () => {
    vi.mocked(indexDocumentById).mockRejectedValue(
      new Error("嵌入服务不可用：已拒绝写入 hash 伪向量（文档既有索引保持不变，可稍后重建）"),
    );
    const file = writeTempMarkdown("图谱-甲.md", "# 甲文\n\n图谱节点必须在索引之前建好。");

    const result = await ingestFile({
      sourceType: "upload",
      fileName: "图谱-甲.md",
      mimeType: "text/markdown",
      size: fs.statSync(file).size,
      storagePath: file,
    });

    // ① 返回值如实：文档入库了，但索引没成
    expect(result.indexed).toBe(false);
    expect(result.reason).toBe("index_failed");
    expect(result.indexError).toContain("嵌入服务不可用");
    // ② 关键：图谱节点照建，且指向这篇文档（旧实现里它压根不会被插入）
    const nodes = raw
      .prepare("SELECT title, content, type, metadata FROM knowledge_nodes WHERE CAST(json_extract(metadata, '$.documentId') AS INTEGER) = ?")
      .all(result.documentId) as Array<{ title: string; content: string; type: string; metadata: string }>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.type).toBe("document");
    expect(nodes[0]!.title).toBe("图谱-甲");
    expect(nodes[0]!.content).toContain("图谱节点必须在索引之前建好");
    expect(JSON.parse(nodes[0]!.metadata)).toMatchObject({ source: "upload" });
  });

  it("B3：格式不支持 → reason=unsupported，且压根不生成文档、不建图谱节点", async () => {
    const dir = `${process.env.TMPDIR || "/tmp"}/xuanji-ingest-test-${process.pid}`;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "压缩包.bin");
    fs.writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));

    const result = await ingestFile({
      sourceType: "datasource",
      fileName: "压缩包.bin",
      mimeType: "application/octet-stream",
      size: 6,
      storagePath: file,
    });

    expect(result.indexed).toBe(false);
    expect(result.reason).toBe("unsupported");
    expect(result.indexError).toContain("Unsupported format");
    // 没生成文档 → 也不可能索引、不可能有图谱节点（这类文件既不是成功也不是索引失败）
    expect(indexDocumentById).not.toHaveBeenCalled();
    expect((raw.prepare("SELECT COUNT(*) AS n FROM kb_documents").get() as { n: number }).n).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n).toBe(0);
    expect(itemRow(result.itemId)?.status).toBe("unsupported");
  });

  it("B3：正文为空 → reason=empty（既不是 unsupported，也不是 index_failed）", async () => {
    const file = writeTempMarkdown("空白.md", "   \n\n\t  ");

    const result = await ingestFile({
      sourceType: "upload",
      fileName: "空白.md",
      mimeType: "text/markdown",
      size: fs.statSync(file).size,
      storagePath: file,
    });

    expect(result.indexed).toBe(false);
    expect(result.reason).toBe("empty");
    expect(result.indexError).toContain("正文为空");
    // 空文档 = 没有可索引内容，索引器根本不该被调用（调用方也不该把它算成索引失败）
    expect(indexDocumentById).not.toHaveBeenCalled();
    expect((raw.prepare("SELECT COUNT(*) AS n FROM kb_documents").get() as { n: number }).n).toBe(0);
  });
});
