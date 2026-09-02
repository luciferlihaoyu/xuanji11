/**
 * 文档索引器 — 知识库文档 → 分块 → document_chunks 表 → ZVec 向量索引
 *
 * 所有文档写入路径（kb-router / MCP document_write / 批量回填）共用此模块，
 * 保证任何路径写入的文档都会被向量化。写入方应使用 tryIndexDocumentById，
 * 索引失败不影响文档本身的写入成功。
 */

import { eq, isNotNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbDocuments, documentChunks } from "@db/schema";
import { vectorEngine } from "./vector";
import { embedTextsWithFallback, ensureCorrectDimension } from "./vector-service";

export function chunkText(text: string, maxChars = 800, overlap = 100): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized ? [normalized] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + maxChars, normalized.length);
    let slice = normalized.slice(start, end);
    if (end < normalized.length) {
      const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf(". "));
      if (lastBreak > overlap) {
        slice = slice.slice(0, lastBreak + 1);
      }
    }
    chunks.push(slice.trim());
    start += Math.max(slice.length - overlap, 1);
  }
  return chunks.filter((c) => c.length > 0);
}

export interface IndexDocumentResult {
  readonly chunks: number;
  /** true 表示文档无内容或为空，仅做了清理 */
  readonly skipped: boolean;
}

/**
 * 重建单个文档的向量索引：清理旧分块和旧向量 → 分块 → 写 document_chunks → 写 ZVec。
 * 失败会抛错，调用方根据需要选择 tryIndexDocumentById 兜底。
 */
export async function indexDocumentById(documentId: number): Promise<IndexDocumentResult> {
  const db = getDb();
  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, documentId));
  if (!doc) throw new Error(`文档不存在: ${documentId}`);

  await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));

  const content = doc.content?.trim() ?? "";
  if (content.length === 0) {
    await vectorEngine.deleteByDocumentId(documentId);
    return { chunks: 0, skipped: true };
  }

  const chunks = chunkText(content);
  if (chunks.length === 0) {
    await vectorEngine.deleteByDocumentId(documentId);
    return { chunks: 0, skipped: true };
  }

  // 校准向量表维度（确保用 system_settings 的真实 dim 建表，否则 insertBatch 维度检查会静默跳过）
  await ensureCorrectDimension();

  // 真正 embed 每个 chunk（修复 R3 空壳：此前从不 embed/写入向量表）
  const chunkContents = chunks.map((content, index) => ({ content, index }));
  const vectors = await embedTextsWithFallback(chunkContents.map((c) => c.content));

  // 插入 document_chunks（embedding 列无人读取，不写大 JSON，向量只存 vec 表）
  await db.insert(documentChunks).values(chunkContents.map((c) => ({
    documentId,
    content: c.content,
    chunkIndex: c.index,
  })));

  // 写入 vec 表（vec_chunks + vec_chunk_meta）
  await vectorEngine.insertBatch(
    chunkContents.map((c, index) => ({
      id: `chunk-${documentId}-${c.index}`,
      vector: vectors[index] ?? [],
      metadata: {
        documentId: String(documentId),
        chunkIndex: c.index,
        content: c.content,
        title: doc.title,
        format: doc.format,
      },
    })),
  );

  await db.update(kbDocuments)
    .set({ metadata: { ...(doc.metadata ?? {}), vectorized: true } })
    .where(eq(kbDocuments.id, documentId));

  return { chunks: chunks.length, skipped: false };
}

/**
 * 索引失败不抛错的版本 — 用于文档写入路径的自动索引钩子，
 * 保证 embedding 服务故障时文档本身仍能写入成功。
 */
export async function tryIndexDocumentById(documentId: number): Promise<IndexDocumentResult> {
  try {
    return await indexDocumentById(documentId);
  } catch (err) {
    console.warn(
      `[DocumentIndexer] Failed to index document ${documentId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return { chunks: 0, skipped: true };
  }
}

// ==================== 批量回填（带进度状态） ====================

export interface ReindexProgress {
  readonly running: boolean;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly chunksTotal: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly currentDocumentId?: number;
  readonly lastError?: string;
}

const idleProgress: ReindexProgress = { running: false, total: 0, done: 0, failed: 0, chunksTotal: 0 };
let progress: ReindexProgress = { ...idleProgress };

export function getReindexProgress(): ReindexProgress {
  return { ...progress };
}

/** 每篇文档索引之间的间隔，避免打满 embedding API 限流 */
const REINDEX_DELAY_MS = 100;

/**
 * 启动全量回填。已在运行时直接返回当前进度（幂等），
 * 后台逐篇索引，进度通过 getReindexProgress 查询。
 */
export function startReindexAll(): ReindexProgress {
  if (progress.running) return getReindexProgress();
  progress = { ...idleProgress, running: true, startedAt: new Date().toISOString() };
  void runReindexAll();
  return getReindexProgress();
}

async function runReindexAll(): Promise<void> {
  try {
    // 启动前异步校准向量表维度（修复 R3 维度不匹配导致 0 条向量的 bug）
    const { ensureCorrectDimension } = await import("./vector-service");
    await ensureCorrectDimension();
    const db = getDb();
    const docs = await db.select({ id: kbDocuments.id }).from(kbDocuments).where(isNotNull(kbDocuments.content));
    progress = { ...progress, total: docs.length };
    for (const doc of docs) {
      progress = { ...progress, currentDocumentId: doc.id };
      try {
        const result = await indexDocumentById(doc.id);
        progress = { ...progress, chunksTotal: progress.chunksTotal + result.chunks };
      } catch (err) {
        progress = {
          ...progress,
          failed: progress.failed + 1,
          lastError: `文档 ${doc.id}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      progress = { ...progress, done: progress.done + 1 };
      await new Promise((resolve) => setTimeout(resolve, REINDEX_DELAY_MS));
    }
  } catch (err) {
    progress = { ...progress, lastError: err instanceof Error ? err.message : String(err) };
  } finally {
    progress = { ...progress, running: false, currentDocumentId: undefined, finishedAt: new Date().toISOString() };
  }
}
