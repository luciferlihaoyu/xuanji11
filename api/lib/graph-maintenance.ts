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
import { getDb, getRawDb } from "../queries/connection";

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


/**
 * T4-03 图谱一致性巡检（只报不修，2026-11-14 碧霄）。
 * 输出结构与 index-health 同款：issues[{kind,count,detail}] + healthy。
 * 五类判据：self_loop / duplicate_edge（同 source/target/type 多行）/
 * dangling_edge（端点节点不存在）/ namespace_mismatch（端点 id 属 kb_documents
 * 而非 knowledge_nodes——CA-234 历史 bug 形状）/ edges_without_evidence
 * （受 edge_evidence_cutoff_ms 门控，存量不追溯 R7）。
 * 分类互斥：namespace 与 dangling 同一行只计一边。
 */
export interface GraphIntegrityIssue {
  readonly kind: string;
  readonly count: number;
  readonly detail: string;
}
export interface GraphIntegrityResult {
  readonly healthy: boolean;
  readonly issues: GraphIntegrityIssue[];
}

export function auditGraphIntegrity(): GraphIntegrityResult {
  const raw = getRawDb();
  const issues: GraphIntegrityIssue[] = [];
  const q = (text: string) => raw.prepare(text).all() as Array<Record<string, number | string | null>>;

  try {
    // 1. self_loop
    const loops = q("SELECT COUNT(*) c FROM knowledge_edges WHERE sourceId = targetId");
    const loopN = Number(loops[0]?.c ?? 0);
    if (loopN > 0) {
      const ids = q("SELECT id FROM knowledge_edges WHERE sourceId = targetId LIMIT 5").map((r) => String(r.id)).join(",");
      issues.push({ kind: "self_loop", count: loopN, detail: `source=target 的自环边（id 例：${ids}），来源可疑，人工核查后删除` });
    }

    // 2. duplicate_edge：同三元组的冗余行数（每组 count-1 之和）
    const dups = q("SELECT sourceId s, targetId t, type ty, COUNT(*) c FROM knowledge_edges GROUP BY sourceId, targetId, type HAVING COUNT(*) > 1");
    if (dups.length > 0) {
      const redundant = dups.reduce((acc, r) => acc + Number(r.c) - 1, 0);
      issues.push({ kind: "duplicate_edge", count: redundant, detail: `${dups.length} 组重复三元组，共冗余 ${redundant} 行；保留最小 id 即可` });
    }

    // 3/4. namespace_mismatch 与 dangling_edge（互斥归类）
    const bad = q(`SELECT e.id id, e.sourceId s, e.targetId t,
        (SELECT COUNT(*) FROM knowledge_nodes n WHERE n.id = e.sourceId) sIsNode,
        (SELECT COUNT(*) FROM knowledge_nodes n WHERE n.id = e.targetId) tIsNode,
        (SELECT COUNT(*) FROM kb_documents d WHERE d.id = e.sourceId AND NOT EXISTS (SELECT 1 FROM knowledge_nodes n2 WHERE n2.id = e.sourceId)) sIsDocOnly,
        (SELECT COUNT(*) FROM kb_documents d WHERE d.id = e.targetId AND NOT EXISTS (SELECT 1 FROM knowledge_nodes n2 WHERE n2.id = e.targetId)) tIsDocOnly
      FROM knowledge_edges e
      WHERE sIsNode = 0 OR tIsNode = 0`);
    const nsRows = bad.filter((r) => Number(r.sIsDocOnly) > 0 || Number(r.tIsDocOnly) > 0);
    const dgRows = bad.filter((r) => Number(r.sIsDocOnly) === 0 && Number(r.tIsDocOnly) === 0);
    if (nsRows.length > 0) {
      issues.push({ kind: "namespace_mismatch", count: nsRows.length, detail: `端点 id 落在 kb_documents 而非 knowledge_nodes（边 id 例：${nsRows.slice(0, 5).map((r) => r.id).join(",")}）——CA-234 形状，边永远连不通` });
    }
    if (dgRows.length > 0) {
      issues.push({ kind: "dangling_edge", count: dgRows.length, detail: `端点节点不存在（边 id 例：${dgRows.slice(0, 5).map((r) => r.id).join(",")}），可剪` });
    }

    // 5. edges_without_evidence（cutoff 门控，与 index-health 判据 11 同口径）
    let cutoff: number | null = null;
    try {
      const row = raw.prepare("SELECT value FROM system_settings WHERE key = 'edge_evidence_cutoff_ms'").get() as { value: string } | undefined;
      const parsed = row ? Number(row.value) : NaN;
      cutoff = Number.isFinite(parsed) ? parsed : null;
    } catch {
      cutoff = null; // 无 settings 表 = 从未设过，静默
    }
    if (cutoff !== null) {
      const missing = q(`SELECT COUNT(*) c FROM knowledge_edges
        WHERE createdAt > ${cutoff} AND evidence IS NULL
          AND type IN ('references','contains','extends','sequence')`);
      const missN = Number(missing[0]?.c ?? 0);
      if (missN > 0) {
        issues.push({ kind: "edges_without_evidence", count: missN, detail: `cutoff(${cutoff}) 后新写的四类边缺证据——edge-writer 之外出现了旁路，立即排查写入点` });
      }
    }
  } catch (err) {
    // 表缺失（lite 库）：图谱链路未启用，如实静默
    console.warn("[graph-audit] 巡检降级：", (err as Error).message);
  }

  return { healthy: issues.length === 0, issues };
}
