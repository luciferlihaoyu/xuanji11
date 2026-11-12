import { useMemo, useState } from 'react';
import { Cloud, HardDrive, Link2, FolderOpen, RefreshCw, Plus, X, Check, Trash2, Pencil, Upload, Newspaper, ExternalLink } from 'lucide-react';
import { useDataSources } from '@/hooks/useDataSources';
import { useAppStore } from '@/store/useAppStore';
import MobileDrawer from '@/components/MobileDrawer';
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
// implemented = 后端 datasource-router.ts 的 IMPLEMENTED_DATA_SOURCE_TYPES（cloud_drive / nas / rss）是否真正实现同步。
// 未实现的类型不禁用（允许先建档、留个意向记录），但三处必须让用户在建档前就看见：
// ①下拉显示名追加「（暂未实现）」；②下拉下方一行说明；③列表卡片灰色小标签。
const TYPE_OPTIONS: { value: string; label: string; implemented: boolean }[] = [
  { value: 'cloud_drive', label: '云盘', implemented: true },
  { value: 'nas', label: 'NAS', implemented: true },
  { value: 'database', label: '数据库', implemented: false },
  { value: 'api', label: 'API', implemented: false },
  { value: 'webhook', label: 'Webhook', implemented: false },
  { value: 'rss', label: 'RSS', implemented: true },
  { value: 'obsidian', label: 'Obsidian', implemented: false },
  { value: 'notion', label: 'Notion', implemented: false },
];

/** 同步尚未实现的类型集合（列表卡片据此打灰标；不在表内的未知类型不算，避免把脏数据误标） */
const NOT_IMPLEMENTED_TYPES: ReadonlySet<string> = new Set(
  TYPE_OPTIONS.filter((o) => !o.implemented).map((o) => o.value),
);

/** 下拉显示名：未实现类型打上后缀，选型那一刻即可见 */
function typeOptionLabel(opt: { label: string; implemented: boolean }): string {
  return opt.implemented ? opt.label : `${opt.label}（暂未实现）`;
}

// 云盘平台选项
const CLOUD_PLATFORMS = [
  { value: '115', label: '115网盘' },
  { value: 'aliyundrive', label: '阿里云盘' },
];

// 同步模式选项（t7）：后端调度器尚未实现自动同步，hourly / daily 只做占位记录 ——
// 按钮灰置不可选 + title 说明，避免用户以为设了就会自动跑。manual 为默认且始终可用。
const SYNC_MODE_OPTIONS = [
  { value: 'manual', label: '手动', available: true },
  { value: 'hourly', label: '每小时', available: false },
  { value: 'daily', label: '每天', available: false },
] as const;

const AUTO_SYNC_DISABLED_HINT = '自动调度尚未实现，请用手动同步';

// t2：后端读侧出参统一掩码（config.apiKey === "***masked***"，与 api/lib/setting-mask 的 MASK 同字面量）。
// 编辑表单不得把掩码当真值回填——见 handleOpenEdit / handleSave。
const MASKED_VALUE = '***masked***';

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
  // 只订阅 addToast（引用稳定），避免整店订阅导致每次弹 toast 都重渲染整页
  const addToast = useAppStore((s) => s.addToast);

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', type: 'rss' as string, platform: '' as string, url: '', apiKey: '', refreshToken: '', syncInterval: 'manual' });
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
    setForm({ name: '', type: 'rss', platform: '', url: '', apiKey: '', refreshToken: '', syncInterval: 'manual' });
    setShowModal(true);
  };

  const handleOpenEdit = (ds: Record<string, unknown>) => {
    setEditingId(ds.id as number);
    setSaveError('');
    const config = (ds.config as Record<string, unknown>) || {};
    // t2：敏感字段（apiKey/refreshToken）读侧返回的是掩码/secretFields 标记——表单置空，
    // 由 placeholder 提示"已保存，留空则不修改"；留空提交时该字段被剔除，后端合并时保留库中原值。
    const secretFields = new Set<string>((ds.secretFields as string[] | undefined) ?? []);
    const secretOrMasked = (key: string, v: unknown): string => {
      if (typeof v !== 'string') return '';
      return v === MASKED_VALUE || secretFields.has(key) ? '' : v;
    };
    setForm({
      name: (ds.name as string) || '',
      // ④ 编辑态**保留原值**，绝不做实现性回填。
      // 旧写法 `(ds.type as string) || 'rss'`：库里若存着不在 TYPE_OPTIONS 里的历史类型（数据由更早版本/导入写入），
      // 会被静默回填成 rss —— 用户一保存虽不改 type，但表单已展示成 RSS，用户以为类型就是 RSS，
      // 下次同步就会按 RSS 连接器去跑一个网盘源。这里原样回填，由表单给出提示。
      type: typeof ds.type === 'string' ? ds.type : '',
      platform: (config.platform as string) || '',
      url: (config.url as string) || '',
      apiKey: secretOrMasked('apiKey', config.apiKey),
      refreshToken: secretOrMasked('refreshToken', config.refreshToken),
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
      // t2：敏感字段留空 = 不修改——从提交体剔除，让后端 strip/合并跳过该键，保留库中原值。
      if (!form.apiKey) delete config.apiKey;
      if (!form.refreshToken) delete config.refreshToken;
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
    // 防连点（2026-10-01）：按钮虽已 disabled，但状态更新是异步的，同一帧内连点仍可能进来两次；
    // 同一源并发两轮同步会在「确保归档文件夹存在」那一刻竞态（可能建出重名子夹）。
    if (testingIds.has(id)) return;
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
    if (syncingIds.has(id)) return; // 同上：同一源不许并发同步
    setSyncingIds((prev) => new Set(prev).add(id));
    try {
      // ① 必须接住后端返回值：sync 会如实回报本轮结果（全成功 / 部分成功 / 索引失败 / 类型未实现 …），
      // success 与 message 里带着精确计数与原因。旧实现裸 await、只用 console.error 兜异常，
      // 等于把后端写好的 message 全扔掉，用户只能从卡片红色 lastError 倒推发生了什么。
      const result = await sync({ id });
      const sourceName = dataSources.find((s) => s.id === id)?.name;
      const message = String(result.message ?? '').trim() || (result.success ? '同步完成' : '同步失败');
      addToast({
        type: result.success ? 'success' : 'error',
        title: message,
        description: sourceName ? `数据源：${sourceName}` : undefined,
      });
    } catch (err) {
      console.error('同步失败:', err);
      // 网络/HTTP 层失败：后端 message 拿不到，如实说"请求失败"，不要伪装成"同步完成"。
      addToast({
        type: 'error',
        title: '同步请求失败',
        description: err instanceof Error && err.message ? err.message : '请检查网络连接后重试',
      });
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
      <div className="p-3 sm:p-5 lg:p-6 flex items-center justify-center min-h-[400px]" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <RefreshCw className="w-6 h-6 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  const batchPct = batchParse.valid.length ? Math.round((batchProgress / batchParse.valid.length) * 100) : 0;

  // 当前所选类型是否真能同步（决定「类型」下方那行说明的强调色；未实现项用橙色提醒）
  const selectedTypeImplemented = TYPE_OPTIONS.find((o) => o.value === form.type)?.implemented ?? true;

  // ④ 当前表单里的类型是否在本页的 TYPE_OPTIONS 里。
  // 为 false = 编辑态打开了一个「历史类型」（库里的值不在下拉列表中）：
  // 下拉要把它作为一个原值选项显示出来，并明确告诉用户保存不会改写它。
  const formTypeInOptions = TYPE_OPTIONS.some((o) => o.value === form.type);

  // ── 数据源表单字段（桌面居中弹窗与移动端右侧抽屉共用同一份，避免两处走样）──
  const formFields = (
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
          {/* ④ 历史类型不在列表中时，把它原样放进选项，让下拉显示"真实值"而不是空白/错位 */}
          {!formTypeInOptions && (
            <option value={form.type}>
              {form.type ? `${form.type}（历史类型，保存保持原值）` : '（未设置，保存保持原值）'}
            </option>
          )}
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{typeOptionLabel(opt)}</option>
          ))}
        </select>
        {/* ④ 历史类型提示：保存不会把它改写成 RSS 之类的已实现类型 */}
        {!formTypeInOptions && (
          <p className="text-[11px] mt-1 break-words" style={{ color: '#FB923C' }}>
            该数据源的历史类型「{form.type || '未设置'}」不在当前列表中，保存将保持原值（不会被改写成其他类型）。
          </p>
        )}
        {/* 选型即知情：哪几种真能同步、哪几种只是建档占位（未实现项不禁用，仅标注） */}
        <p
          className="text-[11px] mt-1 break-words"
          style={{ color: selectedTypeImplemented ? 'var(--text-muted)' : '#FB923C' }}
        >
          云盘 / NAS / RSS 已支持实际同步；其余类型（数据库 / API / Webhook / Obsidian / Notion）当前仅可建档保存，同步时会提示尚未实现。
        </p>
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
            <p className="text-[11px] mt-1 break-words" style={{ color: '#FB923C' }}>
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
          <p className="text-[11px] mt-1 break-words" style={{ color: '#FB923C' }}>
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
          placeholder={editingId ? '已保存，留空则不修改' : form.platform === '115' ? '115 OAuth 授权后的 access_token' : '需要时填写'}
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
            placeholder={editingId ? '已保存，留空则不修改' : '阿里云盘 refresh_token'}
            className="input-base text-xs w-full"
          />
          <p className="text-[11px] mt-1 break-words" style={{ color: 'var(--text-muted)' }}>
            refresh_token 用于自动刷新 access_token，长期有效
          </p>
        </div>
      )}

      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>同步模式</label>
        <div className="flex flex-wrap gap-2">
          {SYNC_MODE_OPTIONS.map((m) => {
            const active = form.syncInterval === m.value;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => setForm((p) => ({ ...p, syncInterval: m.value }))}
                disabled={!m.available}
                aria-disabled={!m.available}
                title={m.available ? undefined : AUTO_SYNC_DISABLED_HINT}
                className="chip text-xs py-1 px-3 transition-colors min-h-10 sm:min-h-0 inline-flex items-center disabled:cursor-not-allowed"
                style={
                  m.available
                    ? {
                        backgroundColor: active ? 'var(--accent)' : undefined,
                        color: active ? '#0a0f1e' : undefined,
                      }
                    : {
                        // 灰置占位：不用 opacity 压暗（浅色下会糊成一片），改用主题灰底 + 次级文字保证深浅色都可读
                        backgroundColor: 'var(--bg-tertiary)',
                        color: 'var(--text-secondary)',
                        borderColor: 'var(--border-subtle)',
                      }
                }
              >
                {m.label}
              </button>
            );
          })}
        </div>
        {/* 诚实提示：与后端 datasource-router 的 syncIntervalNotice 口径一致 */}
        {form.syncInterval !== 'manual' ? (
          <p className="text-[11px] mt-1.5 break-words" style={{ color: '#FB923C' }}>
            这条数据源存的是「{form.syncInterval === 'hourly' ? '每小时' : '每天'}」偏好，但自动调度尚未实现——仍只能手动点卡片上的「同步」，建议改选「手动」。
          </p>
        ) : (
          <p className="text-[11px] mt-1.5 break-words" style={{ color: 'var(--text-muted)' }}>
            手动模式：创建后需自行点击卡片上的「同步」按钮拉取内容。「每小时 / 每天」为灰置占位——自动调度尚未实现。
          </p>
        )}
      </div>

      {saveError && (
        <p className="text-[11px] break-words" style={{ color: '#EF4444' }}>保存失败：{saveError}</p>
      )}
    </div>
  );

  // ── 表单操作按钮：桌面右对齐一行（原样），移动端底部抽屉内两枚全宽按钮 ──
  const formActionsDesktop = (
    <div className="flex justify-end gap-2 mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <button onClick={() => setShowModal(false)} className="btn-ghost text-xs py-2 px-4">取消</button>
      <button onClick={handleSave} disabled={!form.name.trim()} className="btn-primary text-xs py-2 px-4">
        {editingId ? '保存修改' : '创建数据源'}
      </button>
    </div>
  );

  const formActionsMobile = (
    <div className="flex gap-2">
      <button onClick={() => setShowModal(false)} className="btn-ghost text-xs py-2 px-4 flex-1 min-h-10 inline-flex items-center justify-center">取消</button>
      <button onClick={handleSave} disabled={!form.name.trim()} className="btn-primary text-xs py-2 px-4 flex-1 min-h-10 inline-flex items-center justify-center">
        {editingId ? '保存修改' : '创建数据源'}
      </button>
    </div>
  );

  return (
    <div className="p-3 sm:p-5 lg:p-6 min-h-app" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Stats */}
      <div className="flex flex-wrap items-center justify-between gap-y-3 mb-4 sm:mb-6">
        <div className="flex gap-6 mb-0">
          <div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>{connectedCount} 个</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>已连接源</div>
          </div>
          <div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>{dataSources.length} 个</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>总数据源</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={handleOpenBatch} className="btn-ghost text-xs py-2.5 sm:py-2 px-4 flex items-center gap-1.5 min-h-10 sm:min-h-0">
            <Upload className="w-3.5 h-3.5" />
            批量导入
          </button>
          <button onClick={handleOpenCreate} aria-label="添加数据源（打开配置面板）" className="btn-primary text-xs py-2.5 sm:py-2 px-4 flex items-center gap-1.5 min-h-10 sm:min-h-0">
            <Plus className="w-3.5 h-3.5" />
            添加数据源
          </button>
        </div>
      </div>

      {/* 批量操作条（2026-10-01）：勾选若干源 → 一键测试连接 / 一键同步 */}
      {dataSources.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer min-h-10 sm:min-h-0">
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
              <button onClick={handleBatchTest} disabled={opsRunning} className="btn-ghost py-2.5 sm:py-1.5 px-3 min-h-10 sm:min-h-0">
                批量测试连接
              </button>
              <button onClick={handleBatchSync} disabled={opsRunning} className="btn-ghost py-2.5 sm:py-1.5 px-3 min-h-10 sm:min-h-0">
                批量同步
              </button>
              <button onClick={() => setSelected(new Set())} disabled={opsRunning} className="btn-ghost py-2.5 sm:py-1.5 px-3 min-h-10 sm:min-h-0">
                取消选择
              </button>
            </>
          )}
          {batchNote && <span className="break-words" style={{ color: 'var(--accent-cyan)' }}>{batchNote}</span>}
          <span className="w-full sm:w-auto sm:ml-auto flex flex-wrap items-center gap-2">
            <button onClick={handleOrganize} disabled={organizing} className="btn-ghost py-2.5 sm:py-1.5 px-3 min-h-10 sm:min-h-0" title="把归档功能上线前入库的旧文档挪进各自的源文件夹（只动尚未归档的）">
              {organizing ? '整理中…' : '整理历史内容'}
            </button>
            {organizeNote && <span className="break-words" style={{ color: 'var(--text-muted)' }}>{organizeNote}</span>}
          </span>
        </div>
      )}

      {/* Source Cards */}
      {dataSources.length === 0 ? (
        <div className="text-center py-16 rounded-xl border border-dashed" style={{ borderColor: 'var(--border-subtle)' }}>
          <HardDrive className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>暂无数据源</p>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>添加你的第一个数据源，连接外部知识库</p>
          <button onClick={handleOpenCreate} aria-label="添加数据源（打开配置面板）" className="btn-primary text-xs py-2.5 sm:py-2 px-4 min-h-10 sm:min-h-0">添加数据源</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 mb-6 sm:mb-8">
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
                <div className="flex flex-wrap items-start justify-between gap-y-2 mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <input
                      type="checkbox"
                      checked={selected.has(source.id)}
                      onChange={() => setSelected(toggleId(selected, source.id))}
                      title="勾选后可批量测试连接 / 批量同步"
                    />
                    <div className="w-10 h-10 shrink-0 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${config.color}20` }}>
                      <Icon className="w-5 h-5" style={{ color: config.color }} />
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold break-all" style={{ color: 'var(--text-primary)' }}>{source.name}</h4>
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
                  <div className="flex flex-wrap gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                    <button onClick={() => setStreamFor({ id: source.id, name: source.name })} aria-label={`查看 ${source.name} 的入库内容`} className="p-1.5 rounded hover:bg-white/5 min-w-10 min-h-10 sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center" style={{ color: '#FBBF24' }} title="内容（入库文章流）">
                      <Newspaper className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleTest(source.id)} disabled={isTesting} aria-label={`测试 ${source.name} 的连接`} className="p-1.5 rounded hover:bg-white/5 min-w-10 min-h-10 sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center" style={{ color: '#34D399' }} title="测试连接">
                      {isTesting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    </button>
                    <button onClick={() => handleSync(source.id)} disabled={isSyncing} aria-label={`同步 ${source.name}`} className="p-1.5 rounded hover:bg-white/5 min-w-10 min-h-10 sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center" style={{ color: 'var(--accent)' }} title="同步">
                      <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    </button>
                    <button onClick={() => handleOpenEdit(source)} aria-label={`编辑 ${source.name} 的配置（打开配置面板）`} className="p-1.5 rounded hover:bg-white/5 min-w-10 min-h-10 sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center" style={{ color: 'var(--text-muted)' }} title="编辑">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(source.id)} aria-label={`删除 ${source.name}`} className="p-1.5 rounded hover:bg-red-500/10 min-w-10 min-h-10 sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center" style={{ color: '#EF4444' }} title="删除">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2 mb-3 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="chip text-[10px] py-0.5 px-2" style={{ backgroundColor: `${config.color}20`, color: config.color }}>{config.label}</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{source.type}</span>
                    {/* 未实现类型才打灰标；已实现的 cloud_drive / nas / rss 保持清爽无标签 */}
                    {NOT_IMPLEMENTED_TYPES.has(source.type) && (
                      <span
                        className="chip text-[10px] py-0.5 px-2 shrink-0"
                        style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', borderColor: 'var(--border-subtle)' }}
                        title="该类型的同步尚未实现，仅保存了配置；点「同步」会提示尚未实现"
                      >
                        暂未实现
                      </span>
                    )}
                  </div>
                  {dsConfig.url && typeof dsConfig.url === 'string' && (
                    <code className="text-xs sm:text-[11px] block break-all sm:truncate min-w-0" style={{ color: 'var(--text-muted)' }}>{dsConfig.url}</code>
                  )}
                  {source.lastError && (
                    // ① 颜色按 source.status 分档，不要一律红：
                    //   · status==='error'        → 红：源本身不可达（连不上/配置错），是真故障；
                    //   · status==='connected'    → 琥珀：源可达，只是这批索引失败（后端新口径 indexOnlyFailure），
                    //                              报红会让用户跑去查网盘配置而白忙一场；
                    //   · 其他状态（syncing / disconnected）→ 次级灰，避免在同步中把旧错误喊成故障。
                    <p
                      className="text-xs sm:text-[11px] break-all sm:truncate min-w-0"
                      style={{
                        color:
                          source.status === 'error'
                            ? '#EF4444'
                            : source.status === 'connected'
                              ? '#FB923C'
                              : 'var(--text-muted)',
                      }}
                      title={source.lastError}
                    >
                      {source.lastError}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
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

      {/* Add/Edit 面板：≥md 居中弹窗（桌面视觉原样），<md 收进右侧 MobileDrawer（遮罩/Esc/滚动锁由基座负责） */}
      {showModal && (
        <>
          <div className="fixed inset-0 z-50 hidden md:flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
            <div className="animate-scale-in rounded-lg border p-4 sm:p-6 w-[480px] max-w-[calc(100vw-2rem)] max-h-[90dvh] overflow-y-auto" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                  {editingId ? '编辑数据源' : '添加数据源'}
                </h3>
                <button onClick={() => setShowModal(false)} className="p-1 rounded hover:bg-white/5" aria-label="关闭数据源配置面板">
                  <X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                </button>
              </div>

              {formFields}

              {formActionsDesktop}
            </div>
          </div>

          <MobileDrawer
            open={showModal}
            onClose={() => setShowModal(false)}
            side="right"
            title={editingId ? '编辑数据源' : '添加数据源'}
            ariaLabel="数据源配置面板"
            footer={formActionsMobile}
          >
            <div className="p-3">{formFields}</div>
          </MobileDrawer>
        </>
      )}

      {/* Batch Import Modal (t6) */}
      {showBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="animate-scale-in rounded-lg border p-4 sm:p-6 w-[560px] max-w-[calc(100vw-2rem)] max-h-[90dvh] overflow-y-auto overscroll-contain" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between gap-2 mb-4">
              <h3 className="text-lg font-bold break-words" style={{ color: 'var(--text-primary)' }}>批量导入 RSS 数据源</h3>
              <button onClick={() => setShowBatch(false)} disabled={batchRunning} aria-label="关闭批量导入" className="p-1 rounded hover:bg-white/5 disabled:opacity-40 min-w-10 min-h-10 sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center shrink-0">
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
                      <div key={r.lineNo} className="text-[11px] flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                        <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>L{r.lineNo}</span>
                        <span className="break-all min-w-0" style={{ color: r.error ? '#EF4444' : 'var(--text-primary)' }}>{r.name}</span>
                        <code className="break-all min-w-0" style={{ color: 'var(--text-muted)' }}>{r.url}</code>
                        {r.error && <span className="break-words" style={{ color: '#EF4444' }}>— {r.error}</span>}
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
                      <div key={`${f.url}-${i}`} className="text-[11px] min-w-0">
                        <span className="break-all" style={{ color: '#EF4444' }}>✗ {f.name}</span>
                        <code className="block break-all mt-0.5 min-w-0" style={{ color: 'var(--text-muted)' }}>{f.url}</code>
                        <span className="break-words" style={{ color: 'var(--text-secondary)' }}>原因：{f.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col sm:flex-row justify-end gap-2 mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => setShowBatch(false)} disabled={batchRunning} className="btn-ghost text-xs py-2 px-4 min-h-10 sm:min-h-0 disabled:opacity-40">
                {batchResult ? '关闭' : '取消'}
              </button>
              <button
                onClick={handleBatchImport}
                disabled={batchRunning || batchParse.overLimit || batchParse.valid.length === 0}
                className="btn-primary text-xs py-2 px-4 min-h-10 sm:min-h-0 disabled:opacity-40"
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
        className="animate-scale-in w-full max-w-xl h-full overflow-y-auto overscroll-contain border-l px-3 pt-3 pb-safe sm:p-6"
        style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 mb-4">
          <div className="min-w-0">
            <h3 className="text-lg font-bold break-all" style={{ color: 'var(--text-primary)' }}>内容 · {name}</h3>
            <p className="text-xs mt-0.5 break-words" style={{ color: 'var(--text-muted)' }}>
              {streamQuery.isLoading ? '加载中…' : `共 ${items.length} 条（按入库时间倒序，只含同步成功条目）`}
            </p>
          </div>
          <button onClick={onClose} aria-label="关闭内容流" className="p-1 rounded hover:bg-white/5 min-w-10 min-h-10 sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center shrink-0">
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
                  className="w-full text-left text-sm font-medium hover:opacity-80 break-words py-1"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {expanded ? '▾ ' : '▸ '}{it.name}
                </button>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px] sm:text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  <span>{new Date(it.createdAt).toLocaleString()}</span>
                  {it.sourceUrl && (
                    <a href={it.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--accent-cyan)' }}>
                      <ExternalLink className="w-3 h-3" />原文
                    </a>
                  )}
                  {it.documentId ? <span>文档 #{it.documentId}</span> : null}
                </div>
                {expanded && (
                  <div className="mt-2 pt-2 border-t text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
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
