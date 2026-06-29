import { useState } from 'react';
import { useBackups, useBackup } from '@/hooks/useBackups';
import { useAppStore } from '@/store/useAppStore';
import { Archive, RotateCcw, Plus, Loader2, CheckCircle2, AlertCircle, Clock, ChevronDown, ChevronUp, X, HardDrive, FolderOpen, Server } from 'lucide-react';

const TARGET_ICONS: Record<string, typeof HardDrive> = {
  local: HardDrive,
  nas: Server,
  aliyundrive: FolderOpen,
  '115': FolderOpen,
};

const TARGET_NAMES: Record<string, string> = {
  local: '本地',
  nas: 'NAS',
  aliyundrive: '阿里云盘',
  '115': '115 网盘',
};

function statusBadge(status: string) {
  const map: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'bg-amber-500/15 text-amber-400', label: '待执行' },
    running: { cls: 'bg-cyan-500/15 text-cyan-400', label: '运行中' },
    completed: { cls: 'bg-emerald-500/15 text-emerald-400', label: '已完成' },
    failed: { cls: 'bg-rose-500/15 text-rose-400', label: '失败' },
    partial: { cls: 'bg-orange-500/15 text-orange-400', label: '部分失败' },
  };
  const { cls, label } = map[status] ?? { cls: 'bg-slate-500/15 text-slate-400', label: status };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

function restoreStatusBadge(status: string, manifestVerified: string) {
  if (manifestVerified === 'failed') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400">校验失败</span>;
  }
  return statusBadge(status);
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

export default function BackupPage() {
  const { addToast } = useAppStore();
  const { backups, targets, restores, isLoading, create, createRestore } = useBackups();

  const [showCreate, setShowCreate] = useState(false);
  const [selectedBackupId, setSelectedBackupId] = useState<number | null>(null);
  const [target, setTarget] = useState<"local" | "nas" | "115" | "aliyundrive">("local");
  const [sourcePath, setSourcePath] = useState('/data');
  const [restoreTargetPath, setRestoreTargetPath] = useState('/data/restore');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: selectedBackup } = useBackup(selectedBackupId ?? 0);

  const availableTargets = targets.filter((t) => t.available);

  const handleCreateBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await create({ target, sourcePath });
      addToast({ type: 'success', title: '备份任务已创建' });
      setShowCreate(false);
    } catch (err) {
      addToast({ type: 'error', title: '创建备份失败', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBackupId) return;
    setIsSubmitting(true);
    try {
      await createRestore({ backupJobId: selectedBackupId, targetPath: restoreTargetPath });
      addToast({ type: 'success', title: '恢复任务已创建' });
      setSelectedBackupId(null);
    } catch (err) {
      addToast({ type: 'error', title: '创建恢复失败', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto" style={{ backgroundColor: 'var(--bg-primary)', minHeight: 'calc(100vh - 48px)' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>备份与恢复</h1>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>管理数据备份任务和恢复操作</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />新建备份
        </button>
      </div>

      {showCreate && (
        <div className="card-base p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>新建备份任务</h3>
            <button onClick={() => setShowCreate(false)} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X className="w-4 h-4" /></button>
          </div>
          <form onSubmit={handleCreateBackup} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>备份目标</label>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value as typeof target)}
                  className="input-base text-xs w-full"
                >
                  {availableTargets.length === 0 && <option>暂无可用目标</option>}
                  {availableTargets.map((t) => (
                    <option key={t.key} value={t.key}>{TARGET_NAMES[t.key] || t.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>源路径</label>
                <input
                  type="text"
                  value={sourcePath}
                  onChange={(e) => setSourcePath(e.target.value)}
                  placeholder="例如 /data/uploads"
                  className="input-base text-xs w-full"
                  required
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={isSubmitting} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
                {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
                开始备份
              </button>
            </div>
          </form>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> 加载中...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Backups */}
          <div className="space-y-3">
            <h2 className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Archive className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />备份任务
            </h2>
            {backups.length === 0 ? (
              <div className="card-base p-6 text-center">
                <Archive className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>暂无备份任务</p>
              </div>
            ) : (
              backups.map((job) => (
                <div key={job.id} className="card-base p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {(() => {
                        const Icon = TARGET_ICONS[job.target] || HardDrive;
                        return <Icon className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />;
                      })()}
                      <div>
                        <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{TARGET_NAMES[job.target] || job.target}</div>
                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{job.sourcePath}</div>
                      </div>
                    </div>
                    {statusBadge(job.status)}
                  </div>
                  <div className="mb-2">{progressBar(job.progress ?? 0, job.status)}</div>
                  <div className="flex items-center gap-3 text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
                    <span>文件: {job.filesDone}/{job.filesTotal}</span>
                    {(job.filesFailed ?? 0) > 0 && <span className="text-rose-400">失败 {job.filesFailed ?? 0}</span>}
                    <span>{formatTime(job.createdAt)}</span>
                  </div>
                  {job.error && <div className="text-[10px] mb-2" style={{ color: 'var(--accent-rose)' }}>{job.error}</div>}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSelectedBackupId(selectedBackupId === job.id ? null : job.id)}
                      className="text-[10px] flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {selectedBackupId === job.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      详情
                    </button>
                    <button
                      onClick={() => { setSelectedBackupId(job.id); }}
                      className="text-[10px] flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5"
                      style={{ color: 'var(--accent-cyan)' }}
                    >
                      <RotateCcw className="w-3 h-3" />恢复
                    </button>
                  </div>

                  {selectedBackupId === job.id && selectedBackup && (
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <h4 className="text-[10px] font-bold mb-2" style={{ color: 'var(--text-primary)' }}>备份文件清单</h4>
                      {selectedBackup.files && selectedBackup.files.length > 0 ? (
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {selectedBackup.files.map((file) => (
                            <div key={file.id} className="flex items-center justify-between text-[10px] py-1 px-2 rounded" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                              <span className="truncate flex-1" style={{ color: 'var(--text-secondary)' }}>{file.relativePath}</span>
                              <div className="flex items-center gap-2 shrink-0">
                                <span style={{ color: 'var(--text-muted)' }}>{formatBytes(file.size)}</span>
                                {file.status === 'uploaded' ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <AlertCircle className="w-3 h-3 text-rose-400" />}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>暂无文件清单</p>
                      )}

                      <form onSubmit={handleCreateRestore} className="mt-3 space-y-2">
                        <div>
                          <label className="text-[10px] font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>恢复到路径</label>
                          <input
                            type="text"
                            value={restoreTargetPath}
                            onChange={(e) => setRestoreTargetPath(e.target.value)}
                            className="input-base text-xs w-full"
                            required
                          />
                        </div>
                        <button type="submit" disabled={isSubmitting} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
                          {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                          创建恢复任务
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Restores */}
          <div className="space-y-3">
            <h2 className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <RotateCcw className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />恢复任务
            </h2>
            {restores.length === 0 ? (
              <div className="card-base p-6 text-center">
                <RotateCcw className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>暂无恢复任务</p>
              </div>
            ) : (
              restores.map((job) => (
                <div key={job.id} className="card-base p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
                      <div>
                        <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>恢复 #{job.id}</div>
                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{job.targetPath}</div>
                      </div>
                    </div>
                    {restoreStatusBadge(job.status, job.manifestVerified)}
                  </div>
                  <div className="mb-2">{progressBar(job.progress ?? 0, job.status)}</div>
                  <div className="flex items-center gap-3 text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                    <span>文件: {job.filesDone}/{job.filesTotal}</span>
                    {(job.filesFailed ?? 0) > 0 && <span className="text-rose-400">失败 {job.filesFailed ?? 0}</span>}
                    <span>校验: {job.manifestVerified}</span>
                  </div>
                  {job.error && <div className="text-[10px]" style={{ color: 'var(--accent-rose)' }}>{job.error}</div>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
