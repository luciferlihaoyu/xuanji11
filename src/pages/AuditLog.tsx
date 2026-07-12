import { useState } from 'react';
import { ChevronLeft, ChevronRight, Clock, User, Activity, FileJson } from 'lucide-react';
import { trpc } from '@/providers/trpc';

const PAGE_SIZE = 20;

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDetails(details: unknown): string {
  if (!details || typeof details !== 'object') return '—';
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

export default function AuditLog() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = trpc.audit.listLogs.useQuery({ page, pageSize: PAGE_SIZE });

  const logs = data?.logs ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="p-6 h-[calc(100vh-48px)] overflow-y-auto" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>审计日志</h2>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          共 {data?.total ?? 0} 条记录
        </div>
      </div>

      <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
        <table className="w-full text-sm">
          <thead style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <tr>
              {['时间', '用户', '操作', '详情'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  加载中...
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  暂无审计日志
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <Clock className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                      {formatDate(log.createdAt)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <User className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                      {log.userName || log.actorId || '系统'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--accent-cyan)' }}>
                      <Activity className="w-3 h-3" />
                      {log.action}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-1.5">
                      <FileJson className="w-3 h-3 mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                      <pre className="text-[10px] font-mono whitespace-pre-wrap break-all max-w-md" style={{ color: 'var(--text-secondary)' }}>
                        {formatDetails(log.details)}
                      </pre>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> 上一页
          </button>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1"
          >
            下一页 <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
