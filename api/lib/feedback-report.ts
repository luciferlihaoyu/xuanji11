/**
 * 反馈评估：从已有数据源统计用户纠正行为，形成调参依据。
 *
 * 数据源（不新建表，复用现有）：
 * - audit_logs 里 entityType=knowledge_edge action=delete → 删边反馈
 * - kb_review_items 的 approved/rejected → 分拣/去重判断准确率
 * - index-health 的 issues → 索引健康趋势
 *
 * 输出一份反馈报告，供调阈值/权重参考。
 */
import { getRawDb } from "../queries/connection";

export interface FeedbackReport {
  generatedAt: string;
  /** 删边反馈：自动边被删的比例（质量代理指标） */
  edgeFeedback: {
    totalAutoEdges: number;
    deletedEdges: number;
    deletionRate: number;
    recentDeletions: number; // 近 7 天
  };
  /** 收件箱判断：approve/reject 比例 */
  reviewStats: {
    totalResolved: number;
    approved: number;
    rejected: number;
    ignored: number;
    approvalRate: number;
    byKind: Record<string, { approved: number; rejected: number; total: number }>;
  };
  /** 低置信度分拣的人工纠正率 */
  triageAccuracy: {
    total: number;
    approved: number;
    accuracy: number; // approved/total，高说明启发式置信度校准合理
  };
  /** 搜索行为：点击/问答事件（近 30 天） */
  searchStats: {
    clicks: number;
    asks: number;
    topQueries: Array<{ query: string; count: number }>;
    topDocs: Array<{ documentId: number; count: number }>;
  };
}

export function generateFeedbackReport(): FeedbackReport {
  const db = getRawDb();
  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;

  // 删边反馈（auto-link 建的边 type='similar'）
  const totalAutoEdges = count("SELECT COUNT(*) c FROM knowledge_edges WHERE type = 'similar'");
  const deletedEdges = count(
    "SELECT COUNT(*) c FROM audit_logs WHERE entityType = 'knowledge_edge' AND action = 'delete'"
  );
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recentDeletions = count(
    "SELECT COUNT(*) c FROM audit_logs WHERE entityType = 'knowledge_edge' AND action = 'delete' AND createdAt > ?",
    weekAgo
  );

  // 收件箱统计
  const reviewRows = db.prepare(`
    SELECT kind, status, COUNT(*) c FROM kb_review_items
    WHERE status != 'pending'
    GROUP BY kind, status
  `).all() as Array<{ kind: string; status: string; c: number }>;

  const byKind: Record<string, { approved: number; rejected: number; total: number }> = {};
  let totalResolved = 0, approved = 0, rejected = 0, ignored = 0;
  for (const row of reviewRows) {
    totalResolved += row.c;
    if (row.status === "approved") approved += row.c;
    else if (row.status === "rejected") rejected += row.c;
    else if (row.status === "ignored") ignored += row.c;

    const k = byKind[row.kind] ?? { approved: 0, rejected: 0, total: 0 };
    if (row.status === "approved") k.approved += row.c;
    if (row.status === "rejected") k.rejected += row.c;
    k.total += row.c;
    byKind[row.kind] = k;
  }

  // 分拣准确率
  const triageTotal = count("SELECT COUNT(*) c FROM kb_review_items WHERE kind = 'triage' AND status != 'pending'");
  const triageApproved = count("SELECT COUNT(*) c FROM kb_review_items WHERE kind = 'triage' AND status = 'approved'");

  // 搜索行为（近 30 天）
  const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
  const clicks = count("SELECT COUNT(*) c FROM kb_search_events WHERE event = 'click' AND createdAt > ?", monthAgo);
  const asks = count("SELECT COUNT(*) c FROM kb_search_events WHERE event = 'ask' AND createdAt > ?", monthAgo);
  const topQueries = db.prepare(`
    SELECT query, COUNT(*) count FROM kb_search_events
    WHERE createdAt > ? GROUP BY query ORDER BY count DESC LIMIT 5
  `).all(monthAgo) as Array<{ query: string; count: number }>;
  const topDocs = db.prepare(`
    SELECT documentId, COUNT(*) count FROM kb_search_events
    WHERE event = 'click' AND documentId IS NOT NULL AND createdAt > ?
    GROUP BY documentId ORDER BY count DESC LIMIT 5
  `).all(monthAgo) as Array<{ documentId: number; count: number }>;

  return {
    generatedAt: new Date().toISOString(),
    edgeFeedback: {
      totalAutoEdges,
      deletedEdges,
      deletionRate: totalAutoEdges > 0 ? Math.round((deletedEdges / (totalAutoEdges + deletedEdges)) * 1000) / 1000 : 0,
      recentDeletions,
    },
    reviewStats: {
      totalResolved,
      approved,
      rejected,
      ignored,
      approvalRate: totalResolved > 0 ? Math.round((approved / totalResolved) * 1000) / 1000 : 0,
      byKind,
    },
    triageAccuracy: {
      total: triageTotal,
      approved: triageApproved,
      accuracy: triageTotal > 0 ? Math.round((triageApproved / triageTotal) * 1000) / 1000 : 0,
    },
    searchStats: { clicks, asks, topQueries, topDocs },
  };
}
