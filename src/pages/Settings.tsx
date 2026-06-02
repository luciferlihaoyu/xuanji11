import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { User, BookOpen, Bot, Brain, HardDrive, Workflow, Shield, Palette, Info, Eye, EyeOff, Check, Sun, Moon } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const SETTINGS_NAV = [
  { key: 'personal', label: '个人设置', icon: User },
  { key: 'knowledge', label: '知识库设置', icon: BookOpen },
  { key: 'agent', label: 'Agent 配置', icon: Bot },
  { key: 'vectorization', label: '向量化模型', icon: Brain },
  { key: 'storage', label: '存储管理', icon: HardDrive },
  { key: 'workflow', label: '工作流默认', icon: Workflow },
  { key: 'security', label: '安全', icon: Shield },
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'about', label: '关于', icon: Info },
];

export default function Settings() {
  const { category = 'personal' } = useParams();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null);
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    autoClassify: true,
    autoVectorize: true,
    autoRelate: false,
    autoSync: true,
  });

  const toggle = (key: string) => {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const testConnection = () => {
    setTestResult(null);
    setTimeout(() => setTestResult('success'), 1500);
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
                    <div className="w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold" style={{ background: 'linear-gradient(135deg, #22D3EE, #A78BFA)', color: '#0A0E1A' }}>U</div>
                    <button className="btn-secondary text-xs py-1.5 px-3">更换头像</button>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>昵称</label>
                  <input type="text" defaultValue="管理员" className="input-base text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>邮箱</label>
                  <input type="email" defaultValue="admin@xuanji.io" className="input-base text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>时区</label>
                  <select className="input-base text-sm">
                    <option>Asia/Shanghai (UTC+8)</option>
                    <option>Asia/Tokyo (UTC+9)</option>
                    <option>America/New_York (UTC-5)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>界面语言</label>
                  <select className="input-base text-sm">
                    <option>简体中文</option>
                    <option>English</option>
                    <option>日本語</option>
                  </select>
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
                <input type="text" defaultValue="https://tianting.zeabur.app" className="input-base text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>Agent Token</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      defaultValue="sk-hub-nxm-xxxx"
                      className="input-base text-sm pr-10"
                    />
                    <button onClick={() => setShowApiKey(!showApiKey)} className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
                      {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>心跳间隔（秒）</label>
                <input type="number" defaultValue={30} className="input-base text-sm max-w-[120px]" />
              </div>
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm" style={{ color: 'var(--text-primary)' }}>自动重连</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>连接断开时自动尝试重连</div>
                </div>
                <ToggleSwitch checked={true} onChange={() => {}} />
              </div>
              <div className="flex items-center gap-3 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button onClick={testConnection} className="btn-secondary text-xs py-2 px-4">
                  {testResult === 'success' ? (
                    <span className="flex items-center gap-1" style={{ color: 'var(--accent-emerald)' }}>
                      <Check className="w-3.5 h-3.5" /> 连接成功
                    </span>
                  ) : '测试连接'}
                </button>
                <button className="btn-primary text-xs py-2 px-4">保存</button>
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
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>模型提供商</label>
                <select className="input-base text-sm">
                  <option>OpenAI</option>
                  <option>智谱 AI</option>
                  <option>本地部署</option>
                  <option>自定义</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>API Key</label>
                <div className="relative">
                  <input type={showApiKey ? 'text' : 'password'} defaultValue="sk-openai-xxxx" className="input-base text-sm pr-10" />
                  <button onClick={() => setShowApiKey(!showApiKey)} className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>模型</label>
                <select className="input-base text-sm">
                  <option>text-embedding-3-large</option>
                  <option>text-embedding-3-small</option>
                  <option>text-embedding-ada-002</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>向量维度</label>
                <input type="number" defaultValue={3072} className="input-base text-sm max-w-[120px]" />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>索引更新模式</label>
                <div className="flex gap-3">
                  {['实时', '定时', '手动'].map((m) => (
                    <label key={m} className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <input type="radio" name="indexMode" defaultChecked={m === '实时'} className="accent-cyan" />
                      {m}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>相似度阈值</label>
                <div className="flex items-center gap-3">
                  <input type="range" min={0} max={100} defaultValue={75} className="flex-1" style={{ accentColor: 'var(--accent-cyan)' }} />
                  <span className="text-xs w-12" style={{ color: 'var(--accent-cyan)' }}>0.75</span>
                </div>
              </div>
              <div className="flex items-center gap-3 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button onClick={testConnection} className="btn-secondary text-xs py-2 px-4">
                  {testResult === 'success' ? (
                    <span className="flex items-center gap-1" style={{ color: 'var(--accent-emerald)' }}>
                      <Check className="w-3.5 h-3.5" /> 连接成功
                    </span>
                  ) : '测试连接'}
                </button>
                <button className="btn-primary text-xs py-2 px-4">保存</button>
              </div>
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
                <div className="flex items-center gap-6">
                  <svg viewBox="0 0 100 100" className="w-24 h-24">
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--bg-tertiary)" strokeWidth="12" />
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent-cyan)" strokeWidth="12" strokeDasharray={`${25 * 2.51} ${100 * 2.51}`} strokeDashoffset="0" transform="rotate(-90 50 50)" />
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent-violet)" strokeWidth="12" strokeDasharray={`${15 * 2.51} ${100 * 2.51}`} strokeDashoffset={-25 * 2.51} transform="rotate(-90 50 50)" />
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent-emerald)" strokeWidth="12" strokeDasharray={`${10 * 2.51} ${100 * 2.51}`} strokeDashoffset={-(25 + 15) * 2.51} transform="rotate(-90 50 50)" />
                  </svg>
                  <div className="space-y-1.5">
                    {[
                      { label: '文档', color: 'var(--accent-cyan)', value: '12.5 GB' },
                      { label: '图片', color: 'var(--accent-violet)', value: '8.3 GB' },
                      { label: '其他', color: 'var(--accent-emerald)', value: '5.2 GB' },
                    ].map((item) => (
                      <div key={item.label} className="flex items-center gap-2 text-xs">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
                        <span style={{ color: 'var(--text-secondary)' }}>{item.label}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
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
                    <ToggleSwitch checked={toggles.autoClassify} onChange={() => toggle('autoClassify')} />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm" style={{ color: 'var(--text-primary)' }}>压缩大文件</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>90 天未访问的文件自动压缩</div>
                    </div>
                    <ToggleSwitch checked={false} onChange={() => {}} />
                  </div>
                </div>
              </div>

              <button className="btn-danger text-xs py-2 px-4">立即清理缓存</button>
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
                  <input type="range" min={12} max={18} defaultValue={14} className="flex-1" style={{ accentColor: 'var(--accent-cyan)' }} />
                  <span className="text-lg" style={{ color: 'var(--text-muted)' }}>A</span>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>代码字体</label>
                <select className="input-base text-sm">
                  <option>JetBrains Mono</option>
                  <option>Fira Code</option>
                  <option>SF Mono</option>
                  <option>Consolas</option>
                </select>
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
