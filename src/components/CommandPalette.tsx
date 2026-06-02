import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, FileText, Bot, Workflow, Settings, Database, Upload, Globe, FolderOpen, Map } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  action: () => void;
  category: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { kbTree, agents } = useAppStore();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Collect all KB files recursively
  const collectFiles = (nodes: any[]): { id: string; name: string; type: string }[] => {
    const files: { id: string; name: string; type: string }[] = [];
    for (const n of nodes) {
      if (n.type === 'file') files.push({ id: n.id, name: n.name, type: n.fileType || 'md' });
      if (n.children) files.push(...collectFiles(n.children));
    }
    return files;
  };
  const kbFiles = collectFiles(kbTree);

  const allCommands = useMemo<CommandItem[]>(() => {
    const commands: CommandItem[] = [
      // Pages
      { id: 'nav-graph', label: '知识脑图', description: '3D/2D 知识星图', icon: Map, action: () => { navigate('/'); onClose(); }, category: '页面' },
      { id: 'nav-kb', label: '知识库', description: 'Obsidian 风格编辑器', icon: FolderOpen, action: () => { navigate('/kb'); onClose(); }, category: '页面' },
      { id: 'nav-workflow', label: '工作流编排器', description: '可视化流程编排', icon: Workflow, action: () => { navigate('/workflows'); onClose(); }, category: '页面' },
      { id: 'nav-agents', label: 'Agent 管理', description: '管理 AI Agent', icon: Bot, action: () => { navigate('/agents'); onClose(); }, category: '页面' },
      { id: 'nav-api', label: 'API 中心', description: '接口文档与调试', icon: Globe, action: () => { navigate('/api'); onClose(); }, category: '页面' },
      { id: 'nav-sources', label: '数据源', description: '外部数据连接', icon: Database, action: () => { navigate('/sources'); onClose(); }, category: '页面' },
      { id: 'nav-upload', label: '文件上传', description: '上传与处理', icon: Upload, action: () => { navigate('/upload'); onClose(); }, category: '页面' },
      { id: 'nav-settings', label: '设置', description: '系统配置', icon: Settings, action: () => { navigate('/settings/appearance'); onClose(); }, category: '页面' },
      // KB Files
      ...kbFiles.map((f) => ({
        id: `kb-${f.id}`,
        label: f.name,
        description: '知识库文件',
        icon: FileText,
        action: () => { navigate('/kb'); onClose(); },
        category: '知识库文件',
      })),
      // Agents
      ...agents.map((a) => ({
        id: `agent-${a.id}`,
        label: `${a.name} — ${a.role}`,
        description: `${a.department} · ${a.status === 'online' ? '在线' : '离线'}`,
        icon: Bot,
        action: () => { navigate('/agents'); onClose(); },
        category: 'Agent',
      })),
    ];
    return commands;
  }, [navigate, onClose, kbFiles, agents]);

  // Filter
  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands.slice(0, 10);
    const q = query.toLowerCase();
    return allCommands.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q)
    );
  }, [allCommands, query]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        filtered[selectedIndex]?.action();
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, filtered, selectedIndex, onClose]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement;
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!open) return null;

  // Group by category
  const grouped: Record<string, typeof filtered> = {};
  for (const item of filtered) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh]" style={{ backgroundColor: 'rgba(6,10,20,0.75)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-[640px] mx-4 rounded-xl border overflow-hidden animate-scale-in" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)', boxShadow: '0 24px 64px rgba(0,0,0,0.5), 0 0 1px var(--accent-cyan)' }}>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Search className="w-5 h-5 shrink-0" style={{ color: 'var(--accent-cyan)' }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            placeholder="搜索页面、文件、Agent、命令..."
            className="flex-1 bg-transparent text-base outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', backgroundColor: 'var(--bg-tertiary)' }}>
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[400px] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center py-8">
              <Search className="w-8 h-8 mb-2" style={{ color: 'var(--text-dim)' }} />
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>未找到匹配结果</span>
            </div>
          ) : (
            Object.entries(grouped).map(([category, items]) => (
              <div key={category}>
                <div className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--accent-cyan)' }}>
                  {category}
                </div>
                {items.map((item) => {
                  const globalIdx = filtered.indexOf(item);
                  const isSelected = globalIdx === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      onClick={() => item.action()}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                      className="flex items-center gap-3 w-full px-4 py-2.5 text-left transition-colors"
                      style={{
                        backgroundColor: isSelected ? 'var(--accent-cyan-dim)' : 'transparent',
                      }}
                    >
                      <item.icon className="w-4 h-4 shrink-0" style={{ color: isSelected ? 'var(--accent-cyan)' : 'var(--text-muted)' }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate" style={{ color: isSelected ? 'var(--accent-cyan)' : 'var(--text-primary)' }}>{item.label}</div>
                        {item.description && <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{item.description}</div>}
                      </div>
                      {isSelected && <kbd className="text-[10px] px-1 rounded border hidden sm:block" style={{ borderColor: 'var(--border-active)', color: 'var(--text-muted)' }}>↵</kbd>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t text-[10px]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-dim)' }}>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><kbd className="px-1 rounded border" style={{ borderColor: 'var(--border-subtle)' }}>↑↓</kbd> 选择</span>
            <span className="flex items-center gap-1"><kbd className="px-1 rounded border" style={{ borderColor: 'var(--border-subtle)' }}>↵</kbd> 确认</span>
          </div>
          <span>{filtered.length} 个结果</span>
        </div>
      </div>
    </div>
  );
}
