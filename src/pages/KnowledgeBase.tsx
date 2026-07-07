import { useState, useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { marked, Renderer } from 'marked';
import type { Token, Tokens } from 'marked';
import { useKbTree, useDocument } from '@/hooks/useKb';
import { useAppStore } from '@/store/useAppStore';
import { Search, Folder, FolderOpen, FileText, ChevronRight, ChevronDown, Plus, Pencil, Trash2, X, Check, FileCode, Image, File, Save, RotateCcw, Tag, MoreHorizontal } from 'lucide-react';
import type { KbFolder, KbDocument } from '@db/schema';

const markdownRenderer = new Renderer();

const FileIcon = ({ type, size = 16 }: { type?: string; size?: number }) => {
  const props = { size, className: 'shrink-0' };
  switch (type) {
    case 'md': return <FileText {...props} style={{ color: 'var(--accent-cyan)' }} />;
    case 'code': return <FileCode {...props} style={{ color: 'var(--accent-violet)' }} />;
    case 'image': return <Image {...props} style={{ color: 'var(--accent-rose)' }} />;
    default: return <File {...props} style={{ color: 'var(--text-muted)' }} />;
  }
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTagChips(text: string): string {
  return text.replace(/#(\w+)/g, '<span class="inline-block px-2 py-0.5 rounded-full text-xs" style="background:rgba(167,139,250,0.1);color:var(--accent-violet)">#$1</span>');
}

function renderKnowledgeLinks(text: string): string {
  let rendered = '';
  let lastIndex = 0;
  for (const match of text.matchAll(/\[\[(.*?)\]\]/g)) {
    const index = match.index ?? 0;
    const label = match[1] ?? '';
    rendered += renderTagChips(text.slice(lastIndex, index));
    rendered += `<a href="#/kb/${encodeURIComponent(label)}" class="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium" style="background:rgba(34,211,238,0.1);color:var(--accent-cyan)">${label}</a>`;
    lastIndex = index + match[0].length;
  }
  return rendered + renderTagChips(text.slice(lastIndex));
}

function renderInline(tokens: Token[]): string {
  return marked.Parser.parseInline(tokens, { renderer: markdownRenderer });
}

function isSafeHref(href: string): boolean {
  const trimmedHref = href.trim().toLowerCase();
  return /^(https?:|mailto:|tel:|#\/kb\/|#(?!\w+:)|\/)(?!.*javascript:)/.test(trimmedHref);
}

function renderListItem({ tokens }: Tokens.ListItem): string {
  return `<li class="ml-4 mb-1 flex items-start gap-2"><span style="color:var(--text-muted)">•</span><span>${marked.Parser.parse(tokens, { renderer: markdownRenderer })}</span></li>`;
}

markdownRenderer.html = ({ text }) => escapeHtml(text);
markdownRenderer.heading = ({ tokens, depth }) => {
  const content = renderInline(tokens);
  if (depth === 1) {
    return `<h1 class="text-2xl font-bold mb-4 pb-2" style="color:var(--text-primary);border-bottom:1px solid var(--border-subtle)">${content}</h1>`;
  }
  if (depth === 2) {
    return `<h2 class="text-xl font-semibold mt-6 mb-3" style="color:var(--text-primary)">${content}</h2>`;
  }
  return `<h3 class="text-base font-semibold mt-4 mb-2" style="color:var(--text-primary)">${content}</h3>`;
};
markdownRenderer.strong = ({ tokens }) => `<strong style="color:var(--text-primary)">${renderInline(tokens)}</strong>`;
markdownRenderer.link = ({ href, tokens }) => {
  const content = renderInline(tokens);
  return isSafeHref(href) ? `<a href="${escapeHtml(href)}" class="underline decoration-dotted hover:decoration-solid" style="color:var(--accent-cyan)">${content}</a>` : content;
};
markdownRenderer.list = ({ ordered, items }) => {
  const body = items.map((item) => renderListItem(item)).join('');
  return ordered ? `<ol>${body}</ol>` : `<ul>${body}</ul>`;
};
markdownRenderer.listitem = renderListItem;
markdownRenderer.code = ({ text }) => `<pre class="rounded-md p-4 my-4 overflow-x-auto text-xs" style="background:#0D1117;border:1px solid var(--border-subtle)"><code>${escapeHtml(text)}</code></pre>`;
markdownRenderer.codespan = ({ text }) => `<code class="px-1 py-0.5 rounded text-xs" style="background:#0D1117;color:var(--text-primary)">${escapeHtml(text)}</code>`;
markdownRenderer.blockquote = ({ tokens }) => `<blockquote class="pl-4 py-3 pr-4 my-4 rounded-r-md border-l-2" style="border-color:var(--accent-cyan);background:rgba(34,211,238,0.05);color:var(--text-secondary)">${marked.Parser.parse(tokens, { renderer: markdownRenderer })}</blockquote>`;
markdownRenderer.paragraph = ({ tokens }) => `<p class="mb-3 text-sm leading-relaxed" style="color:var(--text-secondary)">${renderInline(tokens)}</p>`;
markdownRenderer.text = ({ text }) => renderKnowledgeLinks(escapeHtml(text));

function sanitizeMarkdownHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'p', 'strong', 'a', 'span', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'br', 'em', 'del'],
    ALLOWED_ATTR: ['class', 'style', 'href', 'title'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#\/kb\/|#(?!\w+:)|\/)/i,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'option'],
  });
}

function parseMarkdownStyle(styleText: string): CSSProperties | undefined {
  const style: CSSProperties = {};
  for (const declaration of styleText.split(';')) {
    const [property, value] = declaration.split(':').map((part) => part.trim());
    if (!property || !value) continue;
    if (property === 'color') style.color = value;
    if (property === 'background') style.background = value;
    if (property === 'background-color') style.backgroundColor = value;
    if (property === 'border') style.border = value;
    if (property === 'border-bottom') style.borderBottom = value;
    if (property === 'border-color') style.borderColor = value;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function markdownNodeToReact(node: ChildNode, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const element = node as Element;
  const children = Array.from(element.childNodes).map((child, index) => markdownNodeToReact(child, `${key}-${index}`));
  const className = element.getAttribute('class') ?? undefined;
  const style = parseMarkdownStyle(element.getAttribute('style') ?? '');
  const href = element.getAttribute('href') ?? undefined;
  const title = element.getAttribute('title') ?? undefined;

  switch (element.tagName.toLowerCase()) {
    case 'h1': return <h1 key={key} className={className} style={style}>{children}</h1>;
    case 'h2': return <h2 key={key} className={className} style={style}>{children}</h2>;
    case 'h3': return <h3 key={key} className={className} style={style}>{children}</h3>;
    case 'p': return <p key={key} className={className} style={style}>{children}</p>;
    case 'strong': return <strong key={key} className={className} style={style}>{children}</strong>;
    case 'a': return <a key={key} className={className} style={style} href={href} title={title}>{children}</a>;
    case 'span': return <span key={key} className={className} style={style}>{children}</span>;
    case 'ul': return <ul key={key} className={className} style={style}>{children}</ul>;
    case 'ol': return <ol key={key} className={className} style={style}>{children}</ol>;
    case 'li': return <li key={key} className={className} style={style}>{children}</li>;
    case 'pre': return <pre key={key} className={className} style={style}>{children}</pre>;
    case 'code': return <code key={key} className={className} style={style}>{children}</code>;
    case 'blockquote': return <blockquote key={key} className={className} style={style}>{children}</blockquote>;
    case 'br': return <br key={key} />;
    case 'em': return <em key={key} className={className} style={style}>{children}</em>;
    case 'del': return <del key={key} className={className} style={style}>{children}</del>;
    default: return children;
  }
}

export function renderMarkdown(md: string): ReactNode[] {
  const parsedHtml = marked.parse(md, { async: false, breaks: true, gfm: true, renderer: markdownRenderer });
  const sanitizedHtml = sanitizeMarkdownHtml(parsedHtml);
  const document = new DOMParser().parseFromString(`<div>${sanitizedHtml}</div>`, 'text/html');
  return Array.from(document.body.firstElementChild?.childNodes ?? []).map((node, index) => markdownNodeToReact(node, `md-${index}`));
}

interface TreeNode {
  id: string;
  name: string;
  type: 'folder' | 'file';
  fileType?: 'md' | 'code' | 'image' | 'other';
  content?: string;
  folderId?: number | null;
  children: TreeNode[];
}

function buildTree(folders: KbFolder[], documents: KbDocument[]): TreeNode[] {
  const folderMap = new Map<number, TreeNode>();
  const root: TreeNode[] = [];

  for (const folder of folders) {
    const node: TreeNode = {
      id: `folder-${folder.id}`,
      name: folder.name,
      type: 'folder',
      children: [],
    };
    folderMap.set(folder.id, node);
  }

  for (const folder of folders) {
    const node = folderMap.get(folder.id);
    if (!node) continue;
    if (folder.parentId && folderMap.has(folder.parentId)) {
      folderMap.get(folder.parentId)!.children.push(node);
    } else {
      root.push(node);
    }
  }

  for (const doc of documents) {
    const fileType = doc.title.endsWith('.md') ? 'md' : doc.format === 'code' ? 'code' : 'other';
    const node: TreeNode = {
      id: `doc-${doc.id}`,
      name: doc.title,
      type: 'file',
      fileType,
      content: doc.content ?? undefined,
      folderId: doc.folderId ?? null,
      children: [],
    };
    if (doc.folderId && folderMap.has(doc.folderId)) {
      folderMap.get(doc.folderId)!.children.push(node);
    } else {
      root.push(node);
    }
  }

  return root;
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children.length > 0) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

function parseDocId(id: string): number | null {
  if (!id.startsWith('doc-')) return null;
  const n = Number(id.slice(4));
  return isNaN(n) ? null : n;
}

function parseFolderId(id: string): number | null {
  if (!id.startsWith('folder-')) return null;
  const n = Number(id.slice(7));
  return isNaN(n) ? null : n;
}

// ===================== Tree Item Component =====================
function TreeItem({ node, depth = 0, activeFile, onSelect, onRename, onDelete, onAdd, onMove }: {
  node: TreeNode; depth?: number; activeFile: string | null; onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void; onDelete: (id: string) => void; onAdd: (parentId: string | null, type: 'folder' | 'file') => void;
  onMove?: (docId: string, folderId: number | null) => void;
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
      {isFolder && expanded && node.children.length > 0 && (
        <div>{node.children.map((child) => (<TreeItem key={child.id} node={child} depth={depth + 1} activeFile={activeFile} onSelect={onSelect} onRename={onRename} onDelete={onDelete} onAdd={onAdd} onMove={onMove} />))}</div>
      )}
    </div>
  );
}

// ===================== Main Page =====================
export default function KnowledgeBase() {
  const { addToast } = useAppStore();
  const { folders, documents, isLoading, createFolder, updateFolder, deleteFolder, createDocument, updateDocument, deleteDocument } = useKbTree();

  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'edit' | 'preview' | 'split'>('preview');
  const [rightPanel, setRightPanel] = useState<'outline' | 'links' | 'tags'>('outline');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const [localContent, setLocalContent] = useState('');
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<'folder' | 'file'>('file');
  const [newName, setNewName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KbDocument[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const activeDocId = activeFile ? parseDocId(activeFile) : null;
  const { data: activeDoc } = useDocument(activeDocId ?? 0);

  const tree = useMemo(() => buildTree(folders, documents), [folders, documents]);
  const activeNode = activeFile ? findNode(tree, activeFile) : null;

  useEffect(() => {
    if (activeDoc?.content !== undefined) {
      setLocalContent(activeDoc.content ?? '');
    }
  }, [activeDoc?.content, activeDoc?.id]);

  const extractOutline = useCallback(() => {
    const lines = localContent.split('\n');
    return lines.map((line, i) => {
      const match = line.match(/^(#{1,3})\s+(.+)/);
      if (match) return { level: match[1].length, text: match[2], line: i };
      return null;
    }).filter(Boolean) as { level: number; text: string; line: number }[];
  }, [localContent]);

  const outline = extractOutline();

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/trpc/kb.searchDocuments?input=${encodeURIComponent(JSON.stringify({ query }))}`);
      const json = await res.json();
      setSearchResults(json.result?.data?.json ?? []);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleAddNode = (parentId: string | null, type: 'folder' | 'file') => {
    setAddingTo(parentId);
    setAddingType(type);
    setNewName(type === 'folder' ? '新建文件夹' : '未命名文档.md');
  };

  const confirmAdd = async () => {
    if (!newName.trim()) return;
    try {
      const parentFolderId = addingTo ? parseFolderId(addingTo) : null;
      if (addingType === 'folder') {
        await createFolder({ name: newName.trim(), parentId: parentFolderId });
        addToast({ type: 'success', title: '文件夹已创建' });
      } else {
        const title = newName.trim();
        const ext = title.endsWith('.md') ? '' : '.md';
        await createDocument({ folderId: parentFolderId, title: title + ext, content: '# ' + title.replace(/\.md$/, '') + '\n\n' });
        addToast({ type: 'success', title: '文档已创建' });
      }
      setAddingTo(null);
      setNewName('');
    } catch (err) {
      addToast({ type: 'error', title: '创建失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleRename = async (id: string, name: string) => {
    try {
      if (id.startsWith('folder-')) {
        const fid = parseFolderId(id);
        if (fid) await updateFolder({ id: fid, name });
      } else {
        const did = parseDocId(id);
        if (did) await updateDocument({ id: did, title: name });
      }
      addToast({ type: 'success', title: '已重命名' });
    } catch (err) {
      addToast({ type: 'error', title: '重命名失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const node = findNode(tree, id);
      if (!node) return;
      if (id.startsWith('folder-')) {
        const fid = parseFolderId(id);
        if (fid) await deleteFolder({ id: fid });
      } else {
        const did = parseDocId(id);
        if (did) await deleteDocument({ id: did });
      }
      if (activeFile === id) setActiveFile(null);
      addToast({ type: 'info', title: '已删除' });
    } catch (err) {
      addToast({ type: 'error', title: '删除失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleSaveContent = async () => {
    if (!activeDocId) return;
    try {
      await updateDocument({ id: activeDocId, content: localContent });
      addToast({ type: 'success', title: '已保存' });
    } catch (err) {
      addToast({ type: 'error', title: '保存失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleReindex = async () => {
    if (!activeDocId) return;
    try {
      const res = await fetch('/api/trpc/kb.reindexDocument', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeDocId }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      addToast({ type: 'success', title: `重建索引完成 (${json.result?.data?.json?.chunks ?? 0} 分块)` });
    } catch (err) {
      addToast({ type: 'error', title: '重建索引失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleTagsChange = async (tags: string[]) => {
    if (!activeDocId) return;
    try {
      await updateDocument({ id: activeDocId, tags });
      addToast({ type: 'success', title: '标签已更新' });
    } catch (err) {
      addToast({ type: 'error', title: '标签更新失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleMove = async (docId: string, folderId: number | null) => {
    const did = parseDocId(docId);
    if (!did) return;
    try {
      await fetch('/api/trpc/kb.moveDocument', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: did, folderId }),
      });
      addToast({ type: 'success', title: '已移动' });
    } catch (err) {
      addToast({ type: 'error', title: '移动失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const recentDocs = useMemo(() => {
    return [...documents].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5);
  }, [documents]);

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-48px)] items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载知识库...</div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-48px)]" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Left Sidebar */}
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
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="搜索文档..."
                className="bg-transparent text-xs outline-none w-full"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>
          </div>

          {searchQuery ? (
            <div className="flex-1 overflow-y-auto p-1">
              {isSearching ? (
                <div className="text-xs p-2" style={{ color: 'var(--text-muted)' }}>搜索中...</div>
              ) : searchResults.length === 0 ? (
                <div className="text-xs p-2" style={{ color: 'var(--text-muted)' }}>无结果</div>
              ) : (
                searchResults.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => setActiveFile(`doc-${doc.id}`)}
                    className="w-full text-left px-2 py-1 text-xs rounded hover:bg-white/5"
                    style={{ color: activeFile === `doc-${doc.id}` ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}
                  >
                    {doc.title}
                  </button>
                ))
              )}
            </div>
          ) : (
            <>
              {addingTo !== null && (
                <div className="px-3 py-2 flex items-center gap-1" style={{ backgroundColor: 'rgba(34,211,238,0.05)' }}>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); if (e.key === 'Escape') setAddingTo(null); }} autoFocus className="input-base text-xs h-7 py-0.5 px-1.5 flex-1" placeholder={addingType === 'folder' ? '文件夹名' : '文件名.md'} />
                  <button onClick={confirmAdd} className="p-1"><Check className="w-3.5 h-3.5" style={{ color: 'var(--accent-emerald)' }} /></button>
                  <button onClick={() => setAddingTo(null)} className="p-1"><X className="w-3.5 h-3.5" style={{ color: 'var(--accent-rose)' }} /></button>
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-1">
                {tree.map((node) => (
                  <TreeItem key={node.id} node={node} activeFile={activeFile} onSelect={setActiveFile} onRename={handleRename} onDelete={handleDelete} onAdd={handleAddNode} onMove={handleMove} />
                ))}
              </div>

              <div className="p-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>最近编辑</div>
                <div className="space-y-1">
                  {recentDocs.map((doc) => (
                    <button
                      key={doc.id}
                      onClick={() => setActiveFile(`doc-${doc.id}`)}
                      className="w-full text-left text-[10px] truncate hover:text-[var(--accent-cyan)]"
                      style={{ color: activeFile === `doc-${doc.id}` ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}
                    >
                      {doc.title}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
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

        {activeDoc ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b shrink-0" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                <Tag className="w-3.5 h-3.5" />
                {(activeDoc.tags ?? []).length === 0 ? '无标签' : (activeDoc.tags ?? []).map((tag) => (
                  <span key={tag} className="chip chip-violet text-[10px] py-0.5 px-1.5">{tag}</span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <TagEditor tags={activeDoc.tags ?? []} onChange={handleTagsChange} />
                <MoveButton docId={activeFile} folders={folders} currentFolderId={activeDoc.folderId ?? null} onMove={handleMove} />
                <button onClick={handleReindex} className="btn-ghost text-[10px] py-1 px-2 flex items-center gap-1" title="重建向量索引">
                  <RotateCcw className="w-3 h-3" />重建索引
                </button>
                <button onClick={handleSaveContent} className="btn-primary text-[10px] py-1 px-2 flex items-center gap-1">
                  <Save className="w-3 h-3" />保存
                </button>
              </div>
            </div>
            <div className="flex-1 flex overflow-hidden">
              {(editMode === 'edit' || editMode === 'split') && (
                <div className={`${editMode === 'split' ? 'w-1/2 border-r' : 'w-full'} overflow-auto`} style={{ borderColor: 'var(--border-subtle)' }}>
                  <textarea value={localContent} onChange={(e) => setLocalContent(e.target.value)} className="w-full h-full p-6 bg-transparent text-sm leading-relaxed resize-none outline-none font-mono" style={{ color: 'var(--text-primary)' }} spellCheck={false} />
                </div>
              )}
              {(editMode === 'preview' || editMode === 'split') && (
                <div className={`${editMode === 'split' ? 'w-1/2' : 'w-full'} overflow-auto`}>
                  <div className="p-6 max-w-3xl mx-auto">{renderMarkdown(localContent)}</div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
            <div className="text-center">
              <FileText className="w-12 h-12 mx-auto mb-3" />
              <p className="text-sm">选择一个文档开始编辑</p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between px-4 py-1 border-t text-[11px] shrink-0" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
          <div className="flex items-center gap-4"><span>{localContent.length.toLocaleString()} 字符</span><span>约 {Math.ceil(localContent.length / 400)} 分钟阅读</span></div>
          <div className="flex items-center gap-4"><span>{activeDoc ? new Date(activeDoc.updatedAt).toLocaleString() : '-'}</span></div>
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
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>链接功能即将上线</div>
            )}
            {rightPanel === 'tags' && (
              <div className="flex flex-wrap gap-1.5">
                {(activeDoc?.tags ?? []).length === 0 ? <span className="text-xs" style={{ color: 'var(--text-muted)' }}>无标签</span> : (activeDoc?.tags ?? []).map((tag) => (
                  <span key={tag} className="chip chip-violet cursor-pointer">{tag}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(tags.join(', '));

  const handleSave = () => {
    const newTags = value.split(',').map((t) => t.trim()).filter(Boolean);
    onChange(newTags);
    setIsEditing(false);
  };

  if (!isEditing) {
    return (
      <button onClick={() => setIsEditing(true)} className="btn-ghost text-[10px] py-1 px-2 flex items-center gap-1">
        <Tag className="w-3 h-3" />编辑标签
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setIsEditing(false); }}
        placeholder="用逗号分隔"
        className="input-base text-[10px] h-6 w-32"
        autoFocus
      />
      <button onClick={handleSave} className="p-0.5"><Check className="w-3 h-3" style={{ color: 'var(--accent-emerald)' }} /></button>
      <button onClick={() => setIsEditing(false)} className="p-0.5"><X className="w-3 h-3" style={{ color: 'var(--accent-rose)' }} /></button>
    </div>
  );
}

function MoveButton({ docId, folders, currentFolderId, onMove }: { docId: string | null; folders: KbFolder[]; currentFolderId: number | null; onMove: (docId: string, folderId: number | null) => void }) {
  const [open, setOpen] = useState(false);
  if (!docId) return null;

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="btn-ghost text-[10px] py-1 px-2 flex items-center gap-1">
        <MoreHorizontal className="w-3 h-3" />移动到
      </button>
      {open && (
        <div className="absolute right-0 top-8 w-40 rounded border shadow-lg z-20" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <button
            onClick={() => { onMove(docId, null); setOpen(false); }}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5"
            style={{ color: currentFolderId === null ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}
          >
            根目录
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => { onMove(docId, folder.id); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5"
              style={{ color: currentFolderId === folder.id ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}
            >
              {folder.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
