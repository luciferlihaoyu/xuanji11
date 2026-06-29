import { useState } from 'react';
import { useIngestion, useIngestionJob, useIngestionItems } from '@/hooks/useIngestion';
import { useAppStore } from '@/store/useAppStore';
import { Activity, Loader2, FileText, Database, Upload, HardDrive, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';

const SOURCE_LABELS: Record<string, string> = {
  upload: '上传',
  datasource: '数据源',
  backup: '备份',
  manual: '手动',
};

const SOURCE_ICONS: Record<string, typeof Upload> = {
  upload: Upload,
  datasource: Database,
  backup: HardDrive,
  manual: Activity,
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const ITEM_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  parsing: '解析中',
  chunking: '分块中',
  indexing: '索引中',
  completed: '已完成',
  failed: '失败',
  unsupported: '不支持的格式',
};

function statusBadge(status: string) {
  const map: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'bg-amber-500/15 text-amber-400', label: STATUS_LABELS.pending },
    running: { cls: 'bg-cyan-500/15 text-cyan-400', label: STATUS_LABELS.running },
    completed: { cls: 'bg-emerald-500/15 text-emerald-400', label: STATUS_LABELS.completed },
    failed: { cls: 'bg-rose-500/15 text-rose-400', label: STATUS_LABELS.failed },
    cancelled: { cls: 'bg-slate-500/15 text-slate-400', label: STATUS_LABELS.cancelled },
  };
  const { cls, label } = map[status] ?? { cls: 'bg-slate-500/15 text-slate-400', label: status };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

function itemStatusBadge(status: string) {
  const map: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'bg-amber-500/15 text-amber-400', label: ITEM_STATUS_LABELS.pending },
    parsing: { cls: 'bg-cyan-500/15 text-cyan-400', label: ITEM_STATUS_LABELS.parsing },
    chunking: { cls: 'bg-blue-500/15 text-blue-400', label: ITEM_STATUS_LABELS.chunking },
    indexing: { cls: 'bg-purple-500/15 text-purple-400', label: ITEM_STATUS_LABELS.indexing },
    completed: { cls: 'bg-emerald-500/15 text-emerald-400', label: ITEM_STATUS_LABELS.completed },
    failed: { cls: 'bg-rose-500/15 text-rose-400', label: ITEM_STATUS_LABELS.failed },
    unsupported: { cls: 'bg-slate-500/15 text-slate-400', label: ITEM_STATUS_LABELS.unsupported },
  };
  const { cls, label } = map[status] ?? { cls: 'bg-slate-500/15 text-slate-400', label: status };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

function formatTime(t: string | Date | null) {
  if (!t) return '-';
  return new Date(t).toLocaleString();
}

function formatBytes(n: number | null | undefined) {
  if (n === null || n === undefined || n === 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function progressBar(progress: number, status: string) {
  const color = status === 'failed' ? 'bg-rose-500' : status === 'completed' ? 'bg-emerald-500' : 'bg-cyan-500';
  return (
    <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
      <div className={`h-full ${color} transition-all`} style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
    </div>
  );
}

export default function IngestionPage() {
  const { addToast } = useAppStore();
  const { jobs, isLoading, refetch } = useIngestion();
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'upload' | 'datasource' | 'backup' | 'manual'>('all');

  const { data: selectedJob } = useIngestionJob(selectedJobId ?? 0);
  const { data: items } = useIngestionItems(selectedJobId ?? 0);

  const filteredJobs = filter === 'all' ? jobs : jobs.filter((j) => j.sourceType === filter);

  const stats = {
    total: jobs.length,
    running: jobs.filter((j) => j.status === 'running').length,
    completed: jobs.filter((j) => j.status === 'completed').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
  };

  return (
    <div className="p-6 max-w-6xl mx-auto" style={{ backgroundColor: 'var(--bg-primary)', minHeight: 'calc(100vh - 48px)' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>入库监控</h1>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>追踪上传、数据源同步和备份的入库进度</p>
        </div>
        <button
          onClick={() => {
            refetch();
            addToast({ type: 'success', title: '已刷新' });
          }}
          className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />刷新
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="card-base p-4">
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>总任务</div>
          <div className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{stats.total}</div>
        </div>
        <div className="card-base p-4">
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>运行中</div>
          <div className="text-xl font-bold text-cyan-400">{stats.running}</div>
        </div>
        <div className="card-base p-4">
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>已完成</div>
          <div className="text-xl font-bold text-emerald-400">{stats.completed}</div>
        </div>
        <div className="card-base p-4">
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>失败</div>
          <div className="text-xl font-bold text-rose-400">{stats.failed}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        {(['all', 'upload', 'datasource', 'backup', 'manual'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`text-xs px-3 py-1.5 rounded transition-colors ${filter === key ? 'bg-[var(--accent-cyan-dim)] text-[var(--accent-cyan)]' : 'hover:bg-white/5'}`}
            style={{ color: filter === key ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}
          >
            {key === 'all' ? '全部' : SOURCE_LABELS[key]}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> 加载中...
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="card-base p-8 text-center">
          <Activity className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>暂无入库任务</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredJobs.map((job) => {
            const Icon = SOURCE_ICONS[job.sourceType] || Activity;
            const total = job.totalItems ?? 0;
            const processed = job.processedItems ?? 0;
            const failed = job.failedItems ?? 0;
            const progress = total > 0 ? Math.round(((processed + failed) / total) * 100) : 0;
            return (
              <div key={job.id} className="card-base p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
                    <div>
                      <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {SOURCE_LABELS[job.sourceType]}任务 #{job.id}
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        source: {job.sourceId || '-'}
                      </div>
                    </div>
                  </div>
                  {statusBadge(job.status)}
                </div>

                <div className="mb-2">{progressBar(progress, job.status)}</div>

                <div className="flex items-center gap-3 text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                  <span>项目: {processed}/{total}</span>
                  {failed > 0 && <span className="text-rose-400">失败 {failed}</span>}
                  <span>重试: {job.retryCount ?? 0}</span>
                  <span>{formatTime(job.createdAt)}</span>
                </div>

                {job.error && <div className="text-[10px] mb-2" style={{ color: 'var(--accent-rose)' }}>{job.error}</div>}

                <button
                  onClick={() => setSelectedJobId(selectedJobId === job.id ? null : job.id)}
                  className="text-[10px] flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {selectedJobId === job.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  查看项目
                </button>

                {selectedJobId === job.id && selectedJob && (
                  <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-[10px] font-bold" style={{ color: 'var(--text-primary)' }}>入库项目</h4>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>共 {items?.length ?? 0} 项</span>
                    </div>
                    {!items ? (
                      <div className="flex items-center justify-center py-4" style={{ color: 'var(--text-muted)' }}>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />加载中...
                      </div>
                    ) : items.length === 0 ? (
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>暂无项目</p>
                    ) : (
                      <div className="max-h-64 overflow-y-auto space-y-1">
                        {items.map((item) => (
                          <div key={item.id} className="flex items-center justify-between py-1.5 px-2 rounded text-[10px]" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                            <div className="flex items-center gap-2 min-w-0">
                              <FileText className="w-3 h-3 shrink-0" style={{ color: 'var(--text-muted)' }} />
                              <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{item.name}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span style={{ color: 'var(--text-muted)' }}>{formatBytes(item.size)}</span>
                              {itemStatusBadge(item.status)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
