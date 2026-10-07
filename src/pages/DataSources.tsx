import { useMemo, useState } from 'react';
import { Cloud, HardDrive, Link2, FolderOpen, RefreshCw, Plus, X, Check, Trash2, Pencil, Upload, Newspaper, ExternalLink } from 'lucide-react';
import { useDataSources } from '@/hooks/useDataSources';
import { trpc } from '@/providers/trpc';
import { runSequential, toggleAllIds, toggleId } from '@/lib/batch';

// 平台配置（显示用）
const PLATFORM_CONFIG: Record<string, { icon: typeof Cloud; color: string; label: string; hint?: string }> = {
  // 类型
  cloud_drive: { icon: Cloud, color: '#22D3EE', label: '云盘' },
  nas: { icon: HardDrive, color: '#A78BFA', label: 'NAS' },
  api: { icon: Link2, color: '#34D399', label: 'API' },
  webhook: { icon: Link2, color: '#F472B6', label: 'Webhook' },
  database: { icon: HardDrive, color: '#60A5FA', label: '数据库' },
  obsidian: { icon: FolderOpen, color: '#A78BFA', label: 'Obsidian' },
  notion: { icon: FolderOpen, color: '#FBBF24', label: 'Notion' },
  rss: { icon: Link2, color: '#FB923C', label: 'RSS 订阅', hint: '填 RSS/Atom feed 地址；仅入库 feed 自带的标题/摘要/正文，不会去抓取文章网页；RSS 为只读源，不参与上传/备份' },
  // 具体平台
  '115': { icon: Cloud, color: '#FF6B35', label: '115网盘', hint: '需到 open.115.com 申请开发者' },
  aliyundrive: { icon: Cloud, color: '#00C6FF', label: '阿里云盘', hint: '需到 alipan.com/developer 申请开发者' },
};

// 类型选项
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

// 云盘平台选项
const CLOUD_PLATFORMS = [
  { value: '115', label: '115网盘' },
  { value: 'aliyundrive', label: '阿里云盘' },
];

// ---------- 批量导入（t6）：纯解析逻辑，不发任何网络请求 ----------

/** 单次批量导入的非空行数上限（export 仅为便于对纯解析函数做离线校验，页面内直接引用） */
export const BATCH_LIMIT = 200;

export type BatchRow = {
  lineNo: number;      // 原始行号（1-based，含空行占位）
  raw: string;         // trim 后的原始行
  name: string;        // 最终名称（用户提供或自动生成）
  url: string;         // 规范化后的 URL（合法时）或原始输入（非法时）
  error?: string;      // 客户端校验失败/重复原因
};

export type BatchParseResult = {
  rows: BatchRow[];        // 全部非空行（含非法/重复，供预览反馈）
  valid: BatchRow[];       // 可提交条目
  skipped: number;         // 跳过的空行数
  invalid: number;         // 客户端校验失败条数
  dupes: number;           // 去重掉的重复条数
  overLimit: boolean;      // 超出单次上限
};

/** 解析多行输入：每行 `URL` 或 `名称 | URL`（支持全角｜，按第一个分隔符切分）。
 *  逐行 trim、跳过空行、按规范化 URL 去重（首个生效，后续标记重复）。 */
export function parseBatchInput(text: string): BatchParseResult {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines
    .map((l, i) => ({ lineNo: i + 1, raw: l.trim() }))
    .filter((l) => l.raw.length > 0);

  const overLimit = nonEmpty.length > BATCH_LIMIT;
  const rows: BatchRow[] = [];
  const seenUrl = new Map<string, number>(); // 规范化 URL -> 首次出现的行号
  const autoNameCount = new Map<string, number>(); // 自动生成的同名域名计数
  let autoSeq = 0;

  for (const { lineNo, raw } of nonEmpty) {
    const asciiSep = raw.indexOf('|');
    const fullSep = raw.indexOf('｜');
    let sep = -1;
    if (asciiSep === -1) sep = fullSep;
    else if (fullSep === -1) sep = asciiSep;
    else sep = Math.min(asciiSep, fullSep);

    const namePart = sep === -1 ? '' : raw.slice(0, sep).trim();
    const urlPart = (sep === -1 ? raw : raw.slice(sep + 1)).trim();

    let urlObj: URL | null = null;
    try {
      urlObj = new URL(urlPart);
    } catch {
      urlObj = null;
    }
    if (!urlObj || (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:')) {
      rows.push({ lineNo, raw, name: namePart || '(未命名)', url: urlPart, error: 'URL 格式非法（需 http/https 开头的 feed 地址）' });
      continue;
    }

    const normalized = urlObj.href;
    const firstLine = seenUrl.get(normalized);
    if (firstLine !== undefined) {
      rows.push({ lineNo, raw, name: namePart || '(未命名)', url: normalized, error: `与第 ${firstLine} 行重复（已自动去重）` });
      continue;
    }
    seenUrl.set(normalized, lineNo);

    let name = namePart;
    if (!name) {
      // 自动生成：优先域名（去 www.），兜底 `第 N 条RSS源`；同名域名追加序号避免混淆
      const host = urlObj.hostname.replace(/^www\./i, '');
      if (host) {
        const c = (autoNameCount.get(host) ?? 0) + 1;
        autoNameCount.set(host, c);
        name = c > 1 ? `${host} (${c})` : host;
      } else {
        autoSeq += 1;
        name = `第 ${autoSeq} 条RSS源`;
      }
    }
    if (name.length > 255) name = name.slice(0, 255); // 后端 name 上限 255
    rows.push({ lineNo, raw, name, url: normalized });
  }

  const valid = overLimit ? [] : rows.filter((r) => !r.error);
  return {
    rows,
    valid,
    skipped: lines.length - nonEmpty.length,
    invalid: rows.filter((r) => r.error && !r.error.includes('重复')).length,
    dupes: rows.filter((r) => r.error && r.error.includes('重复')).length,
    overLimit,
  };
}

type BatchImportResult = {
  total: number;
  ok: number;
  failed: { name: string; url: string; reason: string }[];
};

export default function DataSources() {
  const {
    dataSources,
    isLoading,
    create,
    update,
    delete: deleteDs,
    testConnection,
    sync,
    organizeExisting,
  } = useDataSources();

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', type: 'api' as string, platform: '' as string, url: '', apiKey: '', refreshToken: '', syncInterval: 'manual' });
  const [saveError, setSaveError] = useState('');
  const [syncingIds, setSyncingIds] = useState<Set<number>>(new Set());
  const [testingIds, setTestingIds] = useState<Set<number>>(new Set());

  // 批量导入弹层状态
  const [streamFor, setStreamFor] = useState<{ id: number; name: string } | null>(null);
  // 批量勾选与批量操作（2026-10-01 用户诉求：勾选某几个源 → 一键连接/一键同步）
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [opsRunning, setOpsRunning] = useState(false);
  const [batchNote, setBatchNote] = useState('');
  const [organizeNote, setOrganizeNote] = useState('');
  const [organizing, setOrganizing] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchResult, setBatchResult] = useState<BatchImportResult | null>(null);

  const batchParse = useMemo(() => parseBatchInput(batchText), [batchText]);

  const handleOpenCreate = () => {
    setEditingId(null);
    setSaveError('');
    setForm({ name: '', type: 'api', platform: '', url: '', apiKey: '', refreshToken: '', syncInterval: 'manual' });
    setShowModal(true);
  };

  const handleOpenEdit = (ds: Record<string, unknown>) => {
    setEditingId(ds.id as number);
    setSaveError('');
    const config = (ds.config as Record<string, unknown>) || {};
    setForm({
      name: (ds.name as string) || '',
      type: (ds.type as string) || 'api',
      platform: (config.platform as string) || '',
      url: (config.url as string) || '',
      apiKey: (config.apiKey as string) || '',
      refreshToken: (config.refreshToken as string) || '',
      syncInterval: (config.syncInterval as string) || 'manual',
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaveError('');
    try {
      const config: Record<string, unknown> = {
        url: form.url,
        apiKey: form.apiKey,
        refreshToken: form.refreshToken,
        syncInterval: form.syncInterval,
      };
      // rss 显式携带 platform，不依赖后端兜底；其余类型沿用平台选择器结果
      if (form.type === 'rss') config.platform = 'rss';
      else if (form.platform) config.platform = form.platform;

      if (editingId) {
        await update({ id: editingId, name: form.name, config });
      } else {
        await create({
          name: form.name,
          type: form.type as "cloud_drive" | "nas" | "database" | "api" | "webhook" | "rss" | "notion" | "obsidian",
          config,
        });
      }
      setShowModal(false);
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : '保存失败，请重试');
    }
  };

  const handleOpenBatch = () => {
    setBatchText('');
    setBatchResult(null);
    setBatchProgress(0);
    setBatchRunning(false);
    setShowBatch(true);
  };

  /** 逐条串行调用既有 create mutation；单条失败不中断其余条目 */
  const handleBatchImport = async () => {
    const items = batchParse.valid;
    if (!items.length || batchParse.overLimit || batchRunning) return;
    setBatchRunning(true);
    setBatchResult(null);
    setBatchProgress(0);
    const failed: BatchImportResult['failed'] = [];
    let ok = 0;
    for (const row of items) {
      try {
        await create({
          name: row.name,
          type: 'rss' as const,
          config: { platform: 'rss', url: row.url, syncInterval: 'manual' },
        });
        ok += 1;
      } catch (err) {
        const reason = (err instanceof Error && err.message ? err.message : String(err)).slice(0, 200);
        failed.push({ name: row.name, url: row.url, reason });
      }
      setBatchProgress(ok + failed.length);
    }
    setBatchResult({ total: items.length, ok, failed });
    setBatchRunning(false);
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

  /** 批量测试连接：串行（不并发打爆上游），单条失败不拦其余，逐条进度。 */
  const handleBatchTest = async () => {
    const ids = dataSources.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (ids.length === 0 || opsRunning) return;
    setOpsRunning(true);
    setBatchNote(`测试连接中 0/${ids.length}`);
    try {
      const { done, failed } = await runSequential(
        ids,
        async (id) => {
          setTestingIds((prev) => new Set(prev).add(id));
          try {
            await testConnection({ id });
          } finally {
            setTestingIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        },
        (n, total) => setBatchNote(`测试连接中 ${n}/${total}`),
      );
      setBatchNote(failed.length > 0 ? `测试完成：成功 ${done}，失败 ${failed.length}` : `测试完成：${done} 个全部有响应`);
      setSelected(new Set());
    } finally {
      setOpsRunning(false);
    }
  };

  /** 批量同步：同样串行 + 失败隔离 + 逐条进度。 */
  const handleBatchSync = async () => {
    const ids = dataSources.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (ids.length === 0 || opsRunning) return;
    setOpsRunning(true);
    setBatchNote(`同步中 0/${ids.length}`);
    try {
      const { done, failed } = await runSequential(
        ids,
        async (id) => {
          setSyncingIds((prev) => new Set(prev).add(id));
          try {
            await sync({ id });
          } finally {
            setSyncingIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        },
        (n, total) => setBatchNote(`同步中 ${n}/${total}`),
      );
      setBatchNote(failed.length > 0 ? `同步完成：成功 ${done}，失败 ${failed.length}` : `同步完成：${done} 个源已同步`);
      setSelected(new Set());
    } finally {
      setOpsRunning(false);
    }
  };

  /** 历史内容归位：把归档上线前悬空的旧文档挪进各自的源文件夹（只动悬空的，幂等）。 */
  const handleOrganize = async () => {
    setOrganizing(true);
    setOrganizeNote('整理中…');
    try {
      const r = await organizeExisting();
      setOrganizeNote(`✓ 已归位 ${r.moved} 份文档（涉及 ${r.folders} 个源文件夹）`);
    } catch (err) {
      setOrganizeNote(`整理失败：${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
    } finally {
      setOrganizing(false);
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

  const batchPct = batchParse.valid.length ? Math.round((batchProgress / batchParse.valid.length) * 100) : 0;

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
        <div className="flex gap-2">
          <button onClick={handleOpenBatch} className="btn-ghost text-xs py-2 px-4 flex items-center gap-1.5">
            <Upload className="w-3.5 h-3.5" />
            批量导入
          </button>
          <button onClick={handleOpenCreate} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" />
            添加数据源
          </button>
        </div>
      </div>

      {/* 批量操作条（2026-10-01）：勾选若干源 → 一键测试连接 / 一键同步 */}
      {dataSources.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={dataSources.length > 0 && dataSources.every((s) => selected.has(s.id))}
              onChange={() => setSelected(toggleAllIds(selected, dataSources.map((s) => s.id)))}
            />
            <span style={{ color: 'var(--text-secondary)' }}>全选</span>
          </label>
          {selected.size > 0 && (
            <>
              <span style={{ color: 'var(--text-muted)' }}>已选 {selected.size} 个</span>
              <button onClick={handleBatchTest} disabled={opsRunning} className="btn-ghost py-1.5 px-3">
                批量测试连接
              </button>
              <button onClick={handleBatchSync} disabled={opsRunning} className="btn-ghost py-1.5 px-3">
                批量同步
              </button>
              <button onClick={() => setSelected(new Set())} disabled={opsRunning} className="btn-ghost py-1.5 px-3">
                取消选择
              </button>
            </>
          )}
          {batchNote && <span style={{ color: 'var(--accent-cyan)' }}>{batchNote}</span>}
          <span className="ml-auto flex items-center gap-2">
            <button onClick={handleOrganize} disabled={organizing} className="btn-ghost py-1.5 px-3" title="把归档功能上线前入库的旧文档挪进各自的源文件夹（只动尚未归档的）">
              {organizing ? '整理中…' : '整理历史内容'}
            </button>
            {organizeNote && <span style={{ color: 'var(--text-muted)' }}>{organizeNote}</span>}
          </span>
        </div>
      )}

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
            // 优先使用平台配置，再回退到类型配置
            const dsConfig: Record<string, string> = (source.config as Record<string, string>) || {};
            const platform = dsConfig.platform;
            const config = (platform && PLATFORM_CONFIG[platform]) || PLATFORM_CONFIG[source.type] || PLATFORM_CONFIG.api;
            const Icon = config.icon;
            const isSyncing = syncingIds.has(source.id);
            const isTesting = testingIds.has(source.id);
            return (
              <div key={source.id} className="card-base group">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(source.id)}
                      onChange={() => setSelected(toggleId(selected, source.id))}
                      title="勾选后可批量测试连接 / 批量同步"
                    />
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
                    <button onClick={() => setStreamFor({ id: source.id, name: source.name })} className="p-1.5 rounded hover:bg-white/5" style={{ color: '#FBBF24' }} title="内容（入库文章流）">
                      <Newspaper className="w-4 h-4" />
                    </button>
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
          <div className="animate-scale-in rounded-lg border p-4 sm:p-6 w-[480px] max-w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
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
                  onChange={(e) => setForm((p) => ({ ...p, type: e.target.value, platform: e.target.value === 'cloud_drive' ? p.platform : '' }))}
                  className="input-base text-xs w-full"
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* 云盘平台选择 */}
              {form.type === 'cloud_drive' && (
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>平台 *</label>
                  <select
                    value={form.platform}
                    onChange={(e) => setForm((p) => ({ ...p, platform: e.target.value }))}
                    className="input-base text-xs w-full"
                  >
                    <option value="">请选择平台</option>
                    {CLOUD_PLATFORMS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {form.platform && PLATFORM_CONFIG[form.platform]?.hint && (
                    <p className="text-[11px] mt-1" style={{ color: '#FB923C' }}>
                      {PLATFORM_CONFIG[form.platform].hint}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>
                  {form.type === 'cloud_drive' ? 'Access Token' : form.type === 'rss' ? 'Feed 地址' : 'URL / 路径'}
                </label>
                <input
                  type="text"
                  value={form.url}
                  onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                  placeholder={form.type === 'rss' ? 'https://hnrss.org/frontpage' : 'https://api.example.com 或 /path/to/folder'}
                  className="input-base text-xs w-full"
                />
                {form.type === 'rss' && PLATFORM_CONFIG.rss.hint && (
                  <p className="text-[11px] mt-1" style={{ color: '#FB923C' }}>
                    {PLATFORM_CONFIG.rss.hint}
                  </p>
                )}
              </div>

              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>
                  {form.platform === '115' ? 'Access Token' : form.platform === 'aliyundrive' ? 'Access Token (可选)' : 'API Key / 密钥'}
                </label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))}
                  placeholder={form.platform === '115' ? '115 OAuth 授权后的 access_token' : '需要时填写'}
                  className="input-base text-xs w-full"
                />
              </div>

              {/* 阿里云盘需要 refreshToken */}
              {form.platform === 'aliyundrive' && (
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>
                    Refresh Token *
                  </label>
                  <input
                    type="password"
                    value={form.refreshToken}
                    onChange={(e) => setForm((p) => ({ ...p, refreshToken: e.target.value }))}
                    placeholder="阿里云盘 refresh_token"
                    className="input-base text-xs w-full"
                  />
                  <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    refresh_token 用于自动刷新 access_token，长期有效
                  </p>
                </div>
              )}

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
                {/* 诚实提示：与后端 datasource-router 的 notice 口径一致 */}
                {form.syncInterval !== 'manual' ? (
                  <p className="text-[11px] mt-1.5" style={{ color: '#FB923C' }}>
                    自动同步尚未启用，将仅保存配置——「每小时 / 每天」目前只是记录偏好，仍需手动点击「同步」触发。
                  </p>
                ) : (
                  <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                    手动模式：创建后需自行点击卡片上的「同步」按钮拉取内容。
                  </p>
                )}
              </div>

              {saveError && (
                <p className="text-[11px]" style={{ color: '#EF4444' }}>保存失败：{saveError}</p>
              )}
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

      {/* Batch Import Modal (t6) */}
      {showBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="animate-scale-in rounded-lg border p-4 sm:p-6 w-[560px] max-w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>批量导入 RSS 数据源</h3>
              <button onClick={() => setShowBatch(false)} disabled={batchRunning} className="p-1 rounded hover:bg-white/5 disabled:opacity-40">
                <X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>

            <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
              每行一条，格式：<code>https://example.com/feed.xml</code> 或 <code>名称 | https://example.com/feed.xml</code>。
              名称留空时自动取域名（域名也取不到则用「第 N 条RSS源」兜底）。单次最多 {BATCH_LIMIT} 行。
              仅入库条目、不做任何网络测试；feed 自带的标题/摘要/正文会被采集，不会抓取文章网页；RSS 为只读源。
            </p>

            <textarea
              value={batchText}
              onChange={(e) => { setBatchText(e.target.value); setBatchResult(null); }}
              placeholder={'Hacker News | https://hnrss.org/frontpage\nhttps://feeds.bbci.co.uk/news/rss.xml'}
              rows={8}
              disabled={batchRunning}
              className="input-base text-xs w-full font-mono"
              style={{ resize: 'vertical' }}
            />

            {/* 解析预览（提交前） */}
            {!batchResult && !batchRunning && batchParse.rows.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  解析结果：可提交 <b style={{ color: '#34D399' }}>{batchParse.valid.length}</b> 条
                  {batchParse.invalid > 0 && <>，非法 <b style={{ color: '#EF4444' }}>{batchParse.invalid}</b> 条</>}
                  {batchParse.dupes > 0 && <>，重复已去除 <b style={{ color: '#FB923C' }}>{batchParse.dupes}</b> 条</>}
                  {batchParse.skipped > 0 && <>，跳过空行 {batchParse.skipped}</>}
                </div>
                {batchParse.overLimit ? (
                  <p className="text-[11px]" style={{ color: '#EF4444' }}>
                    非空行 {batchParse.rows.length} 条，已超过单次上限 {BATCH_LIMIT} 行，请分批导入。
                  </p>
                ) : (
                  <div className="max-h-40 overflow-y-auto rounded border p-2 space-y-1" style={{ borderColor: 'var(--border-subtle)' }}>
                    {batchParse.rows.map((r) => (
                      <div key={r.lineNo} className="text-[11px] flex items-baseline gap-2">
                        <span style={{ color: 'var(--text-muted)' }}>L{r.lineNo}</span>
                        <span style={{ color: r.error ? '#EF4444' : 'var(--text-primary)' }}>{r.name}</span>
                        <code className="truncate" style={{ color: 'var(--text-muted)' }}>{r.url}</code>
                        {r.error && <span style={{ color: '#EF4444' }}>— {r.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 进度 */}
            {batchRunning && (
              <div className="mt-3">
                <div className="text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
                  正在导入 {batchProgress} / {batchParse.valid.length} …
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border-subtle)' }}>
                  <div className="h-full transition-all" style={{ width: `${batchPct}%`, backgroundColor: 'var(--accent)' }} />
                </div>
              </div>
            )}

            {/* 结果反馈：逐条列出失败 URL 与原因 */}
            {batchResult && (
              <div className="mt-3 space-y-2">
                {batchResult.failed.length === 0 ? (
                  <p className="text-xs" style={{ color: '#34D399' }}>
                    全部导入成功：共 {batchResult.ok} 条 RSS 数据源已创建。
                  </p>
                ) : batchResult.ok === 0 ? (
                  <p className="text-xs" style={{ color: '#EF4444' }}>
                    导入失败：{batchResult.total} 条全部未成功，请核对下方原因。
                  </p>
                ) : (
                  <p className="text-xs" style={{ color: '#FB923C' }}>
                    部分成功：成功 {batchResult.ok} 条，失败 {batchResult.failed.length} 条（失败的已在下方逐条列出）。
                  </p>
                )}
                {batchResult.failed.length > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded border p-2 space-y-1" style={{ borderColor: 'var(--border-subtle)' }}>
                    {batchResult.failed.map((f, i) => (
                      <div key={`${f.url}-${i}`} className="text-[11px]">
                        <span style={{ color: '#EF4444' }}>✗ {f.name}</span>
                        <code className="block truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{f.url}</code>
                        <span style={{ color: 'var(--text-secondary)' }}>原因：{f.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => setShowBatch(false)} disabled={batchRunning} className="btn-ghost text-xs py-2 px-4 disabled:opacity-40">
                {batchResult ? '关闭' : '取消'}
              </button>
              <button
                onClick={handleBatchImport}
                disabled={batchRunning || batchParse.overLimit || batchParse.valid.length === 0}
                className="btn-primary text-xs py-2 px-4 disabled:opacity-40"
              >
                {batchRunning ? '导入中…' : `导入 ${batchParse.valid.length} 条`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 内容流抽屉：这个数据源入库了哪些文章，直接读，不必去知识库搜 */}
      {streamFor && (
        <ContentStreamDrawer dataSourceId={streamFor.id} name={streamFor.name} onClose={() => setStreamFor(null)} />
      )}
    </div>
  );
}

/**
 * 内容流抽屉（2026-10-01）：按源聚合的入库文章列表（跨同步批次、时间倒序）。
 * 点标题展开正文（kb.getDocument 内联预览，截断 4000 字）；有原文给外链。
 * 数据来自 datasource.getContentStream —— metadata.dataSourceId 按 CAST TEXT 口径比对。
 */
function ContentStreamDrawer({ dataSourceId, name, onClose }: { dataSourceId: number; name: string; onClose: () => void }) {
  const streamQuery = trpc.datasource.getContentStream.useQuery({ dataSourceId });
  const [openItemId, setOpenItemId] = useState<number | null>(null);
  const items = streamQuery.data ?? [];
  const activeDocId = items.find((it) => it.id === openItemId)?.documentId ?? 0;
  const docQuery = trpc.kb.getDocument.useQuery({ id: activeDocId }, { enabled: activeDocId > 0 });

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }} onClick={onClose}>
      <div
        className="animate-scale-in w-full max-w-xl h-full overflow-y-auto border-l p-4 sm:p-6"
        style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>内容 · {name}</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {streamQuery.isLoading ? '加载中…' : `共 ${items.length} 条（按入库时间倒序，只含同步成功条目）`}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5">
            <X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {!streamQuery.isLoading && items.length === 0 && (
          <div className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            这个数据源还没有同步过内容 —— 回列表点一次「同步」再来看。
          </div>
        )}

        <div className="space-y-2">
          {items.map((it) => {
            const expanded = openItemId === it.id;
            return (
              <div key={it.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  onClick={() => setOpenItemId(expanded ? null : it.id)}
                  className="w-full text-left text-sm font-medium hover:opacity-80"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {expanded ? '▾ ' : '▸ '}{it.name}
                </button>
                <div className="flex items-center gap-3 mt-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  <span>{new Date(it.createdAt).toLocaleString()}</span>
                  {it.sourceUrl && (
                    <a href={it.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--accent-cyan)' }}>
                      <ExternalLink className="w-3 h-3" />原文
                    </a>
                  )}
                  {it.documentId ? <span>文档 #{it.documentId}</span> : null}
                </div>
                {expanded && (
                  <div className="mt-2 pt-2 border-t text-xs leading-relaxed whitespace-pre-wrap" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                    {it.documentId
                      ? docQuery.isLoading
                        ? '加载正文…'
                        : docQuery.data
                          ? `${String(docQuery.data.content ?? '').slice(0, 4000)}${String(docQuery.data.content ?? '').length > 4000 ? '\n\n…（正文超长已截断，完整内容在知识库）' : ''}`
                          : '正文加载失败或文档已被删除。'
                      : '该条目没有关联文档（同步时未入库正文）。'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
