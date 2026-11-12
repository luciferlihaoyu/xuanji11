import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  kbDocuments,
  ingestionJobs,
  ingestionItems,
  knowledgeNodes,
  type InsertIngestionJob,
  type InsertIngestionItem,
  type InsertKbDocument,
} from "@db/schema";
import { safeFetch } from "./safe-fetch";
import * as fs from "fs";
import * as path from "path";
import { env } from "./env";

export type IngestionSourceType = "upload" | "datasource" | "backup" | "manual";

export interface IngestFileOptions {
  sourceType: IngestionSourceType;
  sourceId?: string;
  fileName: string;
  mimeType: string;
  size: number;
  storagePath?: string;
  uploadedFileId?: number;
  externalId?: string;
  sourceUrl?: string;
  downloadUrl?: string;
  metadata?: Record<string, unknown>;
  createdBy?: number | null;
  /** 归档文件夹：调用方指定则文档落进该知识库文件夹（数据源同步按源归档用）。
   *  不传 = null（悬空文档，既有调用方行为不变）。 */
  folderId?: number | null;
}

const SUPPORTED_TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "application/json",
  "application/xml",
]);

function isTextMime(mimeType: string): boolean {
  return SUPPORTED_TEXT_MIMES.has(mimeType) || mimeType.startsWith("text/");
}

/** 扩展名 → mime（当上游没给出有意义的 mimeType 时兜底）。
 *  评审 B3 的根因：NAS 等连接器**根本不产 mimeType**，下载通路只能传
 *  "application/octet-stream" → 每个文件都被判"格式不支持"→ 同步全红 + 错误归因成
 *  "嵌入服务不可用"（一个谎换成另一个谎）。有扩展名就能救回来。 */
const EXT_MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".text": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};

/** 没有信息量的 mime（等于"不知道"） */
const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/binary",
  "binary/octet-stream",
  "",
]);

/**
 * 解析出真正用于判定的 mimeType：上游给的有意义就用它，
 * 没有或只是"octet-stream"就按扩展名推断（评审 B3）。
 */
export function resolveMimeType(fileName: string, mimeType?: string | null): string {
  const mt = (mimeType ?? "").trim().toLowerCase();
  if (mt && !GENERIC_MIME_TYPES.has(mt)) return mt;
  const ext = path.extname(fileName).toLowerCase();
  return EXT_MIME_TYPES[ext] ?? (mt || "application/octet-stream");
}

const TEMP_DIR = path.resolve(env.uploadDir);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function ensureLocalPath(options: IngestFileOptions): Promise<{ localPath: string; isTemp: boolean }> {
  if (options.storagePath && fs.existsSync(options.storagePath)) {
    return { localPath: options.storagePath, isTemp: false };
  }
  const url = options.downloadUrl || options.sourceUrl;
  if (!url) {
    throw new Error("No local path or downloadable URL provided");
  }
  // 2026-10-01 拆雷：此处曾是全仓唯一一处完全不过 egress 门禁的裸 fetch。
  // scope=admin：URL 来自管理员配置的网盘服务的签名地址（alist/115/aliyundrive）；
  // 用户可控内容一律走 storagePath 本地路径，不经网络。协议白名单/私网判定/钉连接由 safeFetch 统一兜住。
  const res = await safeFetch(url, { scope: "admin" });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(options.fileName) || ".bin";
  const tempPath = path.join(TEMP_DIR, `ds-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tempPath, buffer);
  return { localPath: tempPath, isTemp: true };
}

async function parseFileToText(storagePath: string, mimeType: string): Promise<{ text: string; supported: boolean }> {
  if (!fs.existsSync(storagePath)) {
    return { text: "", supported: false };
  }

  if (isTextMime(mimeType)) {
    const buffer = fs.readFileSync(storagePath);
    return { text: buffer.toString("utf-8"), supported: true };
  }

  if (mimeType === "application/pdf") {
    try {
      const pdfjs = await import("pdfjs-dist");
      const data = new Uint8Array(fs.readFileSync(storagePath));
      const doc = await pdfjs.getDocument({ data }).promise;
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => (item as { str: string }).str).join(""));
      }
      return { text: pages.join("\n"), supported: true };
    } catch (err) {
      console.error("[Ingestion] PDF parse failed:", err);
      return { text: "", supported: false };
    }
  }

  return { text: "", supported: false };
}

export async function createIngestionJob(
  sourceType: IngestionSourceType,
  sourceId: string | undefined,
  createdBy: number | null
): Promise<number> {
  const db = getDb();
  const values: InsertIngestionJob = {
    sourceType,
    sourceId: sourceId ?? null,
    status: "pending",
    totalItems: 0,
    processedItems: 0,
    failedItems: 0,
    error: null,
    retryCount: 0,
    metadata: {},
    createdBy,
  };
  const result = await db.insert(ingestionJobs).values(values);
  return Number(result.lastInsertRowid);
}

/**
 * ingestFile 的返回：除了「产生了哪条 item / 哪个文档」，还必须如实回报**索引是否真的做成了**。
 *
 * 为什么要这个字段（2026-11）：本函数对「文档已入库但索引失败」不再抛错（否则一条坏索引
 * 会炸掉整个同步批次），于是调用方只看"有没有抛错"就会把**检索不到的文档**统计成
 * 「成功入库 N 条」、作业 failedItems=0、数据源 lastError=null —— 假成功。
 * 口径：indexed === true 才代表"切块 + FTS + 向量"三路都落库、文档真的可检索。
 */
export interface IngestFileResult {
  itemId: number;
  documentId?: number;
  /** 文档是否已完成索引（切块+FTS+向量）。false 表示文档已入库但索引失败 */
  indexed: boolean;
  /** indexed=false 时的原因（原文） */
  indexError?: string;
  /** 失败原因分类（评审 B3：调用方要能区分"文件格式不支持"与"我们的嵌入服务坏了"，
   *  否则就会把格式问题错误归因成"嵌入服务不可用"，把排查引向错方向） */
  reason?: "ingest_failed" | "unsupported" | "empty" | "index_failed";
}

export async function ingestFile(options: IngestFileOptions): Promise<IngestFileResult> {
  const db = getDb();
  const {
    sourceType,
    sourceId,
    fileName,
    mimeType,
    size,
    storagePath,
    uploadedFileId,
    externalId,
    sourceUrl,
    metadata: extraMetadata,
    createdBy,
  } = options;

  let localPath = storagePath;
  let isTemp = false;
  try {
    const ensured = await ensureLocalPath(options);
    localPath = ensured.localPath;
    isTemp = ensured.isTemp;
  } catch (err) {
    console.error("[Ingestion] ensureLocalPath failed:", err);
    const jobId = await createIngestionJob(sourceType, sourceId, createdBy ?? null);
    const itemResult = await db.insert(ingestionItems).values({
      jobId,
      externalId: externalId ?? null,
      name: fileName,
      mimeType,
      size,
      status: "failed",
      error: "Internal error",
      sourceUrl: sourceUrl ?? null,
      storagePath: storagePath ?? null,
      documentId: null,
      metadata: { ...(extraMetadata ?? {}), uploadedFileId: uploadedFileId ?? null },
    });
    await db.update(ingestionJobs).set({ totalItems: 1, processedItems: 1, failedItems: 1, status: "completed" }).where(eq(ingestionJobs.id, jobId));
    // 没拿到可读的本地文件 = 压根没入库；indexError 与 item.error 保持一字不差（"Internal error"）。
    return { itemId: Number(itemResult.lastInsertRowid), indexed: false, indexError: "Internal error", reason: "ingest_failed" };
  }

  const ext = path.extname(fileName).toLowerCase();
  const jobId = await createIngestionJob(sourceType, sourceId, createdBy ?? null);

  // 有效 mime：上游没给或只给了 octet-stream 时按扩展名兜底（评审 B3）
  const effectiveMime = resolveMimeType(fileName, mimeType);

  const itemValues: InsertIngestionItem = {
    jobId,
    externalId: externalId ?? null,
    name: fileName,
    mimeType: effectiveMime,
    size,
    status: "pending",
    error: null,
    sourceUrl: sourceUrl ?? null,
    storagePath: isTemp ? null : localPath,
    documentId: null,
    metadata: { ...(extraMetadata ?? {}), uploadedFileId: uploadedFileId ?? null },
  };
  const itemResult = await db.insert(ingestionItems).values(itemValues);
  const itemId = Number(itemResult.lastInsertRowid);

  await db
    .update(ingestionJobs)
    .set({ totalItems: 1, status: "running" })
    .where(eq(ingestionJobs.id, jobId));

  const { text, supported } = await parseFileToText(localPath, effectiveMime);

  if (isTemp && fs.existsSync(localPath)) {
    try { fs.unlinkSync(localPath); } catch { /* ignore cleanup errors */ }
  }

  if (!supported || text.trim().length === 0) {
    // 这一支根本没有生成文档（不支持格式 / 解析后正文为空），因此**不可能**有任何内容可检索：
    // indexed 必须如实为 false，否则同步侧会把它算进"成功入库"——那正是要消灭的假成功。
    // indexError：不支持格式沿用 item.error 原文；正文为空则给出明确说法（item.error 保持 null 不变）。
    // reason 分类让调用方能把"格式不支持"与"索引失败"分开统计与归因（评审 B3）。
    const indexError = supported ? "解析后正文为空" : `Unsupported format: ${effectiveMime}`;
    await db
      .update(ingestionItems)
      .set({ status: supported ? "completed" : "unsupported", error: supported ? null : `Unsupported format: ${effectiveMime}` })
      .where(eq(ingestionItems.id, itemId));
    await db
      .update(ingestionJobs)
      .set({ processedItems: 1, failedItems: supported ? 0 : 1, status: "completed" })
      .where(eq(ingestionJobs.id, jobId));
    return { itemId, indexed: false, indexError, reason: supported ? "empty" : "unsupported" };
  }

  await db.update(ingestionItems).set({ status: "parsing" }).where(eq(ingestionItems.id, itemId));

  const docValues: InsertKbDocument = {
    // 归档文件夹由调用方决定（2026-10-01）：数据源同步会传"数据源/源名"子夹，
    // 其余调用方不传 → null（悬空），行为与此前一致。
    folderId: options.folderId ?? null,
    title: path.basename(fileName, ext),
    content: text,
    format: mimeTypeToFormat(effectiveMime),
    tags: [],
    metadata: { source: sourceType, vectorized: false },
    createdBy: createdBy ?? null,
  };
  const docResult = await db.insert(kbDocuments).values(docValues);
  const documentId = Number(docResult.lastInsertRowid);

  // 图谱节点与"是否建成向量"无关（评审 B4）：
  // 索引失败时若不建节点，文档会永久缺失图谱节点（重建索引不会补建 knowledge_nodes），
  // 图谱检索与关系视图静默变空、且没有任何巡检项会发现。所以节点先建，索引成败只影响向量腿。
  const nodeTitle = docValues.title ?? fileName;
  await db.insert(knowledgeNodes).values({
    title: nodeTitle,
    content: text.slice(0, 500),
    type: "document",
    posX: 0,
    posY: 0,
    style: {},
    metadata: { documentId: String(documentId), source: sourceType },
    createdBy: createdBy ?? null,
  });

  await db.update(ingestionItems).set({ status: "chunking", documentId }).where(eq(ingestionItems.id, itemId));

  // 切块 / FTS / 向量三件事统一交给索引器（document-indexer.indexDocumentById）：
  //   · 它自己会 chunkText → 写 document_chunks → 同步 chunks_fts（关键词腿）→
  //     vectorEngine.insertBatch 写向量表（语义腿）→ 按**真实结果**置 metadata.vectorized。
  //   · 本文件此前自己切块写 chunks（embedding 全 null）再调 vectorEngine 那个空壳分块索引方法（本轮已删除），
  //     而后者在 sqlite-vec 引擎里只是「删旧向量 + return chunks.length」，既不 embed 也不写 FTS；
  //     ingestion 随后又把 vectorized 写成 indexedCount > 0（恒 true）、任务记 completed，
  //     于是用户看到「入库成功」，文档却关键词、语义两路都查不到（必须先手工重建索引）。
  //   · 若在这里再切一次块，同一文档会有两份 chunks——所以**只调索引器，不自己切块**。
  await db.update(ingestionItems).set({ status: "indexing" }).where(eq(ingestionItems.id, itemId));

  // 用会抛错的 indexDocumentById（不是 tryIndexDocumentById）：入库的成功/失败要如实可见。
  const { indexDocumentById } = await import("./document-indexer");
  try {
    await indexDocumentById(documentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 文档本身保留（正文可读；FTS 已在 indexDocumentById 内同步过），但索引失败必须如实可见。
    // job 记 completed + failedItems: 1，与上面 ensureLocalPath 失败那支同口径。
    await db
      .update(ingestionItems)
      .set({ status: "failed", error: `索引失败: ${msg}`, documentId })
      .where(eq(ingestionItems.id, itemId));
    await db
      .update(ingestionJobs)
      .set({ processedItems: 1, failedItems: 1, status: "completed" })
      .where(eq(ingestionJobs.id, jobId));
    return { itemId, documentId, indexed: false, indexError: msg, reason: "index_failed" };
  }

  await db.update(ingestionItems).set({ status: "completed" }).where(eq(ingestionItems.id, itemId));
  await db
    .update(ingestionJobs)
    .set({ processedItems: 1, failedItems: 0, status: "completed" })
    .where(eq(ingestionJobs.id, jobId));

  return { itemId, documentId, indexed: true };
}

function mimeTypeToFormat(mimeType: string): InsertKbDocument["format"] {
  if (mimeType.includes("markdown")) return "markdown";
  if (mimeType.includes("html")) return "html";
  if (mimeType.includes("json")) return "json";
  if (mimeType.includes("text")) return "text";
  return "text";
}
