import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  FileText,
} from 'lucide-react';
import { useDocument, useKbTree } from '@/hooks/useKb';
import { renderMarkdown } from '@/pages/KnowledgeBase';
import { useAppStore } from '@/store/useAppStore';
import { trpc } from '@/providers/trpc';
import { downloadDocument } from './utils';
import { PageLoading, PageError, RightPanel } from './components';

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
    <div className="flex h-[calc(100vh-48px)]" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Preview Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div
          className="flex items-center justify-between px-4 py-2 border-b shrink-0"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            <Link to="/kb" className="flex items-center gap-1 hover:text-[var(--accent-cyan)] transition-colors">
              <ChevronLeft className="w-4 h-4" />
              返回知识库
            </Link>
            <span>/</span>
            <span>{folder?.name ?? '知识库'}</span>
            <span>/</span>
            <span style={{ color: 'var(--text-primary)' }}>{doc.title}</span>
          </div>
          <div className="flex items-center gap-1">
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

        {/* Preview Content */}
        <div className="flex-1 overflow-auto p-6" style={{ backgroundColor: 'var(--bg-primary)' }}>
          <div className="max-w-3xl mx-auto transition-transform origin-top" style={{ transform: `scale(${zoom})` }}>
            <div
              className="p-6 rounded-md border shadow-lg"
              style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
            >
              {doc.content ? (
                renderMarkdown(doc.content)
              ) : (
                <div className="flex flex-col items-center justify-center py-12">
                  <FileText className="w-16 h-16 mb-4" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{doc.title}</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>暂无内容</p>
                </div>
              )}
            </div>
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
    </div>
  );
}
