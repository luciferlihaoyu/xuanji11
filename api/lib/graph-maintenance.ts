/**
 * 知识图谱孤儿清理
 *
 * 孤儿定义与每日巡检（index-health 的 `graph_orphans`）**严格同源**：
 * `knowledge_nodes.type='document'` 且 `metadata.documentId` 指向的文档已不存在。
 *
 * 为什么会有孤儿：MCP `document_delete` 走 `deleteDocumentCascade`（连图谱一起清），
 * 但控制台的 `kb.purgeDocument`（彻底删除）与**文件夹删除**此前只清向量/chunks/FTS，
 * 漏掉图谱节点与边 → 每次这类删除都留下孤儿节点（线上 2026-09-22 实测到 1 个，
 * 且这类泄漏也是历史 FTS 孤儿那一族问题的同源产物）。
 * 两条路径已改为统一走级联；本模块负责把**存量**孤儿清干净，并作为长期维护动作保留。
 *
 * 口径细节：`documentId` 缺失（NULL）的 document 节点**不算孤儿**——
 * `NULL NOT IN (...)` 结果非真，巡检也不计；这类节点是历史/其他来源建的，删了会误伤。
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { knowledgeEdges, knowledgeNodes } from "@db/schema";
import { getDb } from "../queries/connection";

export interface GraphOrphanPruneResult {
  /** 命中孤儿节点数（与巡检同口径） */
  readonly orphans: number;
  /** 牵连到这些节点上的边数（两端任一命中） */
  readonly edges: number;
  /** 实际删除的节点数（dryRun 与无孤儿时恒为 0） */
  readonly prunedNodes: number;
  /** 实际删除的边数（dryRun 与无孤儿时恒为 0） */
  readonly prunedEdges: number;
}

/** 孤儿节点的统一判据（与该模块文件头注释的口径一致，改这里就等于改巡检对不上的口径——别乱改） */
const orphanCondition = sql`CAST(json_extract(${knowledgeNodes.metadata}, '$.documentId') AS INTEGER) NOT IN (SELECT id FROM kb_documents)`;

/**
 * 清理图谱孤儿节点及其牵连边。
 *
 * @param opts.dryRun 只报数不删（破坏性操作的统一约定）
 */
export function pruneGraphOrphans(opts: { dryRun?: boolean } = {}): GraphOrphanPruneResult {
  const db = getDb();
  const nodeRows = db
    .select({ id: knowledgeNodes.id })
    .from(knowledgeNodes)
    .where(and(eq(knowledgeNodes.type, "document"), orphanCondition))
    .all();
  const nodeIds = nodeRows.map((r) => r.id);
  if (nodeIds.length === 0) return { orphans: 0, edges: 0, prunedNodes: 0, prunedEdges: 0 };

  // 牵连边：两端任一命中孤儿节点。先删边再删节点，避免留下悬挂边。
  const edgeCondition = or(
    inArray(knowledgeEdges.sourceId, nodeIds),
    inArray(knowledgeEdges.targetId, nodeIds),
  );
  const edgeCount = db
    .select({ id: knowledgeEdges.id })
    .from(knowledgeEdges)
    .where(edgeCondition)
    .all().length;

  if (opts.dryRun) {
    return { orphans: nodeIds.length, edges: edgeCount, prunedNodes: 0, prunedEdges: 0 };
  }

  // better-sqlite3 驱动下事务回调必须同步（async 会抛 Transaction function cannot return a promise）
  const result = db.transaction((tx) => {
    const e = tx.delete(knowledgeEdges).where(edgeCondition).run();
    const n = tx.delete(knowledgeNodes).where(inArray(knowledgeNodes.id, nodeIds)).run();
    return {
      edges: Number((e as { changes?: number }).changes ?? 0),
      nodes: Number((n as { changes?: number }).changes ?? 0),
    };
  });

  return { orphans: nodeIds.length, edges: edgeCount, prunedNodes: result.nodes, prunedEdges: result.edges };
}
