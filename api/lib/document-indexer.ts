/**
 * 文档索引器 — 知识库文档 → 分块 → document_chunks 表 → ZVec 向量索引
 *
 * 所有文档写入路径（kb-router / MCP document_write / 批量回填）共用此模块，
 * 保证任何路径写入的文档都会被向量化。写入方应使用 tryIndexDocumentById，
 * 索引失败不影响文档本身的写入成功。
 */

import { eq, isNotNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb, getRawDb } from "../queries/connection";
import { kbDocuments, documentChunks } from "@db/schema";
import { buildSectionPath } from "./section-path";
import { vectorEngine } from "./vector";
import { embedTextsWithOutcome, ensureCorrectDimension } from "./vector-service";
import { finishTask, isCancelRequested, updateTaskProgress } from "./task-registry";
import { decideReindexOutcome } from "./task-sync";

/** 块内容溯源指纹：sha256 前 16 hex（T2-03；幂等键与引用校验共用，稳定不随机） */
function sha256Hex16(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/** 带来源偏移的块：content 是 trim 后文本，[start, end) 是它在 normalized 文本中的码元区间 */
export interface ChunkWithOffset {
  content: string;
  start: number;
  end: number;
}

/**
 * T2-01：切块同时给出 [charStart, charEnd)（UTF-16 码元，基于 normalized 文本
 * `text.replace(/\r\n/g,"\n").trim()`）。不变式：`normalized.slice(start, end) === content`。
 * chunkText 是本函数的映射（单一实现，防两套口径漂移）；二期回填与引用锚点都吃这里。
 */
export function chunkTextWithOffsets(text: string, maxChars = 800, overlap = 100): ChunkWithOffset[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized ? [{ content: normalized, start: 0, end: normalized.length }] : [];
  const chunks: ChunkWithOffset[] = [];
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
    // T1-01 修复：切点不得劈开 UTF-16 代理对。守卫两个边界（生产 3 条坏块的两种成因形状，
    // doc 1995 trace 实证）：
    // ① slice 开头孤立低代理 —— overlap 窗口起点恰落在某 emoji 的低代理上（该 emoji 已
    //    完整出现在上一块内），本块开头就是孤立低代理；切掉它（内容不丢失，上一块有完整副本）。
    // ② slice 末尾孤立高代理 —— 满窗切点或 lastBreak 截断点落在高代理上（其配对低代理在
    //    切片之外）；回退一个码元。
    // 两种孤立代理写入 SQLite 都会变 U+FFFD。
    // 游标推进口径（slice.length - overlap，trim 前长度）刻意保持不变：二期历史回填
    // 依赖「重切 = 现存块逐字一致」，只有劈裂边界这一刀的行为发生变化。
    let guardCut = 0;
    if (slice.length > 0) {
      const first = slice.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) { slice = slice.slice(1); guardCut = 1; }
      if (slice.length > 0) {
        const last = slice.charCodeAt(slice.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
      }
    }
    const content = slice.trim();
    // 偏移按 trim 后边界计：窗口起点 + guard 切掉的开头低代理 + trimStart 前导空白；
    // end = start + content.length（末尾高代理回退已反映在 content 长度里，无需另算）
    const contentStart = start + guardCut + (slice.length - slice.trimStart().length);
    chunks.push({ content, start: contentStart, end: contentStart + content.length });
    // 修复「尾块退化」：原实现是 start += Math.max(slice.length - overlap, 1)。
    // 当文档尾部剩余 ≤ overlap 时 slice.length - overlap ≤ 0，Math.max 兜底成 1，
    // 游标每轮只前进 1 个字符，于是把尾部每一个后缀都当独立 chunk 吐出
    // （100→99→…→1 字符的递减垃圾块）——生产库 93.5% 的 <100 字符碎块即源于此，
    // 向量库被灌水导致 hybrid 检索暴力 KNN 全扫、贴 50s 超时线。
    // 本窗口已覆盖到文本末尾（end >= length），或尾块不足一个重叠窗（游标无法有效
    // 前进）时，尾块已完整推出，必须立即终止循环，而不是 +1 继续退化。
    if (end >= normalized.length || slice.length <= overlap) break;
    start += slice.length - overlap;
  }
  return chunks.filter((c) => c.content.length > 0);
}

/** 纯内容口径（历史签名保持不变）：chunkTextWithOffsets 的映射，单一实现 */
export function chunkText(text: string, maxChars = 800, overlap = 100): string[] {
  return chunkTextWithOffsets(text, maxChars, overlap).map((c) => c.content);
}

export interface IndexDocumentResult {
  readonly chunks: number;
  /** true 表示文档无内容或为空，仅做了清理 */
  readonly skipped: boolean;
  /** 索引失败时的原因（skipped=true 且 failed=true 时有值）——区分"空文档"与"真失败" */
  readonly error?: string;
  /** true = 索引真失败（不是"文档本来就是空的"） */
  readonly failed?: boolean;
}

/** 清空某文档的旧索引产物（FTS 行 + chunks 行 + 向量）。
 *  只在**确定要重写**时调用——先删后写，一旦后续失败就会净损失既有索引。 */
async function clearDocumentIndex(documentId: number): Promise<void> {
  const db = getDb();
  const raw = getRawDb();
  // P2 根治（碧霄 2026-11-14）：FTS 行与 chunks 行**同生共死**。
  // 旧形：deleteDocumentFromFts 炸了只 warn 吞掉、chunks 照删——FTS 行成永久孤儿
  // （reindexDocument 每篇残留 0.8 条的源头，AGENTS.md 待派单根治项）。
  // 新形：先把 id 拿到手（之后 chunks 删了子查询就找不到它们了），再在一个事务里
  // 删两边；FTS 炸 → 整体回滚 → 调用方看见失败，索引产物原样可重试，零孤儿。
  const rows = await db
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, documentId));
  const chunkIds = rows.map((r) => Number(r.id));
  const { deleteChunksFromFtsByIds } = await import("./fts-search");
  raw.transaction(() => {
    deleteChunksFromFtsByIds(chunkIds);
    db.delete(documentChunks).where(eq(documentChunks.documentId, documentId)).run();
  })();
  await vectorEngine.deleteByDocumentId(documentId);
}

/**
 * 合并式更新文档 metadata：**先读最新行再合并**，不拿入口处的快照覆盖。
 * （评审 S2：embed 是网络调用，窗口内别的写入（如 MCP document_write）若被
 *   入口快照整块覆盖回旧值，就是一次静默的 lost update。）
 */
async function mergeDocumentMetadata(
  documentId: number,
  patch: { vectorized?: boolean; embeddingDegraded?: boolean },
): Promise<void> {
  const db = getDb();
  const [latest] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, documentId));
  if (!latest) return;
  await db.update(kbDocuments)
    .set({ metadata: { ...(latest.metadata ?? {}), ...patch } })
    .where(eq(kbDocuments.id, documentId));
}

/**
 * 重建单个文档的向量索引：清理旧分块和旧向量 → 分块 → 写 document_chunks → 写 ZVec。
 * 失败会抛错，调用方根据需要选择 tryIndexDocumentById 兜底。
 */
export async function indexDocumentById(documentId: number): Promise<IndexDocumentResult> {
  const db = getDb();
  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, documentId));
  if (!doc) throw new Error(`文档不存在: ${documentId}`);

  // T2-03：与 chunkTextWithOffsets 完全同口径的 normalized 文本（\r\n→\n + trim），
  // 供 buildSectionPath 的 offset 定位（不同口径的 offset 会错位——doc 1995 教训）。
  const content = (doc.content ?? "").replace(/\r\n/g, "\n").trim();
  // 带偏移切块（chunkTextWithOffsets），charStart/charEnd/sectionPath/contentHash 随块写入
  const chunksWithOffsets = content.length === 0 ? [] : chunkTextWithOffsets(content);
  const chunks = chunksWithOffsets.map((c) => c.content);

  // 空文档：没有可索引内容，把旧索引产物清干净即可（这里没有"降级"概念）
  if (chunks.length === 0) {
    await clearDocumentIndex(documentId);
    return { chunks: 0, skipped: true };
  }

  // 校准向量表维度（确保用 system_settings 的真实 dim 建表，否则 insertBatch 维度检查会静默跳过）
  await ensureCorrectDimension();

  // 真正 embed 每个 chunk（修复 R3 空壳：此前从不 embed/写入向量表）
  // 真正 embed 每个 chunk（修复 R3 空壳：此前从不 embed/写入向量表）
  // chunkContents 携带来源偏移与章节路径（T2-03），insert 时一并写入 document_chunks
  const chunkContents = chunksWithOffsets.map((c, index) => ({ ...c, index }));  // 身份随本次调用的结果一起返回（评审 B2）：不读进程级单例，避免并发下被别的
  // 嵌入调用（语义检索等）覆盖，导致"好向量当降级丢"或"伪向量当真向量写"。
  const outcome = await embedTextsWithOutcome(chunkContents.map((c) => c.content));

  // ==== 事故防线（2026-09-21 复盘）· 2026-11-11 评审 B1 修正位置 ====
  // 判定必须发生在**任何破坏性写之前**。早先版本把守卫放在 deleteByDocumentId 之后，
  // 于是嵌入服务一挂：旧的真向量已被删光 → 守卫抛错 → 新向量一条不写，
  // 「重建索引」在故障期会把整库向量索引清空（比写入伪向量更糟，是净损失）。
  // 现在降级路径**不动任何既有索引产物**：旧 chunks / FTS / 向量原样保留，
  // 只做两件事——把降级标记如实写进 metadata，然后抛错让调用方看见。
  if (outcome.degraded) {
    await mergeDocumentMetadata(documentId, { vectorized: false, embeddingDegraded: true });
    throw new Error("嵌入服务不可用：已拒绝写入 hash 伪向量（文档既有索引保持不变，可稍后重建）");
  }

  // 到这里才确认是真嵌入成功 → 现在才可以动旧索引产物
  // （先清后写，同时清掉旧行才能避免分块数变少时留下孤儿向量，旧 chunkIndex 无人引用）
  await clearDocumentIndex(documentId);

  // 插入 document_chunks（embedding 列无人读取，不写大 JSON，向量只存 vec 表）
  // T2-03：位置元数据随块写入（charStart/charEnd/sectionPath/contentHash；页码列无 PDF 入口恒不写 = NULL）
  const insertedChunks = await db.insert(documentChunks).values(chunkContents.map((c) => ({
    documentId,
    content: c.content,
    chunkIndex: c.index,
    charStart: c.start,
    charEnd: c.end,
    sectionPath: buildSectionPath(content, c.end),
    // sectionPath 口径：块**末尾**（c.end）之前的标题层级 —— 块自带标题（块0 从 0 开始）
    // 也能取到自己开头的标题行；纯正文块取到前文全部标题。c.start<=0 会漏掉块内标题。
    contentHash: sha256Hex16(c.content),
  }))).returning({ id: documentChunks.id, content: documentChunks.content });

  // 同步进 FTS5（混合检索的 BM25 路；失败不阻塞主流程）
  try {
    const { syncChunkToFts } = await import("./fts-search");
    for (const c of insertedChunks) syncChunkToFts(c.id, c.content);
  } catch { /* FTS 同步失败等下次 ensureFts 回填 */ }

  // 写入 vec 表（vec_chunks + vec_chunk_meta）
  // insertBatch 对维度不匹配会**抛错**（评审 S1：原先静默 continue → 0 向量却写 vectorized:true）
  await vectorEngine.insertBatch(
    chunkContents.map((c, index) => ({
      id: `chunk-${documentId}-${c.index}`,
      vector: outcome.vectors[index] ?? [],
      metadata: {
        documentId: String(documentId),
        chunkIndex: c.index,
        content: c.content,
        title: doc.title,
        format: doc.format,
        ...(outcome.identity
          ? { embeddingModel: outcome.identity.model, embeddingDim: outcome.identity.dimension }
          : {}),
      },
    })),
  );

  // 真索引成功：vectorized=true，并**清掉历史遗留的降级标记**（评审 D：
  // 标记若永不清除，嵌入服务恢复后文档仍自称降级，属反向失真）
  await mergeDocumentMetadata(documentId, { vectorized: true, embeddingDegraded: false });

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
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[DocumentIndexer] Failed to index document ${documentId}:`,
      message,
    );
    // 三态可辨（评审 S5）：failed=true 是"真失败"（如嵌入降级），
    // skipped=true 且无 failed 是"文档本来就是空的"。调用方据此决定要不要如实回报失败。
    return { chunks: 0, skipped: true, failed: true, error: message };
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
