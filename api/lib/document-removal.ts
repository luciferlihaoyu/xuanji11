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
 * 测试覆盖：deleteDocumentCascade / previewDocumentDeletion / purgeDocumentsCascade 均在
 * document-removal.test.ts 用真实内存 SQLite 兜回归；MCP 集成层另有一层。
 */
import { eq, and, inArray, or, count } from "drizzle-orm";
import { kbDocuments, documentChunks, kbDocumentVersions, kbIngestionKeys, knowledgeNodes, knowledgeEdges } from "@db/schema";
import { getDb } from "../queries/connection";
import { vectorEngine } from "./vector";
import { documentNodeMatch } from "./document-node-match";

export interface DocumentRemovalResult {
  deletedChunks: number;
  deletedVectors: number;
  deletedNodes: number;
  deletedEdges: number;
  /** 版本历史行数（kb_document_versions.documentId → kb_documents 有外键，不清就 FK 违反） */
  deletedVersions: number;
  /** 入库幂等键行数（kb_ingestion_keys.documentId → kb_documents 有外键） */
  deletedIngestionKeys: number;
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
        documentNodeMatch(id),
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
export interface PurgeManyResult {
  /** 成功彻底删除的文档数 */
  readonly purged: number;
  /** 未能删除的文档（不存在或抛错），逐条如实汇报，绝不静默吞掉 */
  readonly failed: ReadonlyArray<{ id: number; error: string }>;
  readonly deletedChunks: number;
  readonly deletedVectors: number;
  readonly deletedNodes: number;
  readonly deletedEdges: number;
  readonly deletedVersions: number;
  readonly deletedIngestionKeys: number;
}

/**
 * 批量彻底删除：**逐篇**走 `deleteDocumentCascade`（单一实现，避免各调用点各写一套漏清）。
 *
 * 为什么需要它：控制台的「彻底删除」与「文件夹删除」此前只清向量/chunks/FTS，漏了图谱节点与边，
 * 每次这类删除都留下孤儿（线上 2026-09-22 巡检到的 `graph_orphans` 即此来源）。
 *
 * 语义：单篇失败不中断其余（文件夹删除不能因为一篇异常就半途而废），
 * 但失败必须如实回报在 `failed` 里——调用方据此决定是否提示用户，不允许假装全部成功。
 */
export async function purgeDocumentsCascade(
  db: ReturnType<typeof getDb>,
  vectorEngineArg: typeof vectorEngine,
  ids: readonly number[],
): Promise<PurgeManyResult> {
  const failed: Array<{ id: number; error: string }> = [];
  let purged = 0;
  let deletedChunks = 0;
  let deletedVectors = 0;
  let deletedNodes = 0;
  let deletedEdges = 0;
  let deletedVersions = 0;
  let deletedIngestionKeys = 0;

  for (const id of ids) {
    try {
      const r = await deleteDocumentCascade(db, vectorEngineArg, id);
      purged += 1;
      deletedChunks += r.deletedChunks;
      deletedVectors += r.deletedVectors;
      deletedNodes += r.deletedNodes;
      deletedEdges += r.deletedEdges;
      deletedVersions += r.deletedVersions;
      deletedIngestionKeys += r.deletedIngestionKeys;
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { purged, failed, deletedChunks, deletedVectors, deletedNodes, deletedEdges, deletedVersions, deletedIngestionKeys };
}

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

  // 1b) 搜索缓存失效：混合检索结果有 60s 缓存，删除后必须立刻失效，否则会短期返回已删文档
  // （此前只在 kb-router 的两处入口手动调用，MCP document_delete 路径漏了；收进级联做单一出口）
  try {
    const { invalidateSearchCache } = await import("./hybrid-search");
    invalidateSearchCache();
  } catch { /* 缓存失效失败不阻塞删除主流程（最坏情况是 60s 内返回旧结果） */ }

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
          documentNodeMatch(id),
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

    // 3d) 指向本文档的子表行必须先清（线上真库有外键约束）：
    //     kb_document_versions.documentId、kb_ingestion_keys.documentId → kb_documents(id)。
    //     漏清就抛 "FOREIGN KEY constraint failed"（线上 2026-09-22 实测 500，被探针抓到）。
    const versionsResult = tx.delete(kbDocumentVersions).where(eq(kbDocumentVersions.documentId, id)).run();
    const deletedVersions = Number((versionsResult as { changes?: number }).changes ?? 0);
    const ingestResult = tx.delete(kbIngestionKeys).where(eq(kbIngestionKeys.documentId, id)).run();
    const deletedIngestionKeys = Number((ingestResult as { changes?: number }).changes ?? 0);

    // 3e) 最后删文档行
    tx.delete(kbDocuments).where(eq(kbDocuments.id, id)).run();

    return { deletedChunks, deletedEdges, deletedNodes, deletedVersions, deletedIngestionKeys };
  });

  // 3f) 事务提交后再失效一次缓存：删除前的失效挡不住「提交前插入的并发搜索把旧结果写回缓存」
  // （invalidateSearchCache 只是 map.clear()，双调零成本；60s TTL 内不再返回已删文档）
  try {
    const { invalidateSearchCache } = await import("./hybrid-search");
    invalidateSearchCache();
  } catch { /* 同上：best-effort，最坏 60s 陈旧 */ }

  return {
    deletedChunks: result.deletedChunks,
    deletedVersions: result.deletedVersions,
    deletedIngestionKeys: result.deletedIngestionKeys,
    deletedVectors,
    deletedNodes: result.deletedNodes,
    deletedEdges: result.deletedEdges,
  };
}
