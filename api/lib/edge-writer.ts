/**
 * 图谱边的唯一写入口（T4-01，2026-11-14 碧霄）。
 *
 * 规矩（PLAN v2 四期原文）：**宁可少边，不要无据之边** —— evidence.text
 * 缺省或 trim 后为空一律抛 EdgeEvidenceError 拒写，绝不静默放行。
 * 位置列（evidenceDocumentId / evidenceChunkId）best-effort 自动补位：
 * 调用方显式给 > 从 source/target 节点的 metadata.documentId 反查 >
 * 该文档 chunkIndex=0 的真主键。补不出位置不拦（巡检 edges_without_evidence
 * 只查 evidence 列；T3-04 判据第 11 项按 cutoff 点名新边）。
 *
 * evidenceChunkId 语义 = document_chunks.id 主键（**不是 chunkIndex**，二期定口径）。
 */
import { asc, eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { documentChunks, knowledgeEdges, knowledgeNodes, type InsertKnowledgeEdge } from "@db/schema";

export type EdgeType = NonNullable<InsertKnowledgeEdge["type"]>;

export const EVIDENCE_MAX_CHARS = 500;

export interface EdgeEvidence {
  /** 依据原文/声明理由（trim 后非空；入库截断 500 字） */
  readonly text: string;
  readonly documentId?: number | null;
  readonly chunkId?: number | null;
}

export interface EdgeWriteInput {
  readonly sourceId: number;
  readonly targetId: number;
  readonly type: EdgeType;
  readonly label?: string | null;
  readonly weight?: number | null;
  readonly createdBy?: number | null;
  /** T4-01 铁律在此运行时校验：缺省或 trim 空白一律拒写 */
  readonly evidence?: EdgeEvidence;
}

/**
 * db / tx 的公共客户端形态。刻意用宽松结构类型：drizzle 的
 * BetterSQLite3Database<SchemaWithRelations> 与同步事务 tx 都是其使用者，
 * 严格泛型在此只会把测试里的裸 drizzle(sqlite) 挡在门外——真正的形状保证
 * 由本文件 8 个钉死用例 + 调用点的静态类型共同兜住。
 */
export interface EdgeClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(...args: any[]): any;
}

export class EdgeEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeEvidenceError";
  }
}

/** 节点 → 文档 id（knowledge_nodes.metadata.documentId，两种历史形态都认） */
async function resolveNodeDocumentId(executor: EdgeClient, nodeId: number): Promise<number | null> {
  try {
    const [node] = await executor
      .select({ metadata: knowledgeNodes.metadata })
      .from(knowledgeNodes)
      .where(eq(knowledgeNodes.id, nodeId))
      .limit(1);
    const raw = (node?.metadata as Record<string, unknown> | null | undefined)?.documentId;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 文档首块（chunkIndex=0）的真主键；补位用，查不到就 NULL（不编造） */
async function firstChunkId(executor: EdgeClient, documentId: number): Promise<number | null> {
  try {
    const [chunk] = await executor
      .select({ id: documentChunks.id })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, documentId))
      .orderBy(asc(documentChunks.chunkIndex))
      .limit(1);
    return chunk?.id ?? null;
  } catch {
    return null;
  }
}

export async function insertEdge(
  input: EdgeWriteInput,
  executor: EdgeClient = getDb(),
): Promise<{ id: number }> {
  const ev = input.evidence;
  const text = ev?.text?.trim() ?? "";
  if (!text) {
    throw new EdgeEvidenceError(
      `写边被拒（T4-01 无据不写）：type=${input.type} ${input.sourceId}→${input.targetId} 缺少 evidence.text。` +
        `证据=这条边成立的依据摘录或声明理由，不是可选装饰。`,
    );
  }

  // 位置补位：显式 > source 文档 > target 文档
  let documentId = ev?.documentId ?? null;
  if (documentId === null) documentId = await resolveNodeDocumentId(executor, input.sourceId);
  if (documentId === null) documentId = await resolveNodeDocumentId(executor, input.targetId);

  let chunkId = ev?.chunkId ?? null;
  if (chunkId === null && documentId !== null) chunkId = await firstChunkId(executor, documentId);

  // 交叉一致性：给了 chunk 就必须属于某个文档；documentId 缺失时从 chunk 反查补
  if (chunkId !== null && documentId === null) {
    try {
      const [c] = await executor
        .select({ documentId: documentChunks.documentId })
        .from(documentChunks)
        .where(eq(documentChunks.id, chunkId))
        .limit(1);
      documentId = c?.documentId ?? null;
    } catch {
      /* 保持 null，诚实落库 */
    }
  }

  const result = await executor.insert(knowledgeEdges).values({
    sourceId: input.sourceId,
    targetId: input.targetId,
    label: input.label ?? null,
    type: input.type,
    weight: input.weight ?? 1,
    createdBy: input.createdBy ?? null,
    evidence: text.slice(0, EVIDENCE_MAX_CHARS),
    evidenceDocumentId: documentId,
    evidenceChunkId: chunkId,
  });
  return { id: Number((result as { lastInsertRowid: number | bigint }).lastInsertRowid) };
}

/**
 * 同步事务形态：auto-link 的 db.transaction 回调禁止 async，位置列必须由
 * 调用方在事务外备好（本函数不做任何反查补位，只做规矩校验+截断落库）。
 */
export function insertEdgeSync(input: EdgeWriteInput, tx: EdgeClient): { id: number } {
  const ev = input.evidence;
  const text = ev?.text?.trim() ?? "";
  if (!text) {
    throw new EdgeEvidenceError(
      `写边被拒（T4-01 无据不写）：type=${input.type} ${input.sourceId}→${input.targetId} 缺少 evidence.text。`,
    );
  }
  const result = tx
    .insert(knowledgeEdges)
    .values({
      sourceId: input.sourceId,
      targetId: input.targetId,
      label: input.label ?? null,
      type: input.type,
      weight: input.weight ?? 1,
      createdBy: input.createdBy ?? null,
      evidence: text.slice(0, EVIDENCE_MAX_CHARS),
      evidenceDocumentId: ev?.documentId ?? null,
      evidenceChunkId: ev?.chunkId ?? null,
    })
    .run();
  return { id: Number((result as { lastInsertRowid: number | bigint }).lastInsertRowid) };
}
