import { useState, useMemo } from 'react';
import { useAppStore, DEFAULT_PERMISSIONS } from '@/store/useAppStore';
import type { Agent, AgentPermission } from '@/store/useAppStore';
import PermissionSelector from '@/components/PermissionSelector';
import { Search, Grid3X3, List, Plus, X, Activity, Shield, Zap, Users, Pencil, Trash2 } from 'lucide-react';

const ABILITY_LABELS = ['知识管理', '内容创作', '编程', '数据分析', '沟通', '学习'];

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
  const { agents, addAgent, updateAgent, deleteAgent, setAgentPermissions, addToast } = useAppStore();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [filterDept, setFilterDept] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Add/Edit form state
  const [formData, setFormData] = useState<Partial<Agent>>({});
  const [formPermissions, setFormPermissions] = useState<AgentPermission>({ ...DEFAULT_PERMISSIONS });
  const [isEditing, setIsEditing] = useState(false);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => {
      if (filterDept !== 'all' && a.department !== filterDept) return false;
      if (filterStatus !== 'all' && a.status !== filterStatus) return false;
      if (searchQuery && !a.name.toLowerCase().includes(searchQuery.toLowerCase()) && !a.role.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [agents, filterDept, filterStatus, searchQuery]);

  const selectedAgentData = agents.find((a) => a.id === selectedAgent);
  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const depts = [...new Set(agents.map((a) => a.department))];

  const handleAddAgent = () => {
    if (!formData.name || !formData.role || !formData.department) {
      addToast({ type: 'error', title: '请填写完整信息' });
      return;
    }
    addAgent({
      name: formData.name,
      role: formData.role,
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
  };

  const handleEditAgent = () => {
    if (!selectedAgent || !formData.name) return;
    updateAgent(selectedAgent, {
      ...formData,
      permissions: formPermissions,
    } as Partial<Agent>);
    addToast({ type: 'success', title: `Agent「${formData.name}」已更新` });
    resetForm();
    setShowAddModal(false);
    setIsEditing(false);
  };

  const handleDeleteAgent = (id: string) => {
    deleteAgent(id);
    setShowDeleteConfirm(null);
    setSelectedAgent(null);
    addToast({ type: 'info', title: 'Agent 已删除' });
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
          { label: '在线', value: onlineCount, icon: Activity, color: 'var(--accent-emerald)' },
          { label: '今日操作', value: 247, icon: Zap, color: 'var(--accent-cyan)' },
          { label: '待审核', value: 3, icon: Shield, color: 'var(--accent-amber)' },
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
          <option value="online">在线</option>
          <option value="offline">离线</option>
        </select>
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => setViewMode('grid')} className="p-2 rounded" style={{ backgroundColor: viewMode === 'grid' ? 'var(--bg-tertiary)' : 'transparent', color: viewMode === 'grid' ? 'var(--accent-cyan)' : 'var(--text-muted)' }}><Grid3X3 className="w-4 h-4" /></button>
          <button onClick={() => setViewMode('list')} className="p-2 rounded" style={{ backgroundColor: viewMode === 'list' ? 'var(--bg-tertiary)' : 'transparent', color: viewMode === 'list' ? 'var(--accent-cyan)' : 'var(--text-muted)' }}><List className="w-4 h-4" /></button>
          <button onClick={openAddModal} className="btn-primary text-xs py-2 px-3 ml-2 flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" />添加 Agent</button>
        </div>
      </div>

      {/* Agent Grid/List */}
      {viewMode === 'grid' ? (
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
                <span className={agent.status === 'online' ? 'status-dot-online' : 'status-dot-offline'} />
                <span className="text-xs" style={{ color: agent.status === 'online' ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>{agent.status === 'online' ? '在线' : '离线'}</span>
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
                  <td className="px-4 py-3"><div className="flex items-center gap-1.5"><span className={agent.status === 'online' ? 'status-dot-online' : 'status-dot-offline'} /><span className="text-xs" style={{ color: agent.status === 'online' ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>{agent.status === 'online' ? '在线' : '离线'}</span></div></td>
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
      )}

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
              <div className="flex items-center gap-2"><span className={selectedAgentData.status === 'online' ? 'status-dot-online' : 'status-dot-offline'} /><span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{selectedAgentData.status === 'online' ? '在线' : '离线'}</span></div>
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
                onChange={(perms) => {
                  setAgentPermissions(selectedAgentData.id, perms);
                  addToast({ type: 'success', title: '权限已更新' });
                }}
                showPresets={true}
              />
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
                <div><label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>平台</label>
                  <select value={formData.platform || '天宫'} onChange={(e) => setFormData({ ...formData, platform: e.target.value })} className="input-base text-xs">
                    <option value="天宫">天宫 Hub</option>
                    <option value="自定义">自定义 API</option>
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
