import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import { Search, ArrowRight, X } from 'lucide-react';

interface Command {
  id: string;
  label: string;
  description: string;
  icon?: string;
  path: string;
  category: 'page' | 'action';
}

const COMMANDS: Command[] = [
  { id: 'knowledge-graph', label: '知识脑图', description: 'D3.js 力导向知识图谱', icon: '\u{1F310}', path: '/', category: 'page' },
  { id: 'knowledge-base', label: '知识库', description: '文档管理与编辑器', icon: '\u{1F4CE}', path: '/kb', category: 'page' },
  { id: 'workflow', label: '工作流编排', description: '可视化节点编程', icon: '\u26A1', path: '/workflows', category: 'page' },
  { id: 'agents', label: 'Agent 管理', description: '智能助手管理', icon: '\u{1F916}', path: '/agents', category: 'page' },
  { id: 'datasources', label: '数据源', description: '云盘 / NAS 数据接入', icon: '\u{1F4E6}', path: '/sources', category: 'page' },
  { id: 'upload', label: '文件上传', description: '上传文件并向量化', icon: '\u{1F4E4}', path: '/upload', category: 'page' },
  { id: 'api-center', label: 'API 中心', description: '接口文档与调试', icon: '\u{1F527}', path: '/api', category: 'page' },
  { id: 'settings', label: '系统设置', description: '主题、偏好设置', icon: '\u2699\uFE0F', path: '/settings/theme', category: 'page' },
  { id: 'search', label: '全局搜索', description: '全文 + 向量语义搜索', icon: '\u{1F50D}', path: '/search', category: 'page' },
  { id: 'login', label: '退出登录', description: '返回登录页', icon: '\u{1F6AA}', path: '/login', category: 'action' },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const filtered = query.trim()
    ? COMMANDS.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.description.toLowerCase().includes(query.toLowerCase())
      )
    : COMMANDS;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const handleSelect = useCallback(
    (cmd: Command) => {
      setOpen(false);
      navigate(cmd.path);
    },
    [navigate]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered[activeIndex]) {
        handleSelect(filtered[activeIndex]);
      }
    },
    [filtered, activeIndex, handleSelect]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="w-full max-w-lg rounded-xl overflow-hidden shadow-2xl border"
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-secondary, #1a1a2e)',
          borderColor: 'var(--border-subtle, rgba(255,255,255,0.06))',
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: 'var(--border-subtle, rgba(255,255,255,0.06))' }}
        >
          <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted, #666)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索页面..."
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--text-primary, #fff)' }}
          />
          <button
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-white/5"
            style={{ color: 'var(--text-muted, #666)' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted, #666)' }}>
              无匹配结果
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                onClick={() => handleSelect(cmd)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  i === activeIndex ? 'bg-white/10' : 'hover:bg-white/5'
                }`}
              >
                <span className="text-lg shrink-0">{cmd.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm" style={{ color: 'var(--text-primary, #fff)' }}>
                    {cmd.label}
                  </div>
                  <div
                    className="text-xs truncate"
                    style={{ color: 'var(--text-muted, #666)' }}
                  >
                    {cmd.description}
                  </div>
                </div>
                <ArrowRight
                  className="w-4 h-4 shrink-0 opacity-0 group-hover:opacity-100"
                  style={{ color: 'var(--text-muted, #666)' }}
                />
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          className="flex items-center justify-between px-4 py-2 text-[10px] border-t"
          style={{
            borderColor: 'var(--border-subtle, rgba(255,255,255,0.06))',
            color: 'var(--text-muted, #666)',
          }}
        >
          <span>\u2191\u2193 导航  \u00B7  \u21B5 选择  \u00B7  Esc 关闭</span>
          <span>\u2318K 打开</span>
        </div>
      </div>
    </div>
  );
}
