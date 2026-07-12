import { AlertCircle, BarChart3, Clock, Loader2, Tag, Unlink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { trpc } from '@/providers/trpc';
import { AnalysisCards } from '@/components/AnalysisCards';

function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === 'string') return new Date(value).toLocaleString();
  return '-';
}

export default function AnalysisDashboard() {
  const { data, isLoading, error } = trpc.analytics.getAnalytics.useQuery();

  if (isLoading) {
    return (
      <div
        className="p-6 flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-primary)', minHeight: 'calc(100vh - 48px)' }}
      >
        <div className="flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">加载分析数据中...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="p-6 flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-primary)', minHeight: 'calc(100vh - 48px)' }}
      >
        <div className="flex items-center gap-2" style={{ color: 'var(--accent-rose)' }}>
          <AlertCircle className="w-5 h-5" />
          <span className="text-sm">加载失败: {error.message}</span>
        </div>
      </div>
    );
  }

  const analytics = data;
  const maxTagCount = analytics?.topTags[0]?.count ?? 0;

  return (
    <div
      className="p-6 max-w-7xl mx-auto"
      style={{ backgroundColor: 'var(--bg-primary)', minHeight: 'calc(100vh - 48px)' }}
    >
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <BarChart3 className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} />
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            分析仪表盘
          </h1>
        </div>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          知识库实时数据分析与洞察
        </p>
      </div>

      <AnalysisCards totals={analytics?.totals} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        <div className="card-base">
          <div className="flex items-center gap-2 mb-4">
            <Tag className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              热门标签 TOP 10
            </h2>
          </div>
          {analytics?.topTags.length === 0 ? (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无标签数据</div>
          ) : (
            <div className="space-y-3">
              {analytics?.topTags.map((tag, index) => {
                const percent = maxTagCount > 0 ? (tag.count / maxTagCount) * 100 : 0;
                return (
                  <div key={tag.tag} className="flex items-center gap-3">
                    <span className="w-5 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                      {index + 1}
                    </span>
                    <span className="w-24 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                      {tag.tag}
                    </span>
                    <div className="flex-1 h-2 rounded-full" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                      <div
                        className="h-2 rounded-full"
                        style={{
                          width: `${percent}%`,
                          background: 'linear-gradient(90deg, var(--accent-cyan), var(--accent-violet))',
                        }}
                      />
                    </div>
                    <span className="w-8 text-xs text-right font-mono" style={{ color: 'var(--accent-cyan)' }}>
                      {tag.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card-base">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              最近活动
            </h2>
          </div>
          <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
            {analytics?.recentNodes.map((node) => (
              <Link
                key={node.id}
                to={`/kb/${node.id}`}
                className="flex items-center gap-3 p-2 rounded transition-colors hover:bg-white/5"
              >
                <span className="chip text-[10px] py-0 px-1.5">{node.type}</span>
                <span className="flex-1 text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                  {node.title}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatDate(node.updatedAt)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="card-base mt-6">
        <div className="flex items-center gap-2 mb-4">
          <Unlink className="w-4 h-4" style={{ color: 'var(--accent-rose)' }} />
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            知识孤岛
          </h2>
          <span className="ml-auto chip text-[10px] py-0 px-1.5">
            {analytics?.orphanNodes.length ?? 0} 个节点
          </span>
        </div>
        {analytics?.orphanNodes.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>所有节点都已建立关联</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {analytics?.orphanNodes.map((node) => (
              <Link
                key={node.id}
                to={`/kb/${node.id}`}
                className="flex items-center gap-2 p-3 rounded transition-colors hover:border-[var(--accent-cyan)]"
                style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
              >
                <span className="chip text-[10px] py-0 px-1.5">{node.type}</span>
                <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                  {node.title}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
