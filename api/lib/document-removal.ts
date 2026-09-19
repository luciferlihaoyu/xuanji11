/**
 * 知识库文档级联删除
 *
 * 删除顺序（严格）：
 *   1. 校验文档存在 → 不存在抛 `Document not found: <id>`
 *   2. 先删向量（vectorEngine.deleteByDocumentId 内部自事务）：
 *      按 vec_chunk_meta 的 rowid 精确清 vec_chunks + vec_chunk_meta，
 *      先于 SQL 事务执行保证：失败时可幂等重试、不留孤儿向量
 *   3. 进入 SQL 事务（documentChunks → knowledgeEdges → knowledgeNodes → kbDocuments）
 *
 * 为什么不放在同一个事务里？vectorEngine.deleteByDocumentId 内部已用
 * better-sqlite3 raw transaction 自管理；如果再外包一层 drizzle transaction，
 * 同连接上的嵌套事务在 better-sqlite3 同步驱动下会冲突（SAVEPOINT
 * 与 BEGIN 混用风险），且向量引擎自己 rollback 不会污染 SQL 事务。
 * 分两步执行让两边各管各的失败语义。
 *
 * 测试覆盖：MCP 集成层跑，单测不做（不在本文件加自检）。
 */
import { eq, and, inArray, or, sql, count } from "drizzle-orm";
import { kbDocuments, documentChunks, knowledgeNodes, knowledgeEdges } from "@db/schema";
import { getDb } from "../queries/connection";
import { vectorEngine } from "./vector";

export interface DocumentRemovalResult {
  deletedChunks: number;
  deletedVectors: number;
  deletedNodes: number;
  deletedEdges: number;
}

/** 破坏性操作 dryRun 的预览结果：只报数，不代表已执行 */
export interface DocumentDeletionPreview {
  readonly id: number;
  readonly title: string;
  readonly format: string;
  readonly folderId: number | null;
  readonly wouldDelete: {
    readonly chunks: number;
    readonly vectors: number;
    readonly graphNodes: number;
    readonly graphEdges: number;
  };
}

/**
 * 预览级联删除的影响面（**绝不修改任何数据**）。
 *
 * 各计数口径与 deleteDocumentCascade 严格同源：chunks 取 document_chunks.documentId；
 * 图谱节点取 type='document' 且 metadata.documentId=id（与删除侧同一条件）；
 * 边取「两端命中这些节点 id」的条数；向量数由向量引擎 countByDocumentId 真实统计
 * （不猜、不用 chunks 数近似）。文档不存在时与删除侧同口径抛 Document not found。
 */
export async function previewDocumentDeletion(
  db: ReturnType<typeof getDb>,
  vectorEngineArg: typeof vectorEngine,
  id: number,
): Promise<DocumentDeletionPreview> {
  const documents = await db
    .select({
      id: kbDocuments.id,
      title: kbDocuments.title,
      format: kbDocuments.format,
      folderId: kbDocuments.folderId,
    })
    .from(kbDocuments)
    .where(eq(kbDocuments.id, id))
    .limit(1);
  const doc = documents[0];
  if (!doc) throw new Error(`Document not found: ${id}`);

  const chunkCountRows = await db
    .select({ n: count() })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, id));
  const chunks = Number(chunkCountRows[0]?.n ?? 0);

  const nodeRows = await db
    .select({ id: knowledgeNodes.id })
    .from(knowledgeNodes)
    .where(
      and(
        eq(knowledgeNodes.type, "document"),
        sql`json_extract(${knowledgeNodes.metadata}, '$.documentId') = ${String(id)}`,
      ),
    );
  const nodeIds = nodeRows.map((row) => row.id);
  let graphEdges = 0;
  if (nodeIds.length > 0) {
    const edgeCountRows = await db
      .select({ n: count() })
      .from(knowledgeEdges)
      .where(or(inArray(knowledgeEdges.sourceId, nodeIds), inArray(knowledgeEdges.targetId, nodeIds)));
    graphEdges = Number(edgeCountRows[0]?.n ?? 0);
  }

  const vectors = await vectorEngineArg.countByDocumentId(id);
  return {
    id,
    title: doc.title,
    format: doc.format,
    folderId: doc.folderId ?? null,
    wouldDelete: { chunks, vectors, graphNodes: nodeIds.length, graphEdges },
  };
}

/**
 * 级联删除知识库文档：向量 → chunks → 知识图谱节点/边 → 文档行。
 *
 * @param db drizzle Db 实例（getDb() 返回值）
 * @param vectorEngine 抽象 VectorEngine（来自 ./vector 转发到 vector-service）
 * @param id 知识库文档主键
 * @returns 各表实际删除行数
 * @throws 文档不存在时抛 `Error("Document not found: <id>")`
 */
export async function deleteDocumentCascade(
  db: ReturnType<typeof getDb>,
  vectorEngineArg: typeof vectorEngine,
  id: number,
): Promise<DocumentRemovalResult> {
  // 1) 文档存在性校验
  const existing = await db.select({ id: kbDocuments.id }).from(kbDocuments).where(eq(kbDocuments.id, id)).limit(1);
  if (existing.length === 0) {
    throw new Error(`Document not found: ${id}`);
  }

  // 2) 先删向量（内部事务；按 rowid 精确清，幂等）
  const deletedVectors = await vectorEngineArg.deleteByDocumentId(id);

  // 2b) 清 FTS5 记录（混合检索 BM25 路；ftsReady=false 时跳过等回填）
  try {
    const { deleteDocumentFromFts } = await import("./fts-search");
    deleteDocumentFromFts(id);
  } catch { /* FTS 清理失败不阻塞删除主流程 */ }

  // 3) SQL 事务：chunks → 图谱边 → 图谱节点 → 文档行
  // 注意：drizzle-orm/better-sqlite3 的 db.transaction 把回调直接传给
  // better-sqlite3 的 client.transaction()，后者要求回调【同步执行】——
  // 传 async 回调会抛 "Transaction function cannot return a promise"。
  // better-sqlite3 驱动下 tx.delete/select 均同步返回，直接写同步代码。
  const result = db.transaction((tx) => {
    // 3a) document_chunks
    const chunksResult = tx
      .delete(documentChunks)
      .where(eq(documentChunks.documentId, id))
      .run();
    const deletedChunks = Number((chunksResult as { changes?: number }).changes ?? 0);

    // 3b) 查图谱节点（document 类型节点，metadata.documentId = id）
    const nodeRows: Array<{ id: number }> = tx
      .select({ id: knowledgeNodes.id })
      .from(knowledgeNodes)
      .where(
        and(
          eq(knowledgeNodes.type, "document"),
          sql`json_extract(${knowledgeNodes.metadata}, '$.documentId') = ${String(id)}`,
        ),
      )
      .all();
    const nodeIds = nodeRows.map((row) => row.id);

    let deletedEdges = 0;
    let deletedNodes = 0;
    if (nodeIds.length > 0) {
      // 3c) 先删边（引用 nodeIds），再删节点
      const edgesResult = tx
        .delete(knowledgeEdges)
        .where(
          or(
            inArray(knowledgeEdges.sourceId, nodeIds),
            inArray(knowledgeEdges.targetId, nodeIds),
          ),
        )
        .run();
      deletedEdges = Number((edgesResult as { changes?: number }).changes ?? 0);

      const nodesResult = tx
        .delete(knowledgeNodes)
        .where(inArray(knowledgeNodes.id, nodeIds))
        .run();
      deletedNodes = Number((nodesResult as { changes?: number }).changes ?? 0);
    }

    // 3d) 最后删文档行
    tx.delete(kbDocuments).where(eq(kbDocuments.id, id)).run();

    return { deletedChunks, deletedEdges, deletedNodes };
  });

  return {
    deletedChunks: result.deletedChunks,
    deletedVectors,
    deletedNodes: result.deletedNodes,
    deletedEdges: result.deletedEdges,
  };
}
