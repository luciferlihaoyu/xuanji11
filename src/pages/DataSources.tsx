import { useState } from 'react';
import { Cloud, HardDrive, Link2, FolderOpen, RefreshCw, Settings, Unplug, Plus, X, ChevronRight, Check, CloudOff } from 'lucide-react';

const TYPE_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  cloud: { icon: Cloud, color: '#22D3EE', label: '云盘' },
  nas: { icon: HardDrive, color: '#A78BFA', label: 'NAS' },
  platform: { icon: Link2, color: '#34D399', label: '平台' },
  local: { icon: FolderOpen, color: '#FBBF24', label: '本地' },
};

const DATA_SOURCES = [
  { id: 'ds1', name: '团队云盘', type: 'cloud' as const, platform: 'Google Drive', status: 'connected' as const, lastSync: '5分钟前', syncMode: '实时同步', totalFiles: 5000, syncedFiles: 4247, path: '/璇玑智脑' },
  { id: 'ds2', name: '资料 NAS', type: 'nas' as const, platform: 'Synology DS920+', status: 'connected' as const, lastSync: '15分钟前', syncMode: '每小时', totalFiles: 12000, syncedFiles: 8950, path: '\\NAS\\Knowledge' },
  { id: 'ds3', name: '天宫 Hub', type: 'platform' as const, platform: '天宫', status: 'connected' as const, lastSync: '实时', syncMode: '实时同步', totalFiles: 300, syncedFiles: 300, path: 'https://tianting.zeabur.app' },
  { id: 'ds4', name: '本地知识库', type: 'local' as const, platform: '本地文件系统', status: 'connected' as const, lastSync: '1小时前', syncMode: '手动', totalFiles: 850, syncedFiles: 850, path: '/home/node/.openclaw/wiki' },
  { id: 'ds5', name: '飞书文档', type: 'platform' as const, platform: '飞书', status: 'disconnected' as const, lastSync: '3天前', syncMode: '手动', totalFiles: 200, syncedFiles: 0, path: 'feishu://docs' },
];

const SYNC_HISTORY = [
  { id: 's1', time: '10分钟前', source: '团队云盘', type: '增量同步', files: '+23 / ~5 / -2', result: 'success' as const, duration: '1m 24s' },
  { id: 's2', time: '1小时前', source: '资料 NAS', type: '全量同步', files: '+156 / ~42 / -8', result: 'success' as const, duration: '4m 38s' },
  { id: 's3', time: '2小时前', source: '天宫 Hub', type: '实时推送', files: '+3 / ~0 / -0', result: 'success' as const, duration: '2s' },
  { id: 's4', time: '昨天', source: '飞书文档', type: '手动触发', files: '+0 / ~0 / -0', result: 'failed' as const, duration: '30s' },
];

export default function DataSources() {
  const [showAddModal, setShowAddModal] = useState(false);
  const [addStep, setAddStep] = useState(0);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());

  const handleSync = (id: string) => {
    setSyncingIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 3000);
  };

  return (
    <div className="p-6" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Overview */}
      <div className="flex flex-wrap items-center justify-between mb-6">
        <div className="flex gap-4 mb-4 sm:mb-0">
          {[
            { label: '已连接源', value: `${DATA_SOURCES.filter((s) => s.status === 'connected').length} 个` },
            { label: '已同步文件', value: `${DATA_SOURCES.reduce((a, s) => a + s.syncedFiles, 0).toLocaleString()} 文件` },
            { label: '今日同步', value: '12 次' },
          ].map((stat) => (
            <div key={stat.label}>
              <div className="text-2xl font-bold" style={{ color: 'var(--accent-cyan)' }}>{stat.value}</div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{stat.label}</div>
            </div>
          ))}
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" />
          添加数据源
        </button>
      </div>

      {/* Source Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
        {DATA_SOURCES.map((source) => {
          const config = TYPE_CONFIG[source.type];
          const Icon = config.icon;
          const isSyncing = syncingIds.has(source.id);
          return (
            <div key={source.id} className="card-base group">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: `${config.color}20` }}
                  >
                    <Icon className="w-5 h-5" style={{ color: config.color }} />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{source.name}</h4>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={source.status === 'connected' ? 'status-dot-online' : 'status-dot-offline'} />
                      <span className="text-xs" style={{ color: source.status === 'connected' ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
                        {source.status === 'connected' ? '已连接' : '已断开'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleSync(source.id)}
                    className="p-1.5 rounded hover:bg-white/5"
                    style={{ color: 'var(--accent-emerald)' }}
                    disabled={isSyncing}
                  >
                    <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-rotate' : ''}`} />
                  </button>
                  <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}>
                    <Settings className="w-4 h-4" />
                  </button>
                  <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--accent-rose)' }}>
                    <Unplug className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="space-y-2 mb-3">
                <div className="flex items-center gap-2">
                  <span className="chip text-[10px] py-0.5 px-2" style={{ backgroundColor: `${config.color}20`, color: config.color }}>{config.label}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{source.platform}</span>
                </div>
                <code className="text-[11px] block truncate" style={{ color: 'var(--text-muted)' }}>{source.path}</code>
              </div>

              <div className="flex items-center justify-between text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                <span>最后同步: {source.lastSync}</span>
                <span className="chip text-[10px] py-0.5 px-2">{source.syncMode}</span>
              </div>

              <div className="flex items-center justify-between text-xs mb-1">
                <span style={{ color: 'var(--text-secondary)' }}>已同步 {source.syncedFiles.toLocaleString()} / {source.totalFiles.toLocaleString()}</span>
                <span style={{ color: 'var(--text-muted)' }}>{Math.round((source.syncedFiles / source.totalFiles) * 100)}%</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                <div className="h-full rounded-full gradient-bar transition-all duration-500" style={{ width: `${(source.syncedFiles / source.totalFiles) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Sync History */}
      <div>
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>同步历史</h3>
        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                {['时间', '数据源', '类型', '文件变更', '结果', '耗时'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SYNC_HISTORY.map((log) => (
                <tr key={log.id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{log.time}</td>
                  <td className="px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{log.source}</td>
                  <td className="px-4 py-3">
                    <span className="chip text-[10px] py-0.5 px-2">{log.type}</span>
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{log.files}</td>
                  <td className="px-4 py-3">
                    {log.result === 'success' ? (
                      <Check className="w-4 h-4" style={{ color: 'var(--accent-emerald)' }} />
                    ) : (
                      <CloudOff className="w-4 h-4" style={{ color: 'var(--accent-rose)' }} />
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{log.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Source Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="animate-scale-in rounded-lg border p-6 w-[520px]" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>添加数据源</h3>
              <button onClick={() => { setShowAddModal(false); setAddStep(0); }} className="p-1 rounded hover:bg-white/5">
                <X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>

            {/* Steps */}
            <div className="flex items-center gap-2 mb-6">
              {['类型', '平台', '配置', '完成'].map((step, i) => (
                <div key={step} className="flex items-center gap-2 flex-1">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{
                      backgroundColor: i <= addStep ? 'var(--accent-cyan)' : i < addStep ? 'var(--accent-emerald)' : 'var(--bg-tertiary)',
                      color: i <= addStep ? '#0A0E1A' : 'var(--text-muted)',
                    }}
                  >
                    {i < addStep ? '✓' : i + 1}
                  </div>
                  <span className="text-xs hidden sm:block" style={{ color: i <= addStep ? 'var(--text-primary)' : 'var(--text-muted)' }}>{step}</span>
                  {i < 3 && <div className="flex-1 h-px" style={{ backgroundColor: i < addStep ? 'var(--accent-cyan)' : 'var(--border-subtle)' }} />}
                </div>
              ))}
            </div>

            {/* Step Content */}
            {addStep === 0 && (
              <div className="grid grid-cols-2 gap-3">
                {[
                  { type: 'cloud', label: '云盘', desc: '连接云端存储服务', icon: Cloud },
                  { type: 'nas', label: 'NAS', desc: '连接网络存储设备', icon: HardDrive },
                  { type: 'platform', label: '协作平台', desc: '连接天宫、飞书等平台', icon: Link2 },
                  { type: 'local', label: '本地文件', desc: '挂载本地文件夹', icon: FolderOpen },
                ].map((item) => (
                  <button
                    key={item.type}
                    onClick={() => setAddStep(1)}
                    className="card-base p-4 text-left hover:border-[var(--accent-cyan)] transition-colors"
                  >
                    <item.icon className="w-8 h-8 mb-2" style={{ color: TYPE_CONFIG[item.type].color }} />
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{item.label}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.desc}</div>
                  </button>
                ))}
              </div>
            )}

            {addStep === 1 && (
              <div>
                <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>选择云盘平台</p>
                <div className="grid grid-cols-2 gap-3">
                  {['Google Drive', 'Dropbox', 'OneDrive', '百度网盘', '阿里云盘', 'WebDAV'].map((p) => (
                    <button key={p} onClick={() => setAddStep(2)} className="card-base p-3 text-left text-sm hover:border-[var(--accent-cyan)] transition-colors" style={{ color: 'var(--text-secondary)' }}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {addStep === 2 && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>源名称</label>
                  <input type="text" placeholder="我的 Google Drive" className="input-base text-xs" />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>同步模式</label>
                  <div className="flex gap-2">
                    {['实时同步', '定时同步', '手动同步'].map((m) => (
                      <button key={m} className="chip text-xs py-1 px-3">{m}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>文件过滤</label>
                  <div className="flex flex-wrap gap-2">
                    {['文档', '图片', '视频', '代码', '全部'].map((f) => (
                      <label key={f} className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <input type="checkbox" defaultChecked={f === '全部'} className="rounded" style={{ accentColor: 'var(--accent-cyan)' }} />
                        {f}
                      </label>
                    ))}
                  </div>
                </div>
                <button className="btn-secondary w-full text-xs py-2">连接 Google Drive</button>
              </div>
            )}

            {addStep === 3 && (
              <div className="text-center py-8">
                <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ backgroundColor: 'rgba(52,211,153,0.15)' }}>
                  <Check className="w-6 h-6" style={{ color: 'var(--accent-emerald)' }} />
                </div>
                <h4 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>连接成功</h4>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>数据源已添加，同步将在后台自动进行</p>
              </div>
            )}

            {/* Nav buttons */}
            <div className="flex justify-end gap-2 mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              {addStep > 0 && (
                <button onClick={() => setAddStep(addStep - 1)} className="btn-ghost text-xs py-2 px-4">
                  上一步
                </button>
              )}
              {addStep < 3 ? (
                <button onClick={() => setAddStep(addStep + 1)} className="btn-primary text-xs py-2 px-4 flex items-center gap-1">
                  下一步 <ChevronRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button onClick={() => { setShowAddModal(false); setAddStep(0); }} className="btn-primary text-xs py-2 px-4">
                  完成
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
