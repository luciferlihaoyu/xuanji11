import { useState, useMemo, useEffect, useCallback } from 'react';
import { useAppStore, DEFAULT_PERMISSIONS } from '@/store/useAppStore';
import type { Agent, AgentStatus, AgentType } from '@/store/useAppStore';
import { useAgents } from '@/hooks/useAgents';
import { trpcClient } from '@/providers/trpc';
import PermissionSelector from '@/components/PermissionSelector';
import { isSameDay, isWithinInterval, startOfDay, endOfDay, subDays } from 'date-fns';
import { Search, Grid3X3, List, Plus, X, Activity, Shield, Zap, Users, Pencil, Trash2, Eye, EyeOff, KeyRound, Copy } from 'lucide-react';

const ABILITY_LABELS = ['知识管理', '内容创作', '编程', '数据分析', '沟通', '学习'];
const AGENT_STATUS_OPTIONS: ReadonlyArray<{ value: AgentStatus; label: string }> = [
  { value: 'active', label: '活跃' },
  { value: 'inactive', label: '停用' },
  { value: 'error', label: '异常' },
  { value: 'training', label: '训练中' },
];
const AGENT_TYPE_OPTIONS: ReadonlyArray<{ value: AgentType; label: string }> = [
  { value: 'assistant', label: '助手' },
  { value: 'analyst', label: '分析师' },
  { value: 'curator', label: '策展人' },
  { value: 'connector', label: '连接器' },
  { value: 'custom', label: '自定义' },
];

function getStatusMeta(status: AgentStatus) {
  switch (status) {
    case 'active':
      return { label: '活跃', dotClass: 'status-dot-online', color: 'var(--accent-emerald)' };
    case 'inactive':
      return { label: '停用', dotClass: 'status-dot-offline', color: 'var(--text-muted)' };
    case 'error':
      return { label: '异常', dotClass: 'status-dot-offline', color: 'var(--accent-rose)' };
    case 'training':
      return { label: '训练中', dotClass: 'status-dot-online', color: 'var(--accent-amber)' };
  }
}

function getAvatarGradient(name: string) {
  const colors = [
    'linear-gradient(135deg, #22D3EE, #A78BFA)',
    'linear-gradient(135deg, #34D399, #14B8A6)',
    'linear-gradient(135deg, #A78BFA, #7C3AED)',
    'linear-gradient(135deg, #FB7185, #EC4899)',
    'linear-gradient(135deg, #FBBF24, #F97316)',
    'linear-gradient(135deg, #FB923C, #F43F5E)',
    'linear-gradient(135deg, #22D3EE, #3B82F6)',
    'linear-gradient(135deg, #34D399, #22D3EE)',
    'linear-gradient(135deg, #94A3B8, #64748B)',
    'linear-gradient(135deg, #22D3EE, #34D399)',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function AgentManagement() {
  const { addToast } = useAppStore();
  const { agents, create, update, delete: deleteAgent, updatePermissions, testLlmConnection, isLoading } = useAgents();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [filterDept, setFilterDept] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Add/Edit form state
  const [formData, setFormData] = useState<Partial<Agent>>({});
  const [formPermissions, setFormPermissions] = useState<Agent['permissions']>({ ...DEFAULT_PERMISSIONS });
  const [isEditing, setIsEditing] = useState(false);

  // LLM config state
  const [llmConfig, setLlmConfig] = useState({
    llm_api_url: '',
    llm_api_key: '',
    llm_model: '',
    temperature: 0.7,
    max_tokens: 2048,
  });
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [testLlmStatus, setTestLlmStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [testLlmMessage, setTestLlmMessage] = useState('');

  // API Key management state
  const [apiKeys, setApiKeys] = useState<Array<{
    id: number;
    name: string;
    keyPrefix: string;
    scopes: string[] | null;
    isActive: 'true' | 'false';
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  }>>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyExpiry, setKeyExpiry] = useState('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [revokeConfirmId, setRevokeConfirmId] = useState<number | null>(null);
  const [revokingKey, setRevokingKey] = useState(false);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => {
      if (filterDept !== 'all' && a.department !== filterDept) return false;
      if (filterStatus !== 'all' && a.status !== filterStatus) return false;
      if (searchQuery && !a.name.toLowerCase().includes(searchQuery.toLowerCase()) && !a.role.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [agents, filterDept, filterStatus, searchQuery]);

  const selectedAgentData = agents.find((a) => a.id === selectedAgent);
  const activeCount = agents.filter((a) => a.status === 'active').length;
  const today = new Date();
  const todayOps = agents.filter((a) => isSameDay(new Date(a.createdAt), today)).length;
  const recent7d = agents.filter((a) =>
    isWithinInterval(new Date(a.createdAt), {
      start: startOfDay(subDays(today, 6)),
      end: endOfDay(today),
    })
  ).length;
  const depts = [...new Set(agents.map((a) => a.department))];

  // Sync LLM config when selected agent changes
  useEffect(() => {
    if (selectedAgentData) {
      const cfg = (selectedAgentData as { config?: Record<string, unknown> }).config || {};
      setLlmConfig({
        llm_api_url: String(cfg.llm_api_url || ''),
        llm_api_key: String(cfg.llm_api_key || ''),
        llm_model: String(cfg.llm_model || ''),
        temperature: Number(cfg.temperature ?? 0.7),
        max_tokens: Number(cfg.max_tokens ?? 2048),
      });
      setTestLlmStatus('idle');
      setTestLlmMessage('');
    }
  }, [selectedAgentData]);

  // Fetch API keys when selected agent changes
  const refreshApiKeys = useCallback(async (agentId: string) => {
    setApiKeysLoading(true);
    try {
      const keys = await trpcClient.agent.listApiKeys.query({ agentId: Number(agentId) });
      setApiKeys(keys);
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || '获取 API 密钥失败' });
    } finally {
      setApiKeysLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    if (!selectedAgent) {
      setApiKeys([]);
      return;
    }
    setGeneratedKey(null);
    setShowGenerateForm(false);
    setKeyName('');
    setKeyExpiry('');
    refreshApiKeys(selectedAgent);
  }, [selectedAgent, refreshApiKeys]);

  const formatDate = (date: Date | null | string) => {
    if (!date) return '从未';
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const handleGenerateApiKey = async () => {
    if (!selectedAgent || !keyName.trim()) {
      addToast({ type: 'error', title: '请输入密钥名称' });
      return;
    }
    setGeneratingKey(true);
    try {
      const result = await trpcClient.agent.generateApiKey.mutate({
        agentId: Number(selectedAgent),
        name: keyName.trim(),
        expiresAt: keyExpiry || undefined,
      });
      setGeneratedKey(result.key);
      setShowGenerateForm(false);
      setKeyName('');
      setKeyExpiry('');
      await refreshApiKeys(selectedAgent);
      addToast({ type: 'success', title: 'API 密钥已生成' });
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || '生成密钥失败' });
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleRevokeApiKey = async (keyId: number) => {
    setRevokingKey(true);
    try {
      await trpcClient.agent.revokeApiKey.mutate({ keyId });
      setRevokeConfirmId(null);
      if (selectedAgent) await refreshApiKeys(selectedAgent);
      addToast({ type: 'info', title: '密钥已撤销' });
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || '撤销密钥失败' });
    } finally {
      setRevokingKey(false);
    }
  };

  const handleCopyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      addToast({ type: 'success', title: '已复制到剪贴板' });
    } catch {
      addToast({ type: 'error', title: '复制失败' });
    }
  };

  const handleAddAgent = async () => {
    if (!formData.name || !formData.role || !formData.department) {
      addToast({ type: 'error', title: '请填写完整信息' });
      return;
    }
    try {
      await create({
        name: formData.name,
        role: formData.role,
        type: formData.type || 'custom',
        status: formData.status || 'active',
        department: formData.department,
        platform: formData.platform || '天宫',
        capabilities: (formData.capabilities?.length ? formData.capabilities : ['知识管理']).filter(Boolean),
        avatar: formData.name.charAt(0),
        knowledgeAccess: formData.knowledgeAccess || '指定文件夹',
        abilities: formData.abilities || { knowledge: 70, creation: 60, coding: 50, analysis: 60, communication: 70, learning: 65 },
        permissions: formPermissions,
      });
      addToast({ type: 'success', title: `Agent「${formData.name}」已添加` });
      resetForm();
      setShowAddModal(false);
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || '添加失败' });
    }
  };

  const handleEditAgent = async () => {
    if (!selectedAgent || !formData.name) return;
    try {
      await update(selectedAgent, {
        ...formData,
        permissions: formPermissions,
      } as Partial<Agent>);
      addToast({ type: 'success', title: `Agent「${formData.name}」已更新` });
      resetForm();
      setShowAddModal(false);
      setIsEditing(false);
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || '更新失败' });
    }
  };

  const handleDeleteAgent = async (id: string) => {
    try {
      await deleteAgent(id);
      setShowDeleteConfirm(null);
      setSelectedAgent(null);
      addToast({ type: 'info', title: 'Agent 已删除' });
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || '删除失败' });
    }
  };

  const openAddModal = () => {
    resetForm();
    setIsEditing(false);
    setShowAddModal(true);
  };

  const openEditModal = (agent: Agent) => {
    setFormData({ ...agent });
    setFormPermissions({ ...agent.permissions });
    setIsEditing(true);
    setShowAddModal(true);
  };

  const resetForm = () => {
    setFormData({});
    setFormPermissions({ ...DEFAULT_PERMISSIONS });
  };

  const handleSaveLlmConfig = async () => {
    if (!selectedAgent) return;
    try {
      await update(selectedAgent, {
        config: {
          llm_api_url: llmConfig.llm_api_url,
          llm_api_key: llmConfig.llm_api_key,
          llm_model: llmConfig.llm_model,
          temperature: llmConfig.temperature,
          max_tokens: llmConfig.max_tokens,
        },
      });
      addToast({ type: 'success', title: 'LLM 配置已保存' });
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || '保存失败' });
    }
  };

  const handleTestLlm = async () => {
    if (!llmConfig.llm_api_url || !llmConfig.llm_api_key) {
      addToast({ type: 'error', title: '请填写 API URL 和 API Key' });
      return;
    }
    setTestLlmStatus('loading');
    try {
      const result = await testLlmConnection({
        apiUrl: llmConfig.llm_api_url,
        apiKey: llmConfig.llm_api_key,
        model: llmConfig.llm_model || undefined,
      });
      setTestLlmStatus(result.success ? 'success' : 'error');
      setTestLlmMessage(result.message);
    } catch (err: any) {
      setTestLlmStatus('error');
      setTestLlmMessage(err.message || '测试失败');
    }
  };

  const renderRadarChart = (abilities: any) => {
    const values = [abilities.knowledge, abilities.creation, abilities.coding, abilities.analysis, abilities.communication, abilities.learning];
    const cx = 120, cy = 120, radius = 80;
    const angleStep = (Math.PI * 2) / 6;
    const points = values.map((v: number, i: number) => {
      const angle = angleStep * i - Math.PI / 2;
      const r = (v / 100) * radius;
      return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
    }).join(' ');
    const labelPoints = ABILITY_LABELS.map((label, i) => {
      const angle = angleStep * i - Math.PI / 2;
      const r = radius + 20;
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), label };
    });

    return (
      <svg viewBox="0 0 240 240" className="w-48 h-48">
        {[0.2, 0.4, 0.6, 0.8, 1].map((scale) => {
          const hexPoints = Array.from({ length: 6 }, (_, i) => {
            const angle = angleStep * i - Math.PI / 2;
            return `${cx + radius * scale * Math.cos(angle)},${cy + radius * scale * Math.sin(angle)}`;
          }).join(' ');
          return <polygon key={scale} points={hexPoints} fill="none" stroke="var(--border-subtle)" strokeWidth="0.5" />;
        })}
        {Array.from({ length: 6 }, (_, i) => {
          const angle = angleStep * i - Math.PI / 2;
          return <line key={i} x1={cx} y1={cy} x2={cx + radius * Math.cos(angle)} y2={cy + radius * Math.sin(angle)} stroke="var(--border-subtle)" strokeWidth="0.5" />;
        })}
        <polygon points={points} fill="rgba(34,211,238,0.15)" stroke="#22D3EE" strokeWidth="2" />
        {values.map((v: number, i: number) => {
          const angle = angleStep * i - Math.PI / 2;
          const r = (v / 100) * radius;
          return <circle key={i} cx={cx + r * Math.cos(angle)} cy={cy + r * Math.sin(angle)} r="3" fill="#22D3EE" />;
        })}
        {labelPoints.map((lp, i) => (
          <text key={i} x={lp.x} y={lp.y} textAnchor="middle" dominantBaseline="central" fill="var(--text-muted)" fontSize="10">{lp.label}</text>
        ))}
      </svg>
    );
  };

  return (
    <div className="p-6" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: '全部 Agent', value: agents.length, icon: Users, color: 'var(--accent-cyan)' },
          { label: '活跃', value: activeCount, icon: Activity, color: 'var(--accent-emerald)' },
          { label: '今日操作', value: todayOps, icon: Zap, color: 'var(--accent-cyan)' },
          { label: '待审核', value: recent7d, icon: Shield, color: 'var(--accent-amber)' },
        ].map((stat) => (
          <div key={stat.label} className="card-base flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold" style={{ color: stat.color }}>{stat.value}</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{stat.label}</div>
            </div>
            <stat.icon className="w-6 h-6" style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center flex-1 min-w-[200px] max-w-sm h-8 px-3 rounded border" style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)' }}>
          <Search className="w-4 h-4 mr-2" style={{ color: 'var(--text-muted)' }} />
          <input type="text" placeholder="搜索 Agent..." className="bg-transparent text-xs outline-none w-full" style={{ color: 'var(--text-primary)' }} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </div>
        <select className="h-8 px-3 rounded border text-xs outline-none" style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
          <option value="all">全部部门</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="h-8 px-3 rounded border text-xs outline-none" style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">全部状态</option>
          {AGENT_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => setViewMode('grid')} className="p-2 rounded" style={{ backgroundColor: viewMode === 'grid' ? 'var(--bg-tertiary)' : 'transparent', color: viewMode === 'grid' ? 'var(--accent-cyan)' : 'var(--text-muted)' }}><Grid3X3 className="w-4 h-4" /></button>
          <button onClick={() => setViewMode('list')} className="p-2 rounded" style={{ backgroundColor: viewMode === 'list' ? 'var(--bg-tertiary)' : 'transparent', color: viewMode === 'list' ? 'var(--accent-cyan)' : 'var(--text-muted)' }}><List className="w-4 h-4" /></button>
          <button onClick={openAddModal} className="btn-primary text-xs py-2 px-3 ml-2 flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" />添加 Agent</button>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        </div>
      )}

      {/* Agent Grid/List */}
      {!isLoading && (viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredAgents.map((agent) => (
            <div key={agent.id} className="card-base cursor-pointer group" onClick={() => setSelectedAgent(agent.id)}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-base font-bold shrink-0" style={{ background: getAvatarGradient(agent.name), color: '#0A0E1A' }}>{agent.name.charAt(0)}</div>
                  <div>
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{agent.name}</h4>
                    <span className="chip text-[10px] py-0.5 px-2">{agent.role}</span>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => openEditModal(agent)} className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }} title="编辑"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setShowDeleteConfirm(agent.id)} className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }} title="删除"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs mb-2" style={{ color: 'var(--text-muted)' }}><span>{agent.department}</span><span>·</span><span>{agent.platform}</span></div>
              <div className="flex items-center gap-2 mb-2">
                <span className={getStatusMeta(agent.status).dotClass} />
                <span className="text-xs" style={{ color: getStatusMeta(agent.status).color }}>{getStatusMeta(agent.status).label}</span>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{agent.lastHeartbeat}</span>
              </div>
              <div className="flex flex-wrap gap-1 mb-1">
                {agent.capabilities.slice(0, 3).map((cap) => (<span key={cap} className="chip chip-violet text-[10px] py-0.5 px-2">{cap}</span>))}
              </div>
              {/* Permission summary */}
              <div className="flex items-center gap-1 mt-2">
                <Shield className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {Object.entries(agent.permissions).filter(([, v]) => v).length}/7 权限
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
          <table className="w-full text-sm">
            <thead><tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
              {['Agent', '角色', '部门', '状态', '权限', '操作'].map((h) => (<th key={h} className="text-left px-4 py-2.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{h}</th>))}
            </tr></thead>
            <tbody>
              {filteredAgents.map((agent) => (
                <tr key={agent.id} className="border-t cursor-pointer hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'var(--border-subtle)' }} onClick={() => setSelectedAgent(agent.id)}>
                  <td className="px-4 py-3"><div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style={{ background: getAvatarGradient(agent.name), color: '#0A0E1A' }}>{agent.name.charAt(0)}</div>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
                  </div></td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{agent.role}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{agent.department}</td>
                  <td className="px-4 py-3"><div className="flex items-center gap-1.5"><span className={getStatusMeta(agent.status).dotClass} /><span className="text-xs" style={{ color: getStatusMeta(agent.status).color }}>{getStatusMeta(agent.status).label}</span></div></td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{Object.entries(agent.permissions).filter(([, v]) => v).length}/7</td>
                  <td className="px-4 py-3"><div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => openEditModal(agent)} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setShowDeleteConfirm(agent.id)} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><Trash2 className="w-3.5 h-3.5" /></button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* Detail Drawer */}
      {selectedAgentData && (
        <div className="fixed top-12 right-0 bottom-0 w-[480px] z-40 border-l overflow-y-auto animate-slide-in-right" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <div className="p-6">
            <div className="flex items-start justify-between mb-6">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold" style={{ background: getAvatarGradient(selectedAgentData.name), color: '#0A0E1A' }}>{selectedAgentData.name.charAt(0)}</div>
                <div><h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{selectedAgentData.name}</h2><span className="chip">{selectedAgentData.role}</span></div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => openEditModal(selectedAgentData)} className="p-2 rounded hover:bg-white/5" style={{ color: 'var(--accent-cyan)' }} title="编辑"><Pencil className="w-4 h-4" /></button>
                <button onClick={() => setSelectedAgent(null)} className="p-2 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X className="w-5 h-5" /></button>
              </div>
            </div>

            {/* Info */}
            <div className="space-y-2 mb-6">
              {[{ label: 'ID', value: selectedAgentData.id }, { label: '部门', value: selectedAgentData.department }, { label: '平台', value: selectedAgentData.platform }].map((item) => (
                <div key={item.label} className="flex justify-between py-1.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                  <span className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{item.value}</span>
                </div>
              ))}
            </div>

            {/* Status */}
            <div className="card-base mb-6"><div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><span className={getStatusMeta(selectedAgentData.status).dotClass} /><span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{getStatusMeta(selectedAgentData.status).label}</span></div>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>心跳: {selectedAgentData.lastHeartbeat}</span>
            </div></div>

            {/* Permissions - editable */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}><Shield className="w-4 h-4" />权限配置</h4>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>点击切换</span>
              </div>
              <PermissionSelector
                permissions={selectedAgentData.permissions}
                onChange={async (perms) => {
                  try {
                    await updatePermissions(selectedAgentData.id, perms);
                    addToast({ type: 'success', title: '权限已更新' });
                  } catch (err: any) {
                    addToast({ type: 'error', title: err.message || '权限更新失败' });
                  }
                }}
                showPresets={true}
              />
            </div>

            {/* API Keys */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}><KeyRound className="w-4 h-4" />API 密钥</h4>
                <button
                  onClick={() => { setShowGenerateForm(!showGenerateForm); setGeneratedKey(null); }}
                  className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />生成密钥
                </button>
              </div>

              {/* Generated key display - shown once after creation */}
              {generatedKey && (
                <div className="bg-yellow-900/20 border border-yellow-500/30 rounded p-3 mb-3">
                  <p className="text-xs mb-2" style={{ color: 'var(--accent-amber)' }}>
                    重要：请立即复制此密钥，它不会再次显示。
                  </p>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={generatedKey}
                      className="input-base text-xs flex-1 font-mono"
                      onClick={(e) => e.currentTarget.select()}
                    />
                    <button
                      onClick={() => handleCopyKey(generatedKey)}
                      className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5"
                    >
                      <Copy className="w-3.5 h-3.5" />复制
                    </button>
                    <button
                      onClick={() => setGeneratedKey(null)}
                      className="btn-ghost text-xs py-2 px-3"
                    >
                      关闭
                    </button>
                  </div>
                </div>
              )}

              {/* Generate form */}
              {showGenerateForm && (
                <div className="card-base mb-3 space-y-3">
                  <div>
                    <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>密钥名称 *</label>
                    <input
                      type="text"
                      value={keyName}
                      onChange={(e) => setKeyName(e.target.value)}
                      placeholder="如：生产环境密钥"
                      className="input-base text-xs w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>过期时间（可选）</label>
                    <input
                      type="date"
                      value={keyExpiry}
                      onChange={(e) => setKeyExpiry(e.target.value)}
                      className="input-base text-xs w-full"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleGenerateApiKey}
                      disabled={generatingKey || !keyName.trim()}
                      className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" />{generatingKey ? '生成中...' : '生成'}
                    </button>
                    <button
                      onClick={() => { setShowGenerateForm(false); setKeyName(''); setKeyExpiry(''); }}
                      className="btn-ghost text-xs py-2 px-3"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* Key list */}
              {apiKeysLoading ? (
                <div className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
              ) : apiKeys.length === 0 ? (
                <div className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>暂无 API 密钥</div>
              ) : (
                <div className="space-y-2">
                  {apiKeys.map((key) => (
                    <div key={key.id} className="card-base p-3">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-mono" style={{ color: 'var(--accent-cyan)' }}>{key.keyPrefix}...</span>
                            <span className={`chip text-[10px] py-0.5 px-2 ${key.isActive === 'true' ? 'chip-emerald' : 'chip-rose'}`}>
                              {key.isActive === 'true' ? '活跃' : '已撤销'}
                            </span>
                          </div>
                          <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{key.name}</div>
                        </div>
                        {key.isActive === 'true' && (
                          <button
                            onClick={() => setRevokeConfirmId(key.id)}
                            className="btn-danger text-[10px] py-1 px-2"
                          >
                            撤销
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span>创建: {formatDate(key.createdAt)}</span>
                        <span>·</span>
                        <span>最后使用: {formatDate(key.lastUsedAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Revoke confirmation */}
              {revokeConfirmId !== null && (
                <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
                  <div className="animate-scale-in rounded-lg border p-5 w-[360px]" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                    <h4 className="text-base font-bold mb-2" style={{ color: 'var(--text-primary)' }}>确认撤销密钥</h4>
                    <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>撤销后，使用此密钥的所有请求将立即被拒绝。此操作不可撤销。</p>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setRevokeConfirmId(null)} className="btn-ghost text-xs py-2 px-4">取消</button>
                      <button onClick={() => handleRevokeApiKey(revokeConfirmId)} disabled={revokingKey} className="btn-danger text-xs py-2 px-4">
                        {revokingKey ? '撤销中...' : '确认撤销'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* LLM Config */}
            <div className="mb-6">
              <h4 className="text-sm font-semibold mb-3 flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}><Zap className="w-4 h-4" />LLM 配置</h4>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>API URL</label>
                  <input
                    type="text"
                    value={llmConfig.llm_api_url}
                    onChange={(e) => setLlmConfig({ ...llmConfig, llm_api_url: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                    className="input-base text-xs w-full"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>API Key</label>
                  <div className="flex gap-2">
                    <input
                      type={showLlmKey ? 'text' : 'password'}
                      value={llmConfig.llm_api_key}
                      onChange={(e) => setLlmConfig({ ...llmConfig, llm_api_key: e.target.value })}
                      placeholder="sk-..."
                      className="input-base text-xs flex-1"
                    />
                    <button
                      onClick={() => setShowLlmKey(!showLlmKey)}
                      className="p-2 rounded border"
                      style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                      title={showLlmKey ? '隐藏' : '显示'}
                    >
                      {showLlmKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>模型</label>
                    <input
                      type="text"
                      value={llmConfig.llm_model}
                      onChange={(e) => setLlmConfig({ ...llmConfig, llm_model: e.target.value })}
                      placeholder="gpt-3.5-turbo"
                      className="input-base text-xs w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>Max Tokens</label>
                    <input
                      type="number"
                      value={llmConfig.max_tokens}
                      onChange={(e) => setLlmConfig({ ...llmConfig, max_tokens: Number(e.target.value) })}
                      className="input-base text-xs w-full"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>Temperature: {llmConfig.temperature}</label>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={llmConfig.temperature}
                    onChange={(e) => setLlmConfig({ ...llmConfig, temperature: Number(e.target.value) })}
                    className="w-full"
                  />
                </div>
                <div className="flex items-center gap-2 pt-2">
                  <button onClick={handleTestLlm} className="btn-ghost text-xs py-2 px-3 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5" />测试连接
                  </button>
                  <button onClick={handleSaveLlmConfig} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5">
                    <Pencil className="w-3.5 h-3.5" />保存配置
                  </button>
                  {testLlmStatus !== 'idle' && testLlmStatus !== 'loading' && (
                    <span className="text-xs" style={{ color: testLlmStatus === 'success' ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
                      {testLlmMessage}
                    </span>
                  )}
                  {testLlmStatus === 'loading' && (
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>测试中...</span>
                  )}
                </div>
              </div>
            </div>

            {/* Radar */}
            <div className="mb-6"><h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>能力评估</h4>
              <div className="flex justify-center">{renderRadarChart(selectedAgentData.abilities)}</div>
              <div className="grid grid-cols-3 gap-2 mt-3">
                {ABILITY_LABELS.map((label, i) => {
                  const vals = [selectedAgentData.abilities.knowledge, selectedAgentData.abilities.creation, selectedAgentData.abilities.coding, selectedAgentData.abilities.analysis, selectedAgentData.abilities.communication, selectedAgentData.abilities.learning];
                  return (<div key={label} className="text-center"><div className="text-sm font-bold" style={{ color: 'var(--accent-cyan)' }}>{vals[i]}</div><div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</div></div>);
                })}
              </div>
            </div>

            {/* Danger */}
            <div className="pt-4" style={{ borderTop: '2px solid var(--accent-rose)' }}>
              <button onClick={() => setShowDeleteConfirm(selectedAgentData.id)} className="btn-danger w-full text-xs py-2">断开连接</button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="animate-scale-in rounded-lg border p-6 w-[560px] max-h-[85vh] overflow-y-auto" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{isEditing ? '编辑 Agent' : '添加 Agent'}</h3>
              <button onClick={() => { setShowAddModal(false); resetForm(); setIsEditing(false); }} className="p-1 rounded hover:bg-white/5"><X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} /></button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>名称 *</label><input type="text" value={formData.name || ''} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="如：新助手" className="input-base text-xs" /></div>
                <div><label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>角色 *</label><input type="text" value={formData.role || ''} onChange={(e) => setFormData({ ...formData, role: e.target.value })} placeholder="如：内容编辑" className="input-base text-xs" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>部门 *</label>
                  <select value={formData.department || ''} onChange={(e) => setFormData({ ...formData, department: e.target.value })} className="input-base text-xs">
                    <option value="">选择部门</option>
                    {['技术部', '内容部', '行政部', '财务部', '管理层'].map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div><label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>类型</label>
                  <select value={formData.type || 'custom'} onChange={(e) => setFormData({ ...formData, type: e.target.value as AgentType })} className="input-base text-xs">
                    {AGENT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>平台</label>
                  <select value={formData.platform || '天宫'} onChange={(e) => setFormData({ ...formData, platform: e.target.value })} className="input-base text-xs">
                    <option value="天宫">天宫 Hub</option>
                    <option value="自定义">自定义 API</option>
                  </select>
                </div>
                <div><label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>状态</label>
                  <select value={formData.status || 'active'} onChange={(e) => setFormData({ ...formData, status: e.target.value as AgentStatus })} className="input-base text-xs">
                    {AGENT_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
              </div>
              <div><label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>能力标签（逗号分隔）</label>
                <input type="text" value={(formData.capabilities || []).join(', ')} onChange={(e) => setFormData({ ...formData, capabilities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="知识管理, 内容创作, 数据分析" className="input-base text-xs" />
              </div>

              {/* Permissions */}
              <div className="pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <h4 className="text-sm font-semibold mb-3 flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}><Shield className="w-4 h-4" />权限设置</h4>
                <PermissionSelector permissions={formPermissions} onChange={setFormPermissions} showPresets={true} />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => { setShowAddModal(false); resetForm(); setIsEditing(false); }} className="btn-ghost text-xs py-2 px-4">取消</button>
              <button onClick={isEditing ? handleEditAgent : handleAddAgent} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" />{isEditing ? '保存修改' : '添加 Agent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="animate-scale-in rounded-lg border p-5 w-[360px]" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <h4 className="text-base font-bold mb-2" style={{ color: 'var(--text-primary)' }}>确认删除</h4>
            <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>此操作不可撤销，Agent 的所有关联数据将被移除。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDeleteConfirm(null)} className="btn-ghost text-xs py-2 px-4">取消</button>
              <button onClick={() => handleDeleteAgent(showDeleteConfirm)} className="btn-danger text-xs py-2 px-4">确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
