import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ChevronLeft,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  FileText,
  Target,
  X,
  PanelRight,
} from 'lucide-react';
import { useDocument, useKbTree } from '@/hooks/useKb';
import { renderMarkdown } from '@/pages/KnowledgeBase';
import { useAppStore } from '@/store/useAppStore';
import { trpc } from '@/providers/trpc';
import MobileDrawer from '@/components/MobileDrawer';
import { downloadDocument } from './utils';
import { PageLoading, PageError, RightPanel } from './components';

/** 触控热区 ≥40×40（移动端放大，md 起还原桌面原尺寸） */
const TAP_TARGET = 'min-w-[40px] min-h-[40px] inline-flex items-center justify-center md:min-w-0 md:min-h-0';

/** 从 location.hash 解析引用锚点：#chunk-3 → 3；无则不定位 */
function parseChunkHash(hash: string): number | null {
  const m = /^#chunk-(\d+)$/.exec(hash);
  return m ? Number(m[1]) : null;
}

/** 引用定位面板：展示命中块原文并把查询词高亮出来 */
function ChunkAnchorPanel({ documentId, chunkIndex, query, onClose }: {
  documentId: number;
  chunkIndex: number;
  query: string;
  onClose: () => void;
}) {
  const { data: ctx, isLoading } = trpc.kb.getChunkContext.useQuery({ documentId, chunkIndex });
  const q = query.trim();
  const content = ctx?.content ?? '';
  const idx = q ? content.toLowerCase().indexOf(q.toLowerCase()) : -1;

  return (
    <div
      className="mb-4 p-3 rounded-lg border"
      style={{ backgroundColor: 'rgba(34,211,238,0.06)', borderColor: 'rgba(34,211,238,0.3)' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Target size={14} className="text-cyan-400" />
        <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
          引用定位{ctx ? ` · 第 ${ctx.chunkIndex + 1} / ${ctx.totalChunks} 块` : ''}
          {ctx?.heading ? ` · ${ctx.heading}` : ''}
        </span>
        {q && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>匹配词：{q}{idx < 0 ? '（语义命中，块内无字面匹配）' : ''}</span>}
        <button onClick={onClose} className="ml-auto p-1 min-w-[40px] min-h-[40px] inline-flex items-center justify-center rounded hover:bg-white/5 md:min-w-0 md:min-h-0" style={{ color: 'var(--text-muted)' }} title="关闭定位" aria-label="关闭引用定位">
          <X size={13} />
        </button>
      </div>
      <div className="text-xs whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto" style={{ color: 'var(--text-secondary)' }}>
        {isLoading && '加载命中段落…'}
        {!isLoading && !ctx && '未找到该段落（文档可能已重新索引，块序号已变化）。'}
        {!isLoading && ctx && (idx < 0 ? (
          content
        ) : (
          <>
            {content.slice(0, idx)}
            <span style={{ backgroundColor: 'rgba(34,211,238,0.35)', color: 'var(--text-primary)', borderRadius: 2 }}>
              {content.slice(idx, idx + q.length)}
            </span>
            {content.slice(idx + q.length)}
          </>
        ))}
      </div>
    </div>
  );
}

export default function DocumentDetail() {
  const { id: idParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { addToast } = useAppStore();
  const { folders, deleteDocument } = useKbTree();

  const docId = idParam ? Number(idParam) : NaN;
  const isValidId = !Number.isNaN(docId) && docId > 0;

  const { data: doc, isLoading, error } = useDocument(isValidId ? docId : 0, { enabled: isValidId });

  const { data: associatedNodes } = trpc.knowledge.searchNodes.useQuery(
    { query: doc?.title ?? '' },
    { enabled: !!doc?.title }
  );

  const [zoom, setZoom] = useState(1);
  // 移动端（<768px）信息面板抽屉开关；桌面右栏常驻，不受此状态影响
  const [panelOpen, setPanelOpen] = useState(false);

  // 引用锚点：从 URL 的 #chunk-N 与 ?q= 解析（由搜索结果/引用的「可点击跳转」写入）
  const [searchParams, setSearchParams] = useSearchParams();
  const anchorQuery = searchParams.get('q') ?? '';
  const [dismissedAnchor, setDismissedAnchor] = useState(false);
  const anchorChunk = useMemo(() => parseChunkHash(window.location.hash), []);
  const showAnchor = isValidId && anchorChunk !== null && !dismissedAnchor;

  const closeAnchor = () => {
    setDismissedAnchor(true);
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    setSearchParams(next, { replace: true });
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  useEffect(() => {
    if (error) {
      addToast({ type: 'error', title: '文档加载失败', description: error.message });
    }
  }, [error, addToast]);

  const folder = useMemo(() => folders.find((f) => f.id === doc?.folderId), [folders, doc?.folderId]);

  const handleDownload = () => {
    if (!doc) return;
    downloadDocument(doc);
  };

  const handleEdit = () => {
    if (!doc) return;
    navigate(`/kb/doc-${doc.id}`);
  };

  const handleDelete = async () => {
    if (!doc) return;
    try {
      await deleteDocument({ id: doc.id });
      addToast({ type: 'info', title: '已删除' });
      navigate('/kb');
    } catch (err) {
      addToast({ type: 'error', title: '删除失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleCreateAssociation = () => {
    navigate('/');
    addToast({ type: 'info', title: '请在知识图谱中创建关联' });
  };

  if (!isValidId) {
    return <PageError title="文档不存在" message="无效的文档 ID" />;
  }

  if (isLoading) {
    return <PageLoading />;
  }

  if (!doc) {
    return <PageError title="文档不存在" message="无法找到该文档，可能已被删除" />;
  }

  return (
    <div className="flex h-app flex-col md:flex-row" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Preview Area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Toolbar */}
        <div
          className="flex flex-wrap items-center justify-between gap-y-2 px-3 py-2 border-b shrink-0 sm:px-4"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2 text-xs min-w-0 flex-1" style={{ color: 'var(--text-muted)' }}>
            <Link to="/kb" className="flex items-center gap-1 hover:text-[var(--accent-cyan)] transition-colors shrink-0 py-2 min-h-[40px] md:py-0 md:min-h-0">
              <ChevronLeft className="w-4 h-4" />
              <span className="hidden sm:inline">返回知识库</span>
            </Link>
            <span className="hidden sm:inline shrink-0">/</span>
            <span className="hidden sm:inline truncate max-w-[8rem]">{folder?.name ?? '知识库'}</span>
            <span className="hidden sm:inline shrink-0">/</span>
            <span className="truncate min-w-0" style={{ color: 'var(--text-primary)' }}>{doc.title}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setPanelOpen(true)}
              className={`${TAP_TARGET} rounded hover:bg-white/5 md:hidden`}
              style={{ color: 'var(--text-secondary)' }}
              aria-label="打开文档信息面板"
            >
              <PanelRight className="w-4 h-4" />
            </button>
            <div className="hidden md:flex items-center gap-1">
              <button
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
                className="p-1.5 rounded hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs w-12 text-center" style={{ color: 'var(--text-muted)' }}>
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
                className="p-1.5 rounded hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <div className="w-px h-5 mx-2" style={{ backgroundColor: 'var(--border-subtle)' }} />
              <button
                onClick={() => setZoom(1)}
                className="p-1.5 rounded hover:bg-white/5"
                style={{ color: 'var(--text-secondary)' }}
              >
                <RotateCcw className="w-4 h-4" />
              </button>
              <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }}>
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Preview Content */}
        <div className="flex-1 min-h-0 overflow-auto p-3 sm:p-6" style={{ backgroundColor: 'var(--bg-primary)' }}>
          <div className="w-full max-w-3xl mx-auto min-w-0 transition-transform origin-top" style={{ transform: `scale(${zoom})` }}>
            {showAnchor && anchorChunk !== null && (
              <ChunkAnchorPanel
                documentId={docId}
                chunkIndex={anchorChunk}
                query={anchorQuery}
                onClose={closeAnchor}
              />
            )}
            <div
              className="p-4 sm:p-6 rounded-md border shadow-lg min-w-0 max-w-full break-words"
              style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
            >
              {doc.content ? (
                renderMarkdown(doc.content)
              ) : (
                <div className="flex flex-col items-center justify-center py-12">
                  <FileText className="w-16 h-16 mb-4" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-lg font-semibold text-center break-words" style={{ color: 'var(--text-primary)' }}>{doc.title}</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>暂无内容</p>
                </div>
              )}
            </div>
            {/* 移动端底部安全区占位（md 起不渲染，桌面像素不变） */}
            <div className="md:hidden" style={{ height: 'env(safe-area-inset-bottom)' }} />
          </div>
        </div>
      </div>

      <RightPanel
        doc={doc}
        associatedNodes={associatedNodes}
        onDownload={handleDownload}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onCreateAssociation={handleCreateAssociation}
      />

      {/* 移动端文档信息抽屉（与桌面右栏共用同一份内容） */}
      <MobileDrawer
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        side="right"
        title="文档信息"
        ariaLabel="文档信息面板"
      >
        <RightPanel
          doc={doc}
          associatedNodes={associatedNodes}
          onDownload={handleDownload}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onCreateAssociation={handleCreateAssociation}
          embedded
        />
      </MobileDrawer>
    </div>
  );
}
