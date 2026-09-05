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
import { eq, and, inArray, or, sql } from "drizzle-orm";
import { kbDocuments, documentChunks, knowledgeNodes, knowledgeEdges } from "@db/schema";
import { getDb } from "../queries/connection";
import { vectorEngine } from "./vector";

export interface DocumentRemovalResult {
  deletedChunks: number;
  deletedVectors: number;
  deletedNodes: number;
  deletedEdges: number;
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

  // 3) SQL 事务：chunks → 图谱边 → 图谱节点 → 文档行
  const result = await db.transaction(async (tx) => {
    // 3a) document_chunks
    const chunksResult = await tx
      .delete(documentChunks)
      .where(eq(documentChunks.documentId, id));
    const deletedChunks = Number((chunksResult as { changes?: number }).changes ?? 0);

    // 3b) 查图谱节点（document 类型节点，metadata.documentId = id）
    const nodeRows = await tx
      .select({ id: knowledgeNodes.id })
      .from(knowledgeNodes)
      .where(
        and(
          eq(knowledgeNodes.type, "document"),
          sql`json_extract(${knowledgeNodes.metadata}, '$.documentId') = ${String(id)}`,
        ),
      );
    const nodeIds = nodeRows.map((row) => row.id);

    let deletedEdges = 0;
    let deletedNodes = 0;
    if (nodeIds.length > 0) {
      // 3c) 先删边（引用 nodeIds），再删节点
      const edgesResult = await tx
        .delete(knowledgeEdges)
        .where(
          or(
            inArray(knowledgeEdges.sourceId, nodeIds),
            inArray(knowledgeEdges.targetId, nodeIds),
          ),
        );
      deletedEdges = Number((edgesResult as { changes?: number }).changes ?? 0);

      const nodesResult = await tx
        .delete(knowledgeNodes)
        .where(inArray(knowledgeNodes.id, nodeIds));
      deletedNodes = Number((nodesResult as { changes?: number }).changes ?? 0);
    }

    // 3d) 最后删文档行
    await tx.delete(kbDocuments).where(eq(kbDocuments.id, id));

    return { deletedChunks, deletedEdges, deletedNodes };
  });

  return {
    deletedChunks: result.deletedChunks,
    deletedVectors,
    deletedNodes: result.deletedNodes,
    deletedEdges: result.deletedEdges,
  };
}
