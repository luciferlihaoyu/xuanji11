import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { User, BookOpen, Bot, Brain, HardDrive, Workflow, Shield, Palette, Info, Eye, EyeOff, Check, Sun, Moon, Loader2, LogOut, KeyRound, Plug } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import {
  useSettings,
  useVectorSettings,
  useAgentSettings,
  useStorageSettings,
  useAppearanceSettings,
  useVectorModelTemplates,
  useSaveVectorModelTemplate,
  useDeleteVectorModelTemplate,
  useSelectVectorModelTemplate,
} from '@/hooks/useSettings';
import { useConnectorConfig } from '@/hooks/useConnectorConfig';
import { trpc, trpcClient } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';

const SETTINGS_NAV = [
  { key: 'personal', label: '个人设置', icon: User },
  { key: 'knowledge', label: '知识库设置', icon: BookOpen },
  { key: 'agent', label: 'Agent 配置', icon: Bot },
  { key: 'vectorization', label: '向量化模型', icon: Brain },
  { key: 'storage', label: '存储管理', icon: HardDrive },
  { key: 'workflow', label: '工作流默认', icon: Workflow },
  { key: 'connector', label: '连接器', icon: Plug },
  { key: 'security', label: '安全', icon: Shield },
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'about', label: '关于', icon: Info },
];

interface ConnectorCardProps {
  connector: {
    key: string;
    name: string;
    configured: boolean;
    status: string;
  };
}

function ConnectorCard({ connector }: ConnectorCardProps) {
  const addToast = useAppStore((s) => s.addToast);
  const { config, isLoading, save, test, isSaving, isTesting } = useConnectorConfig(connector.key);
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (config && typeof config === 'object') {
      const cfg = config as Record<string, unknown>;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 从已加载配置同步表单初始值
      setForm({
        accessToken: String(cfg.accessToken ?? ''),
        refreshToken: String(cfg.refreshToken ?? ''),
        path: String(cfg.path ?? ''),
      });
    }
  }, [config]);

  const fields = connector.key === 'nas'
    ? [{ key: 'path', label: '路径' }]
    : [
        { key: 'accessToken', label: 'Access Token' },
        { key: 'refreshToken', label: 'Refresh Token' },
      ];

  const handleTest = async () => {
    const result = await test(form as Record<string, unknown>);
    addToast({
      type: result.success ? 'success' : 'error',
      title: result.success ? '连接成功' : result.message || '连接失败',
    });
  };

  const handleSave = async () => {
    await save(form as Record<string, unknown>);
    addToast({ type: 'success', title: '配置已保存' });
  };

  return (
    <div className="card-base p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{connector.name}</h4>
        <span
          className={`chip text-[10px] py-0.5 px-2 ${connector.status === 'connected' ? 'chip-emerald' : 'chip-rose'}`}
          style={{ color: connector.status === 'connected' ? 'var(--accent-emerald)' : '#ef4444' }}
        >
          {connector.status === 'connected' ? '已连接' : '未连接'}
        </span>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载配置中...
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>{f.label}</label>
              <input
                type="text"
                value={form[f.key] ?? ''}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                className="input-base text-xs w-full"
              />
            </div>
          ))}
          <div className="flex items-center gap-3 pt-2">
            <button onClick={handleTest} disabled={isTesting} className="btn-secondary text-xs py-2 px-4">
              {isTesting ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> 测试中...
                </span>
              ) : '测试连接'}
            </button>
            <button onClick={handleSave} disabled={isSaving} className="btn-primary text-xs py-2 px-4">
              {isSaving ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> 保存中...
                </span>
              ) : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectorSettings() {
  const { data: connectors, isLoading } = trpc.connector.listConnectors.useQuery();

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>连接器</h3>
      <div className="max-w-lg space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中...
          </div>
        ) : (
          connectors?.map((c) => <ConnectorCard key={c.key} connector={c} />)
        )}
      </div>
    </div>
  );
}

function toVectorProvider(value: string): 'openai' | 'minimax' | 'local' | 'custom' {
  if (value === 'openai' || value === 'minimax' || value === 'local' || value === 'custom') return value;
  return 'openai';
}

export default function Settings() {
  const { category = 'personal' } = useParams();
  const { user, logout } = useAuth();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const addToast = useAppStore((s) => s.addToast);
  const storageSettings = useStorageSettings();
  const appearanceSettings = useAppearanceSettings();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAgentToken, setShowAgentToken] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState('');
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    autoClassify: true,
    autoVectorize: true,
    autoRelate: false,
    autoSync: true,
  });

  // Security tab state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [changePwdError, setChangePwdError] = useState('');
  const [changePwdSuccess, setChangePwdSuccess] = useState(false);
  const [changePwdLoading, setChangePwdLoading] = useState(false);
  const [personalForm, setPersonalForm] = useState({
    nickname: '',
    email: '',
    timezone: 'Asia/Shanghai',
    language: 'zh-CN',
  });
  const [appearanceForm, setAppearanceForm] = useState({
    fontSize: '14',
    codeFont: 'JetBrains Mono',
  });
  const [appearanceSaved, setAppearanceSaved] = useState(false);
  const vectorSettings = useVectorSettings();
  const agentSettings = useAgentSettings();
  const { setSetting, setMany, isSetting } = useSettings();
  const { data: templates, isLoading: templatesLoading } = useVectorModelTemplates();
  const saveTemplate = useSaveVectorModelTemplate();
  const deleteTemplate = useDeleteVectorModelTemplate();
  const selectTemplate = useSelectVectorModelTemplate();

  // Local form state for vectorization
  const [vectorForm, setVectorForm] = useState({
    name: '',
    provider: 'openai',
    apiUrl: '',
    apiKey: '',
    model: 'text-embedding-3-small',
    dimension: '1536',
  });
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [indexMode, setIndexMode] = useState('realtime');
  const [similarityThreshold, setSimilarityThreshold] = useState(75);
  const [vectorSaved, setVectorSaved] = useState(false);

  useEffect(() => {
    setPersonalForm((prev) => ({
      ...prev,
      nickname: user?.name ?? '管理员',
      email: user?.email ?? 'admin@xuanji.io',
    }));
  }, [user?.name, user?.email]);

  useEffect(() => {
    if (!appearanceSettings.isLoading) {
      setAppearanceForm({
        fontSize: appearanceSettings.fontSize || '14',
        codeFont: appearanceSettings.codeFont || 'JetBrains Mono',
      });
    }
  }, [appearanceSettings.isLoading, appearanceSettings.fontSize, appearanceSettings.codeFont]);

  useEffect(() => {
    if (!vectorSaved) return;
    const id = setTimeout(() => setVectorSaved(false), 3000);
    return () => clearTimeout(id);
  }, [vectorSaved]);

  // Local form state for agent
  const [agentForm, setAgentForm] = useState({
    hubUrl: 'https://tianting.zeabur.app',
    token: '',
    heartbeat: '30',
    autoReconnect: true,
  });

  // Sync form state when backend data loads
  useEffect(() => {
    if (!vectorSettings.isLoading) {
      setVectorForm((prev) => ({
        ...prev,
        provider: vectorSettings.provider || 'openai',
        apiUrl: vectorSettings.apiUrl || '',
        apiKey: vectorSettings.apiKey || '',
        model: vectorSettings.model || 'text-embedding-3-small',
        dimension: vectorSettings.dimension || '1536',
      }));
      setIndexMode(vectorSettings.indexMode || 'realtime');
      const parsed = Number.parseFloat(vectorSettings.similarityThreshold);
      setSimilarityThreshold(Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed * 100))) : 75);
    }
  }, [vectorSettings.isLoading, vectorSettings.provider, vectorSettings.apiUrl, vectorSettings.apiKey, vectorSettings.model, vectorSettings.dimension, vectorSettings.indexMode, vectorSettings.similarityThreshold]);

  useEffect(() => {
    if (!agentSettings.isLoading) {
      setAgentForm({
        hubUrl: agentSettings.hubUrl || 'https://tianting.zeabur.app',
        token: agentSettings.token || '',
        heartbeat: agentSettings.heartbeat || '30',
        autoReconnect: agentSettings.autoReconnect === 'true',
      });
    }
  }, [agentSettings.isLoading, agentSettings.hubUrl, agentSettings.token, agentSettings.heartbeat, agentSettings.autoReconnect]);

  const toggle = (key: string) => {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const testAgentConnection = async () => {
    setTestResult(null);
    setTestError('');
    setTestLoading(true);
    try {
      const result = await trpcClient.knowledge.vectorHealth.query();
      if (result.ok) {
        setTestResult('success');
      } else {
        setTestResult('fail');
        setTestError(result.error || '连接失败，请检查配置');
      }
    } catch (err: unknown) {
      setTestResult('fail');
      setTestError(err && typeof err === 'object' && 'message' in err ? String(err.message) : '连接失败，请检查配置');
    } finally {
      setTestLoading(false);
    }
  };

  const testConnection = async () => {
    setTestResult(null);
    setTestError('');
    setTestLoading(true);
    try {
      const result = await trpcClient.setting.testVectorModelTemplate.mutate({
        provider: toVectorProvider(vectorForm.provider),
        apiUrl: vectorForm.apiUrl,
        apiKey: vectorForm.apiKey,
        model: vectorForm.model,
        dimension: Number.parseInt(vectorForm.dimension, 10) || 1536,
      });
      if (result.ok) {
        setTestResult('success');
      } else {
        setTestResult('fail');
        const parts = [result.error];
        if (result.status) parts.push(`HTTP ${result.status}`);
        if (result.resolvedUrl) parts.push(result.resolvedUrl);
        setTestError(parts.filter(Boolean).join(' · '));
      }
    } catch (err: unknown) {
      setTestResult('fail');
      setTestError(err && typeof err === 'object' && 'message' in err ? String(err.message) : '连接失败，请检查配置');
    } finally {
      setTestLoading(false);
    }
  };

  const saveVectorSettings = async () => {
    await setMany([
      { key: 'embedding_provider', value: vectorForm.provider, category: 'vectorization' },
      { key: 'embedding_api_url', value: vectorForm.apiUrl, category: 'vectorization' },
      { key: 'embedding_api_key', value: vectorForm.apiKey, category: 'vectorization' },
      { key: 'embedding_model', value: vectorForm.model, category: 'vectorization' },
      { key: 'embedding_dimension', value: vectorForm.dimension, category: 'vectorization' },
      { key: 'embedding_index_mode', value: indexMode, category: 'vectorization' },
      { key: 'embedding_similarity_threshold', value: (similarityThreshold / 100).toFixed(2), category: 'vectorization' },
    ]);
    setVectorSaved(true);
  };

  const handleNewTemplate = () => {
    setEditingTemplateId(null);
    setVectorForm({
      name: '',
      provider: 'openai',
      apiUrl: '',
      apiKey: '',
      model: 'text-embedding-3-small',
      dimension: '1536',
    });
    setIndexMode('realtime');
    setSimilarityThreshold(75);
  };

  const handleEditTemplate = async (id: string) => {
    const template = await trpcClient.setting.getVectorModelTemplate.query({ id });
    setEditingTemplateId(template.id);
    setVectorForm({
      name: template.name,
      provider: template.provider ?? 'openai',
      apiUrl: template.apiUrl,
      apiKey: template.apiKey,
      model: template.model,
      dimension: String(template.dimension ?? 1536),
    });
    setIndexMode(template.indexMode ?? 'realtime');
    const parsed = Number.parseFloat(template.similarityThreshold ?? '');
    setSimilarityThreshold(Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed * 100))) : 75);
  };

  const handleSaveTemplate = async (activate = false) => {
    if (!vectorForm.name.trim()) {
      addToast({ type: 'error', title: '请输入配置名称' });
      return;
    }
    const dimension = Number.parseInt(vectorForm.dimension, 10) || 1536;
    const summary = await saveTemplate.mutateAsync({
      id: editingTemplateId ?? undefined,
      name: vectorForm.name.trim(),
      provider: toVectorProvider(vectorForm.provider),
      apiUrl: vectorForm.apiUrl,
      apiKey: vectorForm.apiKey,
      model: vectorForm.model,
      dimension,
      indexMode,
      similarityThreshold: (similarityThreshold / 100).toFixed(2),
    });
    setEditingTemplateId(summary.id);
    if (activate) {
      await selectTemplate.mutateAsync({ id: summary.id });
    }
    addToast({ type: 'success', title: activate ? '已保存并激活' : '模板已保存' });
  };

  const handleSelectTemplate = async (id: string) => {
    await selectTemplate.mutateAsync({ id });
    addToast({ type: 'success', title: '已激活' });
  };

  const handleDeleteTemplate = async (id: string) => {
    await deleteTemplate.mutateAsync({ id });
    if (editingTemplateId === id) handleNewTemplate();
    addToast({ type: 'success', title: '已删除' });
  };

  const handleTestTemplate = async (id: string) => {
    setTestLoading(true);
    setTestResult(null);
    setTestError('');
    try {
      const template = await trpcClient.setting.getVectorModelTemplate.query({ id });
      const result = await trpcClient.setting.testVectorModelTemplate.mutate({
        id: template.id,
        provider: toVectorProvider(template.provider ?? 'openai'),
        customProviderName: template.customProviderName ?? undefined,
        apiUrl: template.apiUrl,
        apiKey: template.apiKey,
        model: template.model,
        dimension: template.dimension ?? 1536,
      });
      if (result.ok) {
        setTestResult('success');
        addToast({ type: 'success', title: '连接成功' });
      } else {
        setTestResult('fail');
        const parts = [result.error];
        if (result.status) parts.push(`HTTP ${result.status}`);
        if (result.resolvedUrl) parts.push(result.resolvedUrl);
        const message = parts.filter(Boolean).join(' · ') || '连接失败';
        setTestError(message);
        addToast({ type: 'error', title: message });
      }
    } catch (err: unknown) {
      const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : '测试失败';
      setTestResult('fail');
      setTestError(message);
      addToast({ type: 'error', title: message });
    } finally {
      setTestLoading(false);
    }
  };

  const saveAgentSettings = async () => {
    await setMany([
      { key: 'tiangong_hub_url', value: agentForm.hubUrl, category: 'agent' },
      { key: 'agent_token', value: agentForm.token, category: 'agent' },
      { key: 'heartbeat_interval', value: agentForm.heartbeat, category: 'agent' },
      { key: 'auto_reconnect', value: String(agentForm.autoReconnect), category: 'agent' },
    ]);
  };

  const saveAppearanceSettings = async () => {
    await setMany([
      { key: 'appearance_font_size', value: appearanceForm.fontSize, category: 'appearance' },
      { key: 'appearance_code_font', value: appearanceForm.codeFont, category: 'appearance' },
    ]);
    setAppearanceSaved(true);
  };

  const saveAutoCleanupSetting = async (key: string, value: boolean) => {
    await setSetting(key, String(value), 'storage');
  };

  const ToggleSwitch = ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
    <button
      onClick={onChange}
      className="relative w-9 h-5 rounded-full transition-colors duration-200"
      style={{ backgroundColor: checked ? 'var(--accent-cyan)' : 'var(--bg-tertiary)' }}
    >
      <div
        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  );

  const renderContent = () => {
    switch (category) {
      case 'personal':
        return (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>个人设置</h3>
              <div className="space-y-4 max-w-lg">
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>头像</label>
                  <div className="flex items-center gap-3">
                    <div className="w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold" style={{ background: 'linear-gradient(135deg, #22D3EE, #A78BFA)', color: '#0A0E1A' }}>{user?.name?.[0] ?? 'U'}</div>
                    <button className="btn-secondary text-xs py-1.5 px-3">更换头像</button>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>昵称</label>
                  <input
                    type="text"
                    value={personalForm.nickname}
                    onChange={(e) => setPersonalForm((prev) => ({ ...prev, nickname: e.target.value }))}
                    className="input-base text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>邮箱</label>
                  <input
                    type="email"
                    value={personalForm.email}
                    onChange={(e) => setPersonalForm((prev) => ({ ...prev, email: e.target.value }))}
                    className="input-base text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>时区</label>
                  <select
                    value={personalForm.timezone}
                    onChange={(e) => setPersonalForm((prev) => ({ ...prev, timezone: e.target.value }))}
                    className="input-base text-sm"
                  >
                    <option value="Asia/Shanghai">Asia/Shanghai (UTC+8)</option>
                    <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
                    <option value="America/New_York">America/New_York (UTC-5)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>界面语言</label>
                  <select
                    value={personalForm.language}
                    onChange={(e) => setPersonalForm((prev) => ({ ...prev, language: e.target.value }))}
                    className="input-base text-sm"
                  >
                    <option value="zh-CN">简体中文</option>
                    <option value="en-US">English</option>
                    <option value="ja-JP">日本語</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        );

      case 'knowledge':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>知识库设置</h3>
            <div className="max-w-lg space-y-4">
              <div className="card-base p-4">
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  知识库设置即将上线
                </div>
                <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  默认文件夹、默认文档格式等高级配置将在后续版本开放。
                </div>
              </div>
            </div>
          </div>
        );

      case 'agent':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Agent 配置</h3>
            <div className="space-y-4 max-w-lg">
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>天宫 Hub URL</label>
                <input
                  type="text"
                  value={agentForm.hubUrl}
                  onChange={(e) => setAgentForm((prev) => ({ ...prev, hubUrl: e.target.value }))}
                  className="input-base text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>Agent Token</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showAgentToken ? 'text' : 'password'}
                      value={agentForm.token}
                      onChange={(e) => setAgentForm((prev) => ({ ...prev, token: e.target.value }))}
                      className="input-base text-sm pr-10"
                    />
                    <button onClick={() => setShowAgentToken(!showAgentToken)} className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
                      {showAgentToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>心跳间隔（秒）</label>
                <input
                  type="number"
                  value={agentForm.heartbeat}
                  onChange={(e) => setAgentForm((prev) => ({ ...prev, heartbeat: e.target.value }))}
                  className="input-base text-sm max-w-[120px]"
                />
              </div>
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm" style={{ color: 'var(--text-primary)' }}>自动重连</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>连接断开时自动尝试重连</div>
                </div>
                <ToggleSwitch
                  checked={agentForm.autoReconnect}
                  onChange={() => setAgentForm((prev) => ({ ...prev, autoReconnect: !prev.autoReconnect }))}
                />
              </div>
              <div className="flex items-center gap-3 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button onClick={testAgentConnection} disabled={testLoading} className="btn-secondary text-xs py-2 px-4">
                  {testLoading ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 测试中...
                    </span>
                  ) : testResult === 'success' ? (
                    <span className="flex items-center gap-1" style={{ color: 'var(--accent-emerald)' }}>
                      <Check className="w-3.5 h-3.5" /> 连接成功
                    </span>
                  ) : testResult === 'fail' ? (
                    <span className="flex items-center gap-1" style={{ color: '#ef4444' }} title={testError}>
                      ✕ 连接失败
                    </span>
                  ) : '测试连接'}
                </button>
                <button onClick={saveAgentSettings} disabled={isSetting} className="btn-primary text-xs py-2 px-4">
                  {isSetting ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 保存中...
                    </span>
                  ) : '保存'}
                </button>
              </div>
            </div>
          </div>
        );

      case 'vectorization':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>向量化模型设置</h3>
            <div className="space-y-4 max-w-lg">
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>配置名称</label>
                <input
                  type="text"
                  value={vectorForm.name}
                  onChange={(e) => setVectorForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="例如 OpenAI Embedding"
                  className="input-base text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>模型提供商</label>
                <select
                  className="input-base text-sm"
                  value={vectorForm.provider}
                  onChange={(e) => setVectorForm((prev) => ({ ...prev, provider: e.target.value }))}
                >
                  <option value="openai">OpenAI</option>
                  <option value="minimax">MiniMax</option>
                  <option value="local">本地部署</option>
                  <option value="custom">自定义</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>API URL</label>
                <input
                  type="text"
                  value={vectorForm.apiUrl}
                  onChange={(e) => setVectorForm((prev) => ({ ...prev, apiUrl: e.target.value }))}
                  placeholder="https://api.openai.com/v1"
                  className="input-base text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>API Key</label>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={vectorForm.apiKey}
                    onChange={(e) => setVectorForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                    className="input-base text-sm pr-10"
                  />
                  <button onClick={() => setShowApiKey(!showApiKey)} className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>模型</label>
                <input
                  type="text"
                  value={vectorForm.model}
                  onChange={(e) => setVectorForm((prev) => ({ ...prev, model: e.target.value }))}
                  placeholder="text-embedding-3-small"
                  className="input-base text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>向量维度</label>
                <input
                  type="number"
                  value={vectorForm.dimension}
                  onChange={(e) => setVectorForm((prev) => ({ ...prev, dimension: e.target.value }))}
                  className="input-base text-sm max-w-[120px]"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>索引更新模式</label>
                <div className="flex gap-3">
                  {[
                    { label: '实时', value: 'realtime' },
                    { label: '定时', value: 'scheduled' },
                    { label: '手动', value: 'manual' },
                  ].map((m) => (
                    <label key={m.value} className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <input
                        type="radio"
                        name="indexMode"
                        value={m.value}
                        checked={indexMode === m.value}
                        onChange={() => setIndexMode(m.value)}
                        className="accent-cyan"
                      />
                      {m.label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>相似度阈值</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={similarityThreshold}
                    onChange={(e) => setSimilarityThreshold(Number(e.target.value))}
                    className="flex-1"
                    style={{ accentColor: 'var(--accent-cyan)' }}
                  />
                  <span className="text-xs w-12" style={{ color: 'var(--accent-cyan)' }}>{(similarityThreshold / 100).toFixed(2)}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button onClick={testConnection} disabled={testLoading} className="btn-secondary text-xs py-2 px-4">
                  {testLoading ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 测试中...
                    </span>
                  ) : testResult === 'success' ? (
                    <span className="flex items-center gap-1" style={{ color: 'var(--accent-emerald)' }}>
                      <Check className="w-3.5 h-3.5" /> 连接成功
                    </span>
                  ) : testResult === 'fail' ? (
                    <span className="flex items-center gap-1" style={{ color: '#ef4444' }} title={testError}>
                      ✕ 连接失败
                    </span>
                  ) : '测试连接'}
                </button>
                <button
                  onClick={() => handleSaveTemplate(false)}
                  disabled={saveTemplate.isPending}
                  className="btn-secondary text-xs py-2 px-4"
                >
                  {saveTemplate.isPending ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 保存中...
                    </span>
                  ) : '保存模板'}
                </button>
                <button
                  onClick={() => handleSaveTemplate(true)}
                  disabled={saveTemplate.isPending || selectTemplate.isPending}
                  className="btn-primary text-xs py-2 px-4"
                >
                  {saveTemplate.isPending || selectTemplate.isPending ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 保存中...
                    </span>
                  ) : '保存并激活'}
                </button>
                <button onClick={saveVectorSettings} disabled={isSetting} className="btn-primary text-xs py-2 px-4">
                  {isSetting ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 保存中...
                    </span>
                  ) : vectorSaved ? (
                    <span className="flex items-center gap-1" style={{ color: 'var(--accent-emerald)' }}>
                      <Check className="w-3.5 h-3.5" /> 已保存
                    </span>
                  ) : '保存当前设置'}
                </button>
              </div>
            </div>

            <div className="card-base p-4 max-w-lg">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>已保存的模板</h4>
                <button onClick={handleNewTemplate} className="btn-secondary text-xs py-1.5 px-3">新建模板</button>
              </div>
              {templatesLoading ? (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中...
                </div>
              ) : templates?.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无保存的模板</div>
              ) : (
                <div className="space-y-2">
                  {templates?.map((template) => (
                    <div
                      key={template.id}
                      className="flex items-center justify-between p-2 rounded-md"
                      style={{ backgroundColor: 'var(--bg-secondary)' }}
                    >
                      <div className="min-w-0 mr-2">
                        <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {template.name}
                          {template.isActive && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(16,185,129,0.15)', color: 'var(--accent-emerald)' }}>已激活</span>
                          )}
                        </div>
                        <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                          {template.provider === 'custom' && template.customProviderName
                            ? template.customProviderName
                            : template.provider}
                          {' · '}
                          {template.model}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => handleEditTemplate(template.id)} className="btn-secondary text-[10px] py-1 px-2">编辑</button>
                        <button onClick={() => handleTestTemplate(template.id)} disabled={testLoading} className="btn-secondary text-[10px] py-1 px-2">测试</button>
                        <button
                          onClick={() => handleSelectTemplate(template.id)}
                          disabled={selectTemplate.isPending || template.isActive}
                          className="btn-primary text-[10px] py-1 px-2"
                        >
                          {template.isActive ? '已激活' : '激活'}
                        </button>
                        <button
                          onClick={() => handleDeleteTemplate(template.id)}
                          disabled={deleteTemplate.isPending}
                          className="btn-danger text-[10px] py-1 px-2"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );

      case 'storage':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>存储管理</h3>
            <div className="max-w-lg space-y-6">
              {/* Usage Pie */}
              <div className="card-base p-4">
                <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>存储使用</h4>
                {storageSettings.isLoading ? (
                  <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    加载中...
                  </div>
                ) : !storageSettings.documents && !storageSettings.vectors && !storageSettings.backups ? (
                  <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无存储统计数据</div>
                ) : (
                  <div className="flex items-center gap-6">
                    <svg viewBox="0 0 100 100" className="w-24 h-24">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="var(--bg-tertiary)" strokeWidth="12" />
                      <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent-cyan)" strokeWidth="12" strokeDasharray={`${25 * 2.51} ${100 * 2.51}`} strokeDashoffset="0" transform="rotate(-90 50 50)" />
                      <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent-violet)" strokeWidth="12" strokeDasharray={`${15 * 2.51} ${100 * 2.51}`} strokeDashoffset={-25 * 2.51} transform="rotate(-90 50 50)" />
                      <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent-emerald)" strokeWidth="12" strokeDasharray={`${10 * 2.51} ${100 * 2.51}`} strokeDashoffset={-(25 + 15) * 2.51} transform="rotate(-90 50 50)" />
                    </svg>
                    <div className="space-y-1.5">
                      {[
                        { label: '文档', color: 'var(--accent-cyan)', value: storageSettings.documents || '—' },
                        { label: '向量', color: 'var(--accent-violet)', value: storageSettings.vectors || '—' },
                        { label: '备份', color: 'var(--accent-emerald)', value: storageSettings.backups || '—' },
                      ].map((item) => (
                        <div key={item.label} className="flex items-center gap-2 text-xs">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
                          <span style={{ color: 'var(--text-secondary)' }}>{item.label}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Auto cleanup */}
              <div className="card-base p-4">
                <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>自动清理</h4>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm" style={{ color: 'var(--text-primary)' }}>删除回收站文件</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>超过 30 天自动删除</div>
                    </div>
                    <ToggleSwitch
                      checked={toggles.autoClassify}
                      onChange={() => {
                        toggle('autoClassify');
                        void saveAutoCleanupSetting('storage_auto_cleanup_trash', !toggles.autoClassify);
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm" style={{ color: 'var(--text-primary)' }}>压缩大文件</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>90 天未访问的文件自动压缩</div>
                    </div>
                    <ToggleSwitch
                      checked={toggles.autoVectorize}
                      onChange={() => {
                        toggle('autoVectorize');
                        void saveAutoCleanupSetting('storage_auto_compress', !toggles.autoVectorize);
                      }}
                    />
                  </div>
                </div>
              </div>

              <button
                onClick={() => addToast({ type: 'info', title: '请通过备份管理页面操作', description: '缓存清理功能请前往备份管理页面执行。' })}
                className="btn-danger text-xs py-2 px-4"
              >
                立即清理缓存
              </button>
            </div>
          </div>
        );

      case 'connector':
        return <ConnectorSettings />;

      case 'security':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>安全设置</h3>
            <div className="max-w-lg space-y-6">
              {/* 当前登录信息 */}
              <div className="card-base p-4">
                <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>当前登录</h4>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>用户名</span>
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{user?.name ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>角色</span>
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{user?.role ?? '—'}</span>
                  </div>
                </div>
                <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <button
                    onClick={logout}
                    className="btn-danger text-xs py-2 px-4 flex items-center gap-2"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    登出
                  </button>
                </div>
              </div>

              {/* 修改密码 */}
              <div className="card-base p-4">
                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <KeyRound className="w-4 h-4" />
                  修改密码
                </h4>
                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>当前密码</label>
                    <div className="relative">
                      <input
                        type={showCurrentPassword ? 'text' : 'password'}
                        value={currentPassword}
                        onChange={(e) => { setCurrentPassword(e.target.value); setChangePwdError(''); setChangePwdSuccess(false); }}
                        placeholder="请输入当前密码"
                        className="input-base text-sm pr-10"
                      />
                      <button
                        onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>新密码</label>
                    <div className="relative">
                      <input
                        type={showNewPassword ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => { setNewPassword(e.target.value); setChangePwdError(''); setChangePwdSuccess(false); }}
                        placeholder="至少6位"
                        className="input-base text-sm pr-10"
                      />
                      <button
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>确认新密码</label>
                    <div className="relative">
                      <input
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => { setConfirmPassword(e.target.value); setChangePwdError(''); setChangePwdSuccess(false); }}
                        placeholder="再次输入新密码"
                        className="input-base text-sm pr-10"
                      />
                      <button
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {changePwdError && (
                    <div
                      className="text-sm px-3 py-2 rounded-md"
                      style={{
                        color: '#ef4444',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.2)',
                      }}
                    >
                      {changePwdError}
                    </div>
                  )}

                  {changePwdSuccess && (
                    <div
                      className="text-sm px-3 py-2 rounded-md flex items-center gap-1"
                      style={{
                        color: 'var(--accent-emerald)',
                        background: 'rgba(16, 185, 129, 0.1)',
                        border: '1px solid rgba(16, 185, 129, 0.2)',
                      }}
                    >
                      <Check className="w-3.5 h-3.5" />
                      密码修改成功
                    </div>
                  )}

                  <button
                    onClick={async () => {
                      setChangePwdError('');
                      setChangePwdSuccess(false);

                      if (!currentPassword.trim()) {
                        setChangePwdError('请输入当前密码');
                        return;
                      }
                      if (newPassword.length < 6) {
                        setChangePwdError('新密码至少6位');
                        return;
                      }
                      if (newPassword !== confirmPassword) {
                        setChangePwdError('两次输入的新密码不一致');
                        return;
                      }

                      setChangePwdLoading(true);
                      try {
                        const result = await trpcClient.auth.changePassword.mutate({
                          currentPassword,
                          newPassword,
                        });
                        if (result.success) {
                          setChangePwdSuccess(true);
                          setCurrentPassword('');
                          setNewPassword('');
                          setConfirmPassword('');
                        }
                      } catch (err: unknown) {
                        const msg = err && typeof err === 'object' && 'message' in err
                          ? String(err.message)
                          : '修改失败';
                        setChangePwdError(msg === 'UNAUTHORIZED' ? '当前密码错误' : msg);
                      } finally {
                        setChangePwdLoading(false);
                      }
                    }}
                    disabled={changePwdLoading}
                    className="btn-primary text-xs py-2 px-4"
                  >
                    {changePwdLoading ? (
                      <span className="flex items-center gap-1">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> 修改中...
                      </span>
                    ) : '修改密码'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );

      case 'appearance':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>外观设置</h3>
            <div className="max-w-lg space-y-6">
              {/* Theme Switcher - Sci-fi styled */}
              <div>
                <label className="text-xs font-medium block mb-3" style={{ color: 'var(--text-primary)' }}>主题模式</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setTheme('dark')}
                    className="card-base p-4 text-center sci-corner transition-all"
                    style={{
                      borderColor: theme === 'dark' ? 'var(--accent-cyan)' : 'var(--border-subtle)',
                      backgroundColor: theme === 'dark' ? 'rgba(0,229,255,0.05)' : undefined,
                    }}
                  >
                    <div className="w-12 h-12 rounded-lg mx-auto mb-2 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #060a14, #111a32)', border: '1px solid #1a2744' }}>
                      <Moon className="w-5 h-5" style={{ color: '#00e5ff' }} />
                    </div>
                    <div className="text-sm font-medium mb-0.5" style={{ color: theme === 'dark' ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}>深空模式</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>深色 · 科幻青</div>
                  </button>
                  <button
                    onClick={() => setTheme('light')}
                    className="card-base p-4 text-center sci-corner transition-all"
                    style={{
                      borderColor: theme === 'light' ? 'var(--accent-cyan)' : 'var(--border-subtle)',
                      backgroundColor: theme === 'light' ? 'rgba(0,136,204,0.05)' : undefined,
                    }}
                  >
                    <div className="w-12 h-12 rounded-lg mx-auto mb-2 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #f0f2f8, #ffffff)', border: '1px solid #d0d8e8' }}>
                      <Sun className="w-5 h-5" style={{ color: '#0088cc' }} />
                    </div>
                    <div className="text-sm font-medium mb-0.5" style={{ color: theme === 'light' ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}>昼白模式</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>浅色 · 科技白</div>
                  </button>
                </div>
              </div>

              {/* Current theme indicator */}
              <div className="card-base p-3 flex items-center gap-3" style={{ backgroundColor: 'var(--accent-cyan-dim)' }}>
                {theme === 'dark' ? <Moon className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} /> : <Sun className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />}
                <div>
                  <div className="text-sm font-medium" style={{ color: 'var(--accent-cyan)' }}>
                    当前主题：{theme === 'dark' ? '深空模式' : '昼白模式'}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    全站界面将立即应用此主题
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>界面字体大小</label>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>A</span>
                  <input
                    type="range"
                    min={12}
                    max={18}
                    value={appearanceForm.fontSize}
                    onChange={(e) => setAppearanceForm((prev) => ({ ...prev, fontSize: e.target.value }))}
                    className="flex-1"
                    style={{ accentColor: 'var(--accent-cyan)' }}
                  />
                  <span className="text-lg" style={{ color: 'var(--text-muted)' }}>A</span>
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--accent-cyan)' }}>{appearanceForm.fontSize}px</div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>代码字体</label>
                <select
                  value={appearanceForm.codeFont}
                  onChange={(e) => setAppearanceForm((prev) => ({ ...prev, codeFont: e.target.value }))}
                  className="input-base text-sm"
                >
                  <option>JetBrains Mono</option>
                  <option>Fira Code</option>
                  <option>SF Mono</option>
                  <option>Consolas</option>
                </select>
              </div>
              <div className="flex items-center gap-3 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button onClick={saveAppearanceSettings} disabled={isSetting} className="btn-primary text-xs py-2 px-4">
                  {isSetting ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 保存中...
                    </span>
                  ) : appearanceSaved ? (
                    <span className="flex items-center gap-1" style={{ color: 'var(--accent-emerald)' }}>
                      <Check className="w-3.5 h-3.5" /> 已保存
                    </span>
                  ) : '保存设置'}
                </button>
              </div>
            </div>
          </div>
        );

      case 'about':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>关于 璇玑智脑</h3>
            <div className="max-w-lg space-y-4">
              <div className="card-base p-6 text-center">
                <h1 className="text-3xl font-bold text-gradient-cyan mb-2">璇玑智脑</h1>
                <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>智能知识库系统</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>版本 1.0.0 · 构建于 2026-06-02</p>
              </div>
              <div className="space-y-2">
                {[
                  { label: '检查更新', value: '当前已是最新版本' },
                  { label: '开源协议', value: 'MIT License' },
                  { label: '文档', value: '查看在线文档 →' },
                  { label: '反馈', value: '提交 Issue →' },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{item.label}</span>
                    <span className="text-xs" style={{ color: 'var(--accent-cyan)' }}>{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );

      default:
        return (
          <div className="text-center py-20">
            <Info className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
            <h3 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>设置项</h3>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>从左侧菜单选择要配置的项目</p>
          </div>
        );
    }
  };

  return (
    <div className="flex h-[calc(100vh-48px)]" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Left Nav */}
      <div className="w-[240px] shrink-0 border-r overflow-y-auto" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
        <div className="p-3">
          {SETTINGS_NAV.map((item) => {
            const isActive = category === item.key;
            return (
              <Link
                key={item.key}
                to={`/settings/${item.key}`}
                className="flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors"
                style={{
                  backgroundColor: isActive ? 'rgba(34,211,238,0.1)' : 'transparent',
                  color: isActive ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                  borderLeft: isActive ? '3px solid var(--accent-cyan)' : '3px solid transparent',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 animate-fade-in">
        {renderContent()}
      </div>
    </div>
  );
}
