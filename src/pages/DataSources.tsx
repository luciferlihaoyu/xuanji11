import { useState } from 'react';
import { Cloud, HardDrive, Link2, FolderOpen, RefreshCw, Plus, X, Check, Trash2, Pencil } from 'lucide-react';
import { useDataSources } from '@/hooks/useDataSources';

const TYPE_CONFIG: Record<string, { icon: typeof Cloud; color: string; label: string }> = {
  cloud_drive: { icon: Cloud, color: '#22D3EE', label: '云盘' },
  nas: { icon: HardDrive, color: '#A78BFA', label: 'NAS' },
  api: { icon: Link2, color: '#34D399', label: 'API' },
  webhook: { icon: Link2, color: '#F472B6', label: 'Webhook' },
  database: { icon: HardDrive, color: '#60A5FA', label: '数据库' },
  obsidian: { icon: FolderOpen, color: '#A78BFA', label: 'Obsidian' },
  notion: { icon: FolderOpen, color: '#FBBF24', label: 'Notion' },
  rss: { icon: Link2, color: '#FB923C', label: 'RSS' },
};

const TYPE_OPTIONS = [
  { value: 'cloud_drive', label: '云盘' },
  { value: 'nas', label: 'NAS' },
  { value: 'database', label: '数据库' },
  { value: 'api', label: 'API' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'rss', label: 'RSS' },
  { value: 'obsidian', label: 'Obsidian' },
  { value: 'notion', label: 'Notion' },
];

export default function DataSources() {
  const {
    dataSources,
    isLoading,
    create,
    update,
    delete: deleteDs,
    testConnection,
    sync,
  } = useDataSources();

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', type: 'api' as string, url: '', apiKey: '', syncInterval: 'manual' });
  const [syncingIds, setSyncingIds] = useState<Set<number>>(new Set());
  const [testingIds, setTestingIds] = useState<Set<number>>(new Set());

  const handleOpenCreate = () => {
    setEditingId(null);
    setForm({ name: '', type: 'api', url: '', apiKey: '', syncInterval: 'manual' });
    setShowModal(true);
  };

  const handleOpenEdit = (ds: Record<string, unknown>) => {
    setEditingId(ds.id as number);
    const config = (ds.config as Record<string, unknown>) || {};
    setForm({
      name: (ds.name as string) || '',
      type: (ds.type as string) || 'api',
      url: (config.url as string) || '',
      apiKey: (config.apiKey as string) || '',
      syncInterval: (config.syncInterval as string) || 'manual',
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    try {
      if (editingId) {
        await update({
          id: editingId,
          name: form.name,
          config: { url: form.url, apiKey: form.apiKey, syncInterval: form.syncInterval },
        });
      } else {
        await create({
          name: form.name,
          type: form.type as "cloud_drive" | "nas" | "database" | "api" | "webhook" | "rss" | "notion" | "obsidian",
          config: { url: form.url, apiKey: form.apiKey, syncInterval: form.syncInterval },
        });
      }
      setShowModal(false);
    } catch (err) {
      console.error('保存数据源失败:', err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定要删除此数据源吗？')) return;
    try {
      await deleteDs({ id });
    } catch (err) {
      console.error('删除失败:', err);
    }
  };

  const handleTest = async (id: number) => {
    setTestingIds((prev) => new Set(prev).add(id));
    try {
      await testConnection({ id });
    } catch (err) {
      console.error('连接测试失败:', err);
    } finally {
      setTestingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleSync = async (id: number) => {
    setSyncingIds((prev) => new Set(prev).add(id));
    try {
      await sync({ id });
    } catch (err) {
      console.error('同步失败:', err);
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const connectedCount = dataSources.filter((s) => s.status === 'connected').length;

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <RefreshCw className="w-6 h-6 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  return (
    <div className="p-6" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Stats */}
      <div className="flex flex-wrap items-center justify-between mb-6">
        <div className="flex gap-6 mb-4 sm:mb-0">
          <div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>{connectedCount} 个</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>已连接源</div>
          </div>
          <div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>{dataSources.length} 个</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>总数据源</div>
          </div>
        </div>
        <button onClick={handleOpenCreate} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" />
          添加数据源
        </button>
      </div>

      {/* Source Cards */}
      {dataSources.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed" style={{ borderColor: 'var(--border-subtle)' }}>
          <HardDrive className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>暂无数据源</p>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>添加你的第一个数据源，连接外部知识库</p>
          <button onClick={handleOpenCreate} className="btn-primary text-xs py-2 px-4">添加数据源</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
          {dataSources.map((source) => {
            const config = TYPE_CONFIG[source.type] || TYPE_CONFIG.api;
            const Icon = config.icon;
            const isSyncing = syncingIds.has(source.id);
            const isTesting = testingIds.has(source.id);
            const dsConfig: Record<string, string> = (source.config as Record<string, string>) || {};
            return (
              <div key={source.id} className="card-base group">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${config.color}20` }}>
                      <Icon className="w-5 h-5" style={{ color: config.color }} />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{source.name}</h4>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={source.status === 'connected' ? 'status-dot-online' : source.status === 'error' ? 'status-dot-offline' : 'status-dot-away'} />
                        <span className="text-xs" style={{
                          color: source.status === 'connected' ? '#34D399' : source.status === 'error' ? '#EF4444' : '#9CA3AF',
                        }}>
                          {source.status === 'connected' ? '已连接' : source.status === 'error' ? '连接错误' : source.status === 'syncing' ? '同步中' : '未连接'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => handleTest(source.id)} disabled={isTesting} className="p-1.5 rounded hover:bg-white/5" style={{ color: '#34D399' }} title="测试连接">
                      {isTesting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    </button>
                    <button onClick={() => handleSync(source.id)} disabled={isSyncing} className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--accent)' }} title="同步">
                      <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    </button>
                    <button onClick={() => handleOpenEdit(source)} className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }} title="编辑">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(source.id)} className="p-1.5 rounded hover:bg-red-500/10" style={{ color: '#EF4444' }} title="删除">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="chip text-[10px] py-0.5 px-2" style={{ backgroundColor: `${config.color}20`, color: config.color }}>{config.label}</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{source.type}</span>
                  </div>
                  {dsConfig.url && typeof dsConfig.url === 'string' && (
                    <code className="text-[11px] block truncate" style={{ color: 'var(--text-muted)' }}>{dsConfig.url}</code>
                  )}
                  {source.lastError && (
                    <p className="text-[11px] truncate" style={{ color: '#EF4444' }}>{source.lastError}</p>
                  )}
                </div>

                <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <span>最后同步: {source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : '从未'}</span>
                  {dsConfig.syncInterval && typeof dsConfig.syncInterval === 'string' && (
                    <span className="chip text-[10px] py-0.5 px-2">{dsConfig.syncInterval}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="animate-scale-in rounded-lg border p-6 w-[480px] max-h-[90vh] overflow-y-auto" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {editingId ? '编辑数据源' : '添加数据源'}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-1 rounded hover:bg-white/5">
                <X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>源名称 *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="例如：我的 API 接口"
                  className="input-base text-xs w-full"
                />
              </div>

              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>类型 *</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))}
                  className="input-base text-xs w-full"
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>URL / 路径</label>
                <input
                  type="text"
                  value={form.url}
                  onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                  placeholder="https://api.example.com 或 /path/to/folder"
                  className="input-base text-xs w-full"
                />
              </div>

              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>API Key / 密钥</label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))}
                  placeholder="需要时填写"
                  className="input-base text-xs w-full"
                />
              </div>

              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>同步模式</label>
                <div className="flex gap-2">
                  {['manual', 'hourly', 'daily'].map((m) => (
                    <button
                      key={m}
                      onClick={() => setForm((p) => ({ ...p, syncInterval: m }))}
                      className="chip text-xs py-1 px-3 transition-colors"
                      style={{
                        backgroundColor: form.syncInterval === m ? 'var(--accent)' : undefined,
                        color: form.syncInterval === m ? '#0a0f1e' : undefined,
                      }}
                    >
                      {m === 'manual' ? '手动' : m === 'hourly' ? '每小时' : '每天'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => setShowModal(false)} className="btn-ghost text-xs py-2 px-4">取消</button>
              <button onClick={handleSave} disabled={!form.name.trim()} className="btn-primary text-xs py-2 px-4">
                {editingId ? '保存修改' : '创建数据源'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
