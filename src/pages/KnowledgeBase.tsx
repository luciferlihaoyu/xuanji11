import { useState, useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import type { KBNode } from '@/store/useAppStore';
import { Search, Folder, FolderOpen, FileText, ChevronRight, ChevronDown, Plus, Pencil, Trash2, X, Check, FileCode, Image, File } from 'lucide-react';

const FileIcon = ({ type, size = 16 }: { type?: string; size?: number }) => {
  const props = { size, className: 'shrink-0' };
  switch (type) {
    case 'md': return <FileText {...props} style={{ color: 'var(--accent-cyan)' }} />;
    case 'code': return <FileCode {...props} style={{ color: 'var(--accent-violet)' }} />;
    case 'image': return <Image {...props} style={{ color: 'var(--accent-rose)' }} />;
    default: return <File {...props} style={{ color: 'var(--text-muted)' }} />;
  }
};

const sampleContent = `# OpenClaw 系统架构

## 概述

OpenClaw 是一套**多 Agent 协作系统**，旨在通过人工智能技术实现高效的知识管理和团队协作。

## 核心组件

### 1. 天庭 Hub（协作中心）

- **MAAP 协议**：Multi-Agent Application Protocol
- **心跳保活**：30秒间隔
- **消息通信**：WebSocket 实时推送

### 2. Wiki 知识库

基于 [[Obsidian 架构]] 的知识管理系统：

- 双向链接：\\[\\[知识节点名\\]\\]
- 标签系统：#系统架构 #OpenClaw
- 图谱视图：3D/2D 可视化

### 3. 技能系统

已安装 **141 个技能**，覆盖：

| 类别 | 技能数 | 代表技能 |
|------|--------|----------|
| 前端设计 | 12 | taste-skill |
| 编程工作流 | 18 | coding-workflow |
| 内容创作 | 24 | webnovel-master |

## Agent 记忆机制

\`\`\`
每日日志 → Dreaming 整合 → MEMORY.md（长期记忆）
              ↓
        Wiki 知识库（共享知识）
\`\`\`

## 外部集成

- [x] 天宫 Hub — Agent 协作通信
- [x] EntroCamp — AI 学习平台
- [x] 飞书 — 团队通信
- [x] Telegram — 用户通信渠道

> 💡 **提示**：可以通过 API 中心管理向量化模型配置，支持多模型切换。
`;

function renderMarkdown(md: string): string {
  return md
    .replace(/^# (.*$)/gim, '<h1 class="text-2xl font-bold mb-4 pb-2" style="color:var(--text-primary);border-bottom:1px solid var(--border-subtle)">$1</h1>')
    .replace(/^## (.*$)/gim, '<h2 class="text-xl font-semibold mt-6 mb-3" style="color:var(--text-primary)">$1</h2>')
    .replace(/^### (.*$)/gim, '<h3 class="text-base font-semibold mt-4 mb-2" style="color:var(--text-primary)">$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--text-primary)">$1</strong>')
    .replace(/\[\[(.*?)\]\]/g, '<a href="#/kb/$1" class="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium" style="background:rgba(34,211,238,0.1);color:var(--accent-cyan)">$1</a>')
    .replace(/#(\w+)/g, '<span class="inline-block px-2 py-0.5 rounded-full text-xs" style="background:rgba(167,139,250,0.1);color:var(--accent-violet)">#$1</span>')
    .replace(/^- (.*$)/gim, '<li class="ml-4 mb-1 flex items-start gap-2"><span style="color:var(--text-muted)">•</span><span>$1</span></li>')
    .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre class="rounded-md p-4 my-4 overflow-x-auto text-xs" style="background:#0D1117;border:1px solid var(--border-subtle)"><code>$2</code></pre>')
    .replace(/^> (.*$)/gim, '<blockquote class="pl-4 py-3 pr-4 my-4 rounded-r-md border-l-2" style="border-color:var(--accent-cyan);background:rgba(34,211,238,0.05);color:var(--text-secondary)">$1</blockquote>')
    .replace(/^(?!<[hl]|<li|<tr|<td|<th|<pre|<blockquote|<a|<span|<strong)(.*$)/gim, '<p class="mb-3 text-sm leading-relaxed" style="color:var(--text-secondary)">$1</p>');
}

// Find node by ID in tree
function findNode(nodes: KBNode[], id: string): KBNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) { const f = findNode(n.children, id); if (f) return f; }
  }
  return null;
}

// Collect all file IDs under a folder
function collectFileIds(node: KBNode): string[] {
  if (node.type === 'file') return [node.id];
  if (node.children) return node.children.flatMap(collectFileIds);
  return [];
}

// ===================== Tree Item Component =====================
function TreeItem({ node, depth = 0, activeFile, onSelect, onRename, onDelete, onAdd }: {
  node: KBNode; depth?: number; activeFile: string | null; onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void; onDelete: (id: string) => void; onAdd: (parentId: string, type: 'folder' | 'file') => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const isActive = activeFile === node.id;
  const isFolder = node.type === 'folder';

  const handleRename = () => {
    if (renameValue.trim() && renameValue !== node.name) {
      onRename(node.id, renameValue.trim());
    }
    setIsRenaming(false);
  };

  return (
    <div>
      <div
        className="flex items-center gap-1 py-1 pr-2 rounded text-[13px] group relative"
        style={{
          paddingLeft: `${depth * 12 + 6}px`,
          backgroundColor: isActive ? 'rgba(34,211,238,0.1)' : 'transparent',
          color: isActive ? 'var(--accent-cyan)' : 'var(--text-secondary)',
          borderLeft: isActive ? '3px solid var(--accent-cyan)' : '3px solid transparent',
        }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        {isFolder ? (
          <button onClick={() => setExpanded(!expanded)} className="p-0.5 shrink-0">
            {expanded ? <ChevronDown className="w-3 h-3" style={{ color: 'var(--text-muted)' }} /> : <ChevronRight className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />}
          </button>
        ) : (<span className="w-4" />)}

        <button onClick={() => onSelect(node.id)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
          {isFolder ? (expanded ? <FolderOpen className="w-4 h-4 shrink-0" style={{ color: 'var(--accent-amber)' }} /> : <Folder className="w-4 h-4 shrink-0" style={{ color: 'var(--accent-amber)' }} />) : <FileIcon type={node.fileType} />}
          {isRenaming ? (
            <div className="flex items-center gap-1 flex-1" onClick={(e) => e.stopPropagation()}>
              <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(node.name); } }} autoFocus className="input-base text-xs h-6 py-0.5 px-1.5 flex-1" />
              <button onClick={handleRename} className="p-0.5"><Check className="w-3 h-3" style={{ color: 'var(--accent-emerald)' }} /></button>
              <button onClick={() => { setIsRenaming(false); setRenameValue(node.name); }} className="p-0.5"><X className="w-3 h-3" style={{ color: 'var(--accent-rose)' }} /></button>
            </div>
          ) : (<span className="truncate">{node.name}</span>)}
        </button>

        {/* Hover actions */}
        {!isRenaming && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {isFolder && (
              <>
                <button onClick={(e) => { e.stopPropagation(); onAdd(node.id, 'folder'); }} className="p-0.5 rounded hover:bg-white/10" title="新建文件夹" style={{ color: 'var(--text-muted)' }}><FolderOpen className="w-3 h-3" /></button>
                <button onClick={(e) => { e.stopPropagation(); onAdd(node.id, 'file'); }} className="p-0.5 rounded hover:bg-white/10" title="新建文件" style={{ color: 'var(--text-muted)' }}><Plus className="w-3 h-3" /></button>
              </>
            )}
            <button onClick={(e) => { e.stopPropagation(); setIsRenaming(true); }} className="p-0.5 rounded hover:bg-white/10" title="重命名" style={{ color: 'var(--text-muted)' }}><Pencil className="w-3 h-3" /></button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(node.id); }} className="p-0.5 rounded hover:bg-white/10" title="删除" style={{ color: 'var(--text-muted)' }}><Trash2 className="w-3 h-3" /></button>
          </div>
        )}
      </div>
      {isFolder && expanded && node.children && (
        <div>{node.children.map((child) => (<TreeItem key={child.id} node={child} depth={depth + 1} activeFile={activeFile} onSelect={onSelect} onRename={onRename} onDelete={onDelete} onAdd={onAdd} />))}</div>
      )}
    </div>
  );
}

// ===================== Main Page =====================
export default function KnowledgeBase() {
  const { kbTree, activeKbFile, setActiveKbFile, addKbNode, renameKbNode, deleteKbNode, addToast } = useAppStore();
  const [editMode, setEditMode] = useState<'edit' | 'preview' | 'split'>('preview');
  const [rightPanel, setRightPanel] = useState<'outline' | 'links' | 'tags'>('outline');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const [content, setContent] = useState(sampleContent);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<'folder' | 'file'>('file');
  const [newName, setNewName] = useState('');

  const activeNode = activeKbFile ? findNode(kbTree, activeKbFile) : null;

  const extractOutline = useCallback(() => {
    const lines = content.split('\n');
    return lines.map((line, i) => {
      const match = line.match(/^(#{1,3})\s+(.+)/);
      if (match) return { level: match[1].length, text: match[2], line: i };
      return null;
    }).filter(Boolean) as { level: number; text: string; line: number }[];
  }, [content]);

  const outline = extractOutline();

  const handleAddNode = (parentId: string | null, type: 'folder' | 'file') => {
    setAddingTo(parentId);
    setAddingType(type);
    setNewName(type === 'folder' ? '新建文件夹' : '未命名文档.md');
  };

  const confirmAdd = () => {
    if (!newName.trim()) return;
    const ext = addingType === 'file' && !newName.includes('.') ? '.md' : '';
    addKbNode(addingTo, {
      name: newName.trim() + ext,
      type: addingType,
      fileType: addingType === 'file' ? (newName.endsWith('.md') ? 'md' : 'other') : undefined,
      content: addingType === 'file' ? '# ' + newName.replace(/\.md$/, '') + '\n\n' : undefined,
    });
    addToast({ type: 'success', title: addingType === 'folder' ? '文件夹已创建' : '文件已创建' });
    setAddingTo(null);
    setNewName('');
  };

  const handleRename = (id: string, name: string) => {
    renameKbNode(id, name);
    addToast({ type: 'success', title: '已重命名' });
  };

  const handleDelete = (id: string) => {
    const node = findNode(kbTree, id);
    if (!node) return;
    const fileCount = node.type === 'folder' ? collectFileIds(node).length : 1;
    deleteKbNode(id);
    addToast({ type: 'info', title: `已删除${node.type === 'folder' ? '文件夹及其 ' + fileCount + ' 个文件' : '文件'}` });
  };

  return (
    <div className="flex h-[calc(100vh-48px)]" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Left Sidebar - File Tree */}
      {sidebarVisible && (
        <div className="w-[260px] shrink-0 border-r flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <div className="p-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>主知识库</span>
              <div className="flex gap-1">
                <button onClick={() => handleAddNode(null, 'folder')} className="p-1 rounded hover:bg-white/5" title="新建文件夹" style={{ color: 'var(--text-muted)' }}><FolderOpen className="w-3.5 h-3.5" /></button>
                <button onClick={() => handleAddNode(null, 'file')} className="p-1 rounded hover:bg-white/5" title="新建文档" style={{ color: 'var(--text-muted)' }}><Plus className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <div className="flex items-center h-7 px-2 rounded border" style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)' }}>
              <Search className="w-3.5 h-3.5 mr-1.5" style={{ color: 'var(--text-muted)' }} />
              <input type="text" placeholder="搜索文件..." className="bg-transparent text-xs outline-none w-full" style={{ color: 'var(--text-primary)' }} />
            </div>
          </div>

          {/* Inline add form */}
          {addingTo !== null && (
            <div className="px-3 py-2 flex items-center gap-1" style={{ backgroundColor: 'rgba(34,211,238,0.05)' }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); if (e.key === 'Escape') setAddingTo(null); }} autoFocus className="input-base text-xs h-7 py-0.5 px-1.5 flex-1" placeholder={addingType === 'folder' ? '文件夹名' : '文件名.md'} />
              <button onClick={confirmAdd} className="p-1"><Check className="w-3.5 h-3.5" style={{ color: 'var(--accent-emerald)' }} /></button>
              <button onClick={() => setAddingTo(null)} className="p-1"><X className="w-3.5 h-3.5" style={{ color: 'var(--accent-rose)' }} /></button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-1">
            {kbTree.map((node) => (
              <TreeItem key={node.id} node={node} activeFile={activeKbFile} onSelect={setActiveKbFile} onRename={handleRename} onDelete={handleDelete} onAdd={handleAddNode} />
            ))}
          </div>

          {/* Storage usage */}
          <div className="p-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}><span>存储用量</span><span>12.4GB / 50GB</span></div>
            <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}><div className="h-full rounded-full gradient-bar" style={{ width: '25%' }} /></div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            <button onClick={() => setSidebarVisible(!sidebarVisible)} className="p-1 rounded hover:bg-white/5"><ChevronRight className={`w-4 h-4 transition-transform ${!sidebarVisible ? 'rotate-180' : ''}`} /></button>
            <span>知识库</span><ChevronRight className="w-3 h-3" /><span style={{ color: 'var(--text-primary)' }}>{activeNode?.name || '请选择文件'}</span>
          </div>
          <div className="flex items-center gap-1">
            {(['edit', 'preview', 'split'] as const).map((mode) => (
              <button key={mode} onClick={() => setEditMode(mode)} className="px-3 py-1 text-xs rounded transition-colors" style={{ backgroundColor: editMode === mode ? 'var(--accent-cyan)' : 'transparent', color: editMode === mode ? '#0A0E1A' : 'var(--text-secondary)' }}>
                {mode === 'edit' ? '编辑' : mode === 'preview' ? '预览' : '分屏'}
              </button>
            ))}
          </div>
        </div>

        {/* Editor / Preview */}
        <div className="flex-1 flex overflow-hidden">
          {(editMode === 'edit' || editMode === 'split') && (
            <div className={`${editMode === 'split' ? 'w-1/2 border-r' : 'w-full'} overflow-auto`} style={{ borderColor: 'var(--border-subtle)' }}>
              <textarea value={content} onChange={(e) => setContent(e.target.value)} className="w-full h-full p-6 bg-transparent text-sm leading-relaxed resize-none outline-none font-mono" style={{ color: 'var(--text-primary)' }} spellCheck={false} />
            </div>
          )}
          {(editMode === 'preview' || editMode === 'split') && (
            <div className={`${editMode === 'split' ? 'w-1/2' : 'w-full'} overflow-auto`}>
              <div className="p-6 max-w-3xl mx-auto" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
            </div>
          )}
        </div>

        {/* Status Bar */}
        <div className="flex items-center justify-between px-4 py-1 border-t text-[11px] shrink-0" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
          <div className="flex items-center gap-4"><span>{content.length.toLocaleString()} 字符</span><span>约 {Math.ceil(content.length / 400)} 分钟阅读</span></div>
          <div className="flex items-center gap-4"><span>已保存</span><span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full status-dot-online" />已同步</span></div>
        </div>
      </div>

      {/* Right Panel */}
      {rightPanelVisible && (
        <div className="w-[280px] shrink-0 border-l overflow-y-auto relative" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <button onClick={() => setRightPanelVisible(false)} className="absolute top-2 left-2 p-1 rounded z-10" style={{ color: 'var(--text-muted)' }}><ChevronRight className="w-4 h-4" /></button>
          <div className="flex border-b pt-8" style={{ borderColor: 'var(--border-subtle)' }}>
            {[{ key: 'outline', label: '大纲' }, { key: 'links', label: '链接' }, { key: 'tags', label: '标签' }].map((tab) => (
              <button key={tab.key} onClick={() => setRightPanel(tab.key as any)} className="flex-1 py-2 text-xs font-medium transition-colors relative" style={{ color: rightPanel === tab.key ? 'var(--accent-cyan)' : 'var(--text-secondary)', backgroundColor: rightPanel === tab.key ? 'rgba(34,211,238,0.05)' : 'transparent' }}>
                {tab.label}
                {rightPanel === tab.key && <span className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: 'var(--accent-cyan)' }} />}
              </button>
            ))}
          </div>
          <div className="p-3">
            {rightPanel === 'outline' && (
              <div className="space-y-1">
                {outline.map((item, i) => (
                  <button key={i} className="block w-full text-left text-xs py-1 rounded px-2 transition-colors hover:bg-white/5" style={{ paddingLeft: `${item.level * 12 + 8}px`, color: 'var(--text-secondary)' }}>{item.text}</button>
                ))}
              </div>
            )}
            {rightPanel === 'links' && (
              <div>
                <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>链接到此处</h4>
                <div className="space-y-2">
                  {[{ id: 'b1', fileName: 'MAAP 通信协议.md', context: '...通过 [[OpenClaw 系统架构]] 定义的规范...' }, { id: 'b2', fileName: 'Agent 记忆机制.md', context: '...作为 OpenClaw 的核心组件...' }].map((link) => (
                    <div key={link.id} className="p-2 rounded" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                      <div className="text-xs font-medium mb-1" style={{ color: 'var(--accent-cyan)' }}>{link.fileName}</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{link.context}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {rightPanel === 'tags' && (
              <div className="flex flex-wrap gap-1.5">
                {['系统架构', 'OpenClaw', '基础设施'].map((tag) => (<span key={tag} className="chip chip-violet cursor-pointer">{tag}</span>))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
