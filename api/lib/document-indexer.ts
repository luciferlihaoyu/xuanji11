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
import { finishTask, isCancelRequested, updateTaskProgress } from "./task-registry";
import { decideReindexOutcome } from "./task-sync";

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

  // 先清 FTS（deleteDocumentFromFts 依赖 document_chunks 的 id 子查询，必须赶在删 chunks 之前）
  try {
    const { deleteDocumentFromFts } = await import("./fts-search");
    deleteDocumentFromFts(documentId);
  } catch { /* FTS 清理失败等下次 ensureFts 回填修正 */ }
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

  // 重索引 = 用新分块替换该文档的旧向量：先清掉旧行，
  // 否则分块数变少时会留下孤儿向量（旧 chunkIndex 的行没人再引用），
  // 且旧行会让 insertBatch 撞 meta.id 唯一索引（2026-09-19 线上整库回填全篇失败）
  await vectorEngine.deleteByDocumentId(documentId);

  // 真正 embed 每个 chunk（修复 R3 空壳：此前从不 embed/写入向量表）
  const chunkContents = chunks.map((content, index) => ({ content, index }));
  const vectors = await embedTextsWithFallback(chunkContents.map((c) => c.content));

  // 插入 document_chunks（embedding 列无人读取，不写大 JSON，向量只存 vec 表）
  const insertedChunks = await db.insert(documentChunks).values(chunkContents.map((c) => ({
    documentId,
    content: c.content,
    chunkIndex: c.index,
  }))).returning({ id: documentChunks.id, content: documentChunks.content });

  // 同步进 FTS5（混合检索的 BM25 路；失败不阻塞主流程）
  try {
    const { syncChunkToFts } = await import("./fts-search");
    for (const c of insertedChunks) syncChunkToFts(c.id, c.content);
  } catch { /* FTS 同步失败等下次 ensureFts 回填 */ }

  // 写入 vec 表（vec_chunks + vec_chunk_meta）
  // 记录 embedding 模型身份——模型版本巡检靠它发现「切换模型后未重建的旧向量」
  const { getLastEmbeddingIdentity } = await import("./vector-service");
  const identity = getLastEmbeddingIdentity();
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
        ...(identity
          ? { embeddingModel: identity.model, embeddingDim: identity.dimension }
          : {}),
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

/** P0-4：当前全量回填所属的任务句柄（取消信号与进度都挂在它上面） */
let activeTaskId: string | undefined;
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
export function startReindexAll(taskId?: string): ReindexProgress {
  if (progress.running) {
    // 已在运行（幂等）：**认领**而不是新起一个句柄——
    // 否则调用方拿到的句柄没人轮询，task_cancel 会 accepted:true 却毫无效果。
    if (taskId && !activeTaskId) activeTaskId = taskId;
    return getReindexProgress();
  }
  progress = { ...idleProgress, running: true, startedAt: new Date().toISOString() };
  activeTaskId = taskId;
  void runReindexAll();
  return getReindexProgress();
}

/**
 * 当前全量回填正在使用的任务句柄（无则 undefined）。
 * 调用方据此复用/认领句柄，避免出现「孤儿句柄」。
 */
export function getActiveReindexTaskId(): string | undefined {
  return activeTaskId;
}

async function runReindexAll(): Promise<void> {
  let cancelled = false;
  // 注意：每轮都读模块态 activeTaskId，这样「运行中才认领的句柄」也能收到取消信号与进度
  const currentTaskId = () => activeTaskId;
  try {
    // 启动前异步校准向量表维度（修复 R3 维度不匹配导致 0 条向量的 bug）
    const { ensureCorrectDimension } = await import("./vector-service");
    await ensureCorrectDimension();
    const db = getDb();
    const docs = await db.select({ id: kbDocuments.id }).from(kbDocuments).where(isNotNull(kbDocuments.content));
    progress = { ...progress, total: docs.length };
    for (const doc of docs) {
      // P0-4 取消点：文档之间响应取消请求（已索引的文档保持有效，随时可续跑）
      const tid = currentTaskId();
      if (tid && isCancelRequested(tid)) {
        cancelled = true;
        break;
      }
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
      if (tid) {
        updateTaskProgress(tid, progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0, {
          total: progress.total,
          done: progress.done,
          failed: progress.failed,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, REINDEX_DELAY_MS));
    }
  } catch (err) {
    progress = { ...progress, lastError: err instanceof Error ? err.message : String(err) };
  } finally {
    progress = { ...progress, running: false, currentDocumentId: undefined, finishedAt: new Date().toISOString() };
    const tid = currentTaskId();
    if (tid) {
      // 终态判定单点化（审查 Q2）：与 task_get 的读时收口共用同一函数，杜绝同一事实两个终态
      const outcome = decideReindexOutcome({
        running: false,
        total: progress.total,
        done: progress.done,
        failed: progress.failed,
        lastError: progress.lastError,
        cancelled,
        startedAt: progress.startedAt,
      });
      finishTask(tid, outcome.status, { progress: outcome.progress, error: outcome.error, meta: { ...outcome.meta, chunksTotal: progress.chunksTotal } });
    }
    activeTaskId = undefined;
  }
}
