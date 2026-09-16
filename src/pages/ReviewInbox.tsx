/**
 * 审核收件箱：所有待人工确认事项的统一入口。
 * 分拣建议 / 疑似重复 / 质量异常 / 索引失败 / 自动动作。
 */
import { useState } from 'react';
import { trpc } from '@/providers/trpc';
import { CheckCircle2, XCircle, EyeOff, Inbox, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';

const KIND_LABEL: Record<string, { label: string; color: string }> = {
  triage: { label: '分拣建议', color: '#22d3ee' },
  dedup: { label: '疑似重复', color: '#f472b6' },
  quality: { label: '质量异常', color: '#facc15' },
  index_failure: { label: '索引失败', color: '#ef4444' },
  auto_action: { label: '自动动作', color: '#a78bfa' },
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  approved: '已通过',
  rejected: '已驳回',
  ignored: '已忽略',
};

export default function ReviewInbox() {
  const [kindFilter, setKindFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'ignored'>('pending');

  const listQuery = trpc.review.list.useQuery({
    status: statusFilter,
    ...(kindFilter ? { kind: kindFilter as 'triage' | 'dedup' | 'quality' | 'index_failure' | 'auto_action' } : {}),
    limit: 100,
  });
  const countsQuery = trpc.review.counts.useQuery();
  const feedbackQuery = trpc.review.feedbackReport.useQuery(undefined, { staleTime: 60_000 });
  const [showFeedback, setShowFeedback] = useState(false);
  const utils = trpc.useUtils();

  const resolveMutation = trpc.review.resolve.useMutation({
    onSuccess: () => {
      utils.review.list.invalidate();
      utils.review.counts.invalidate();
    },
  });

  const pendingCount = (countsQuery.data ?? [])
    .filter((r) => r.status === 'pending')
    .reduce((sum, r) => sum + Number(r.c), 0);

  const items = listQuery.data ?? [];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
        <Inbox className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} />
        <h1 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          审核收件箱
        </h1>
        {pendingCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full"
            style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
            {pendingCount} 待处理
          </span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}
            className="h-8 px-3 rounded border text-xs outline-none"
            style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
            <option value="">全部类型</option>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="h-8 px-3 rounded border text-xs outline-none"
            style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button onClick={() => setShowFeedback(!showFeedback)}
            className="text-xs px-2.5 py-1.5 rounded transition-colors"
            style={{ backgroundColor: showFeedback ? 'rgba(167,139,250,0.15)' : 'var(--bg-tertiary)', color: showFeedback ? '#a78bfa' : 'var(--text-muted)' }}>
            反馈报告
          </button>
          <button onClick={() => listQuery.refetch()}
            className="p-2 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }} title="刷新">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 反馈评估报告 */}
      {showFeedback && feedbackQuery.data && (
        <div className="mx-2 sm:mx-4 mt-3 rounded-lg border p-4 shrink-0"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'rgba(167,139,250,0.3)' }}>
          <div className="text-xs font-semibold mb-3" style={{ color: '#a78bfa' }}>反馈评估报告</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div>
              <div className="mb-1" style={{ color: 'var(--text-muted)' }}>自动边删除率</div>
              <div className="text-lg font-semibold" style={{ color: feedbackQuery.data.edgeFeedback.deletionRate > 0.2 ? '#ef4444' : '#22c55e' }}>
                {(feedbackQuery.data.edgeFeedback.deletionRate * 100).toFixed(1)}%
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                已删 {feedbackQuery.data.edgeFeedback.deletedEdges} / 现存 {feedbackQuery.data.edgeFeedback.totalAutoEdges}
                {feedbackQuery.data.edgeFeedback.recentDeletions > 0 && ` · 近7天 ${feedbackQuery.data.edgeFeedback.recentDeletions}`}
              </div>
            </div>
            <div>
              <div className="mb-1" style={{ color: 'var(--text-muted)' }}>收件箱通过率</div>
              <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {(feedbackQuery.data.reviewStats.approvalRate * 100).toFixed(1)}%
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                通过 {feedbackQuery.data.reviewStats.approved} / 驳回 {feedbackQuery.data.reviewStats.rejected} / 忽略 {feedbackQuery.data.reviewStats.ignored}
              </div>
            </div>
            <div>
              <div className="mb-1" style={{ color: 'var(--text-muted)' }}>分拣建议准确率</div>
              <div className="text-lg font-semibold" style={{ color: feedbackQuery.data.triageAccuracy.accuracy > 0.7 ? '#22c55e' : '#fbbf24' }}>
                {feedbackQuery.data.triageAccuracy.total > 0 ? `${(feedbackQuery.data.triageAccuracy.accuracy * 100).toFixed(1)}%` : '—'}
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                {feedbackQuery.data.triageAccuracy.total > 0
                  ? `${feedbackQuery.data.triageAccuracy.approved}/${feedbackQuery.data.triageAccuracy.total} 被采纳`
                  : '暂无分拣审核记录'}
              </div>
            </div>
          </div>
          {feedbackQuery.data.searchStats && (
            <div className="mt-3 pt-3 border-t text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
              <span style={{ color: 'var(--text-muted)' }}>近 30 天搜索行为：</span>
              <span style={{ color: 'var(--text-primary)' }}> 点击 {feedbackQuery.data.searchStats.clicks} · 问答 {feedbackQuery.data.searchStats.asks}</span>
              {feedbackQuery.data.searchStats.topQueries.length > 0 && (
                <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                  热词：{feedbackQuery.data.searchStats.topQueries.slice(0, 3).map((q) => `${q.query}(${q.count})`).join('、')}
                </span>
              )}
            </div>
          )}
          <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            删除率 &gt;20% 说明自动建边阈值偏低；分拣准确率 &lt;70% 说明置信度阈值需调高。
          </div>
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-2 sm:p-4 space-y-2">
        {listQuery.isLoading && (
          <div className="text-center text-xs py-10" style={{ color: 'var(--text-muted)' }}>加载中…</div>
        )}
        {!listQuery.isLoading && items.length === 0 && (
          <div className="text-center py-16">
            <Inbox className="w-10 h-10 mx-auto mb-3 opacity-30" style={{ color: 'var(--text-muted)' }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {statusFilter === 'pending' ? '收件箱是空的——没有待处理事项' : `没有${STATUS_LABEL[statusFilter]}的事项`}
            </div>
          </div>
        )}
        {items.map((item) => {
          const kind = KIND_LABEL[item.kind] ?? { label: item.kind, color: '#888' };
          return (
            <div key={item.id} className="rounded-lg border p-3"
              style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-start gap-3">
                <span className="text-[10px] px-2 py-0.5 rounded-full shrink-0 mt-0.5"
                  style={{ backgroundColor: `${kind.color}22`, color: kind.color }}>
                  {kind.label}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {item.title}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {item.confidence !== null && (
                      <span>置信度 {(item.confidence * 100).toFixed(0)}%</span>
                    )}
                    {item.documentId && (
                      <Link to={`/kb?doc=${item.documentId}`} className="hover:underline" style={{ color: 'var(--accent-cyan)' }}>
                        文档 #{item.documentId}
                      </Link>
                    )}
                    {item.relatedDocumentId && (
                      <Link to={`/kb?doc=${item.relatedDocumentId}`} className="hover:underline" style={{ color: 'var(--accent-cyan)' }}>
                        对照 #{item.relatedDocumentId}
                      </Link>
                    )}
                    <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                  </div>
                  {/* payload 摘要 */}
                  {item.payload && (
                    <div className="mt-2 text-[10px] rounded p-2 font-mono whitespace-pre-wrap break-all"
                      style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                      {JSON.stringify(item.payload, null, 2).slice(0, 500)}
                    </div>
                  )}
                </div>
                {item.status === 'pending' && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => resolveMutation.mutate({ id: item.id, action: 'approved' })}
                      disabled={resolveMutation.isPending}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-green-500/15"
                      style={{ color: '#22c55e' }} title="通过（执行建议动作）">
                      <CheckCircle2 className="w-3.5 h-3.5" />通过
                    </button>
                    <button
                      onClick={() => resolveMutation.mutate({ id: item.id, action: 'rejected' })}
                      disabled={resolveMutation.isPending}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors hover:bg-red-500/15"
                      style={{ color: '#ef4444' }} title="驳回">
                      <XCircle className="w-3.5 h-3.5" />驳回
                    </button>
                    <button
                      onClick={() => resolveMutation.mutate({ id: item.id, action: 'ignored' })}
                      disabled={resolveMutation.isPending}
                      className="p-1.5 rounded transition-colors hover:bg-white/5"
                      style={{ color: 'var(--text-muted)' }} title="忽略">
                      <EyeOff className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                {item.status !== 'pending' && (
                  <span className="text-[10px] px-2 py-0.5 rounded shrink-0"
                    style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                    {STATUS_LABEL[item.status]}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
