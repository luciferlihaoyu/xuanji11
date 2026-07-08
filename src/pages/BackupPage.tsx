import { useState } from 'react';
import { useBackups, useBackup } from '@/hooks/useBackups';
import { useAppStore } from '@/store/useAppStore';
import { Archive, RotateCcw, Plus, Loader2, CheckCircle2, AlertCircle, Clock, ChevronDown, ChevronUp, X, HardDrive, FolderOpen, Server, Trash2, Calendar, Wifi, WifiOff } from 'lucide-react';

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

function parseCron(schedule: string): string {
  if (!schedule) return '仅一次';
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour, day, month, weekday] = parts;
  if (min === '0' && hour === '3' && day === '*' && month === '*' && weekday === '*') return '每天 03:00';
  if (min === '0' && hour === '3' && day === '*' && month === '*' && weekday === '0') return '每周日 03:00';
  if (min === '0' && hour === '3' && day === '1' && month === '*' && weekday === '*') return '每月 1 日 03:00';
  return schedule;
}

/** 运行中的备份进度信息 */
function RunningProgress({ job }: { job: { filesDone: number | null; filesTotal: number | null; filesFailed: number | null; progress: number | null; status: string } }) {
  const done = job.filesDone ?? 0;
  const total = job.filesTotal ?? 0;
  const failed = job.filesFailed ?? 0;
  const progress = job.progress ?? 0;

  if (job.status !== 'running') return null;

  return (
    <div className="text-[10px] space-y-1" style={{ color: 'var(--text-muted)' }}>
      <div className="flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
        <span>正在备份... {progress}%</span>
      </div>
      <div className="flex items-center gap-3">
        <span>已处理: {done}/{total} 文件</span>
        {failed > 0 && <span className="text-rose-400">失败: {failed}</span>}
        <span>剩余: {Math.max(0, total - done - failed)}</span>
      </div>
    </div>
  );
}

export default function BackupPage() {
  const { addToast } = useAppStore();
  const { backups, targets, restores, isLoading, create, updateSchedule, deleteBackup, createRestore } = useBackups();

  const [showCreate, setShowCreate] = useState(false);
  const [selectedBackupId, setSelectedBackupId] = useState<number | null>(null);
  const [target, setTarget] = useState<"local" | "nas" | "115" | "aliyundrive">("local");
  const [sourcePath, setSourcePath] = useState('/data');
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [restoreTargetPath, setRestoreTargetPath] = useState('/data/restore');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{ testing: boolean; result?: { success: boolean; message: string } }>({ testing: false });

  // Schedule fields
  const [mode, setMode] = useState<'immediate' | 'scheduled'>('immediate');
  const [cron, setCron] = useState('0 3 * * *');
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [keepLastN, setKeepLastN] = useState(7);

  const { data: selectedBackup } = useBackup(selectedBackupId ?? 0);

  const availableTargets = targets.filter((t) => t.available);

  const isCloudDrive = target === '115' || target === 'aliyundrive';

  const schedules = backups.filter((b) => b.cron);
  const runJobs = backups.filter((b) => !b.cron);

  const handleCreateBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const config: Record<string, string> = {};
      if (isCloudDrive) {
        if (!accessToken && !refreshToken) {
          throw new Error('云盘备份需要提供 Access Token 或 Refresh Token');
        }
        if (accessToken) config.accessToken = accessToken;
        if (refreshToken) config.refreshToken = refreshToken;
      }
      const payload: Record<string, unknown> = { target, sourcePath, config };
      if (mode === 'scheduled') {
        payload.cron = cron;
        payload.enabled = scheduleEnabled;
        payload.keepLastN = keepLastN;
      }
      await create(payload as { target: typeof target; sourcePath: string; config?: Record<string, string>; cron?: string; enabled?: boolean; keepLastN?: number });
      addToast({ type: 'success', title: mode === 'scheduled' ? '备份策略已创建' : '备份任务已创建' });
      setShowCreate(false);
      setAccessToken('');
      setRefreshToken('');
      setConnectionStatus({ testing: false });
    } catch (err) {
      addToast({ type: 'error', title: '创建失败', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleSchedule = async (job: typeof backups[number]) => {
    try {
      await updateSchedule({ id: job.id, enabled: job.enabled !== 'true' });
      addToast({ type: 'success', title: '策略已更新' });
    } catch (err) {
      addToast({ type: 'error', title: '更新失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteBackup({ id });
      addToast({ type: 'success', title: '已删除' });
      if (selectedBackupId === id) setSelectedBackupId(null);
    } catch (err) {
      addToast({ type: 'error', title: '删除失败', description: err instanceof Error ? err.message : String(err) });
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
            <button onClick={() => { setShowCreate(false); setConnectionStatus({ testing: false }); }} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X className="w-4 h-4" /></button>
          </div>
          <form onSubmit={handleCreateBackup} className="space-y-3">
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => setMode('immediate')}
                className={`text-xs px-3 py-1.5 rounded ${mode === 'immediate' ? 'bg-cyan-500/20 text-cyan-400' : 'hover:bg-white/5'}`}
                style={{ color: mode === 'immediate' ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}
              >
                立即备份
              </button>
              <button
                type="button"
                onClick={() => setMode('scheduled')}
                className={`text-xs px-3 py-1.5 rounded ${mode === 'scheduled' ? 'bg-cyan-500/20 text-cyan-400' : 'hover:bg-white/5'}`}
                style={{ color: mode === 'scheduled' ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}
              >
                定时策略
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>备份目标</label>
                <select
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value as typeof target);
                    setConnectionStatus({ testing: false });
                  }}
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
            {mode === 'scheduled' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Cron 表达式</label>
                  <input
                    type="text"
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    placeholder="0 3 * * *"
                    className="input-base text-xs w-full"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>保留份数</label>
                  <input
                    type="number"
                    min={1}
                    value={keepLastN}
                    onChange={(e) => setKeepLastN(Number(e.target.value))}
                    className="input-base text-xs w-full"
                    required
                  />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={scheduleEnabled}
                      onChange={(e) => setScheduleEnabled(e.target.checked)}
                      className="rounded border-gray-600"
                    />
                    <span style={{ color: 'var(--text-primary)' }}>启用策略</span>
                  </label>
                </div>
              </div>
            )}
            {isCloudDrive && (
              <div className="space-y-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>
                      Access Token {target === '115' ? '(或 Refresh Token)' : ''}
                    </label>
                    <input
                      type="password"
                      value={accessToken}
                      onChange={(e) => { setAccessToken(e.target.value); setConnectionStatus({ testing: false }); }}
                      placeholder={target === '115' ? '115 OAuth accessToken' : '阿里云盘 accessToken'}
                      className="input-base text-xs w-full"
                      required={!refreshToken}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>
                      Refresh Token <span className="text-[var(--text-muted)]">(推荐，用于自动刷新)</span>
                    </label>
                    <input
                      type="password"
                      value={refreshToken}
                      onChange={(e) => { setRefreshToken(e.target.value); setConnectionStatus({ testing: false }); }}
                      placeholder="用于自动刷新 accessToken"
                      className="input-base text-xs w-full"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => addToast({ type: 'info', title: '请通过数据源管理页面测试连接' })}
                    className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5"
                  >
                    <Wifi className="w-3.5 h-3.5" />测试连接
                  </button>
                </div>
                {connectionStatus.result && (
                  <div className={`flex items-center gap-1.5 text-[10px] ${connectionStatus.result.success ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {connectionStatus.result.success ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                    {connectionStatus.result.message}
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end">
              <button type="submit" disabled={isSubmitting} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
                {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
                {mode === 'scheduled' ? '创建策略' : '开始备份'}
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

            {schedules.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>定时策略</h3>
                {schedules.map((job) => (
                  <div key={job.id} className="card-base p-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {(() => {
                          const Icon = TARGET_ICONS[job.target] || HardDrive;
                          return <Icon className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />;
                        })()}
                        <div>
                          <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{TARGET_NAMES[job.target] || job.target}</div>
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{job.sourcePath} · {parseCron(job.cron ?? '')}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleToggleSchedule(job)}
                          className={`text-[10px] px-2 py-1 rounded ${job.enabled === 'true' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-500/15 text-slate-400'}`}
                        >
                          {job.enabled === 'true' ? '已启用' : '已禁用'}
                        </button>
                        <button
                          onClick={() => handleDelete(job.id)}
                          className="p-1 rounded hover:bg-white/5"
                          style={{ color: 'var(--accent-rose)' }}
                          title="删除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />保留 {job.keepLastN ?? 7} 份</span>
                      <span>下次运行: {formatTime(job.nextRunAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {runJobs.length === 0 ? (
              <div className="card-base p-6 text-center">
                <Archive className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>暂无备份任务</p>
              </div>
            ) : (
              runJobs.map((job) => (
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
                    <div className="flex items-center gap-2">
                      {statusBadge(job.status)}
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="p-1 rounded hover:bg-white/5"
                        style={{ color: 'var(--accent-rose)' }}
                        title="删除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mb-2">{progressBar(job.progress ?? 0, job.status)}</div>
                  <div className="flex items-center gap-3 text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                    <span>文件: {job.filesDone}/{job.filesTotal}</span>
                    {(job.filesFailed ?? 0) > 0 && <span className="text-rose-400">失败 {job.filesFailed ?? 0}</span>}
                    <span>{formatTime(job.createdAt)}</span>
                  </div>
                  {job.status === 'running' && <div className="mb-2"><RunningProgress job={job} /></div>}
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
