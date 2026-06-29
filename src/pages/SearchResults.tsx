import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, FileText, AlertCircle, FolderOpen, Bot, Paperclip } from 'lucide-react';
import { trpc } from '@/providers/trpc';

function highlightText(text: string, query: string) {
  if (!query.trim()) return <span>{text}</span>;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).filter(Boolean).join('|')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        query.toLowerCase().includes(part.toLowerCase()) && query.split(/\s+/).some((q) => q.toLowerCase() === part.toLowerCase()) ? (
          <span key={i} style={{ backgroundColor: 'rgba(34,211,238,0.2)', color: 'var(--accent-cyan)' }}>{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function formatBytes(n: number | null | undefined) {
  if (n === null || n === undefined || n === 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const trimmed = query.trim();
  const enabled = trimmed.length > 0;

  const {
    data: searchData,
    isLoading: knowledgeLoading,
    error: knowledgeError,
  } = trpc.knowledge.semanticSearch.useQuery(
    { query: trimmed, topK: 20 },
    { enabled, retry: 1 }
  );

  const {
    data: filesData,
    isLoading: filesLoading,
    error: filesError,
  } = trpc.file.list.useQuery(
    { search: trimmed },
    { enabled, retry: 1 }
  );

  const {
    data: docsData,
    isLoading: docsLoading,
    error: docsError,
  } = trpc.kb.searchDocuments.useQuery(
    { query: trimmed },
    { enabled, retry: 1 }
  );

  const {
    data: agentsData,
    isLoading: agentsLoading,
    error: agentsError,
  } = trpc.agent.list.useQuery(
    { search: trimmed },
    { enabled, retry: 1 }
  );

  const knowledgeResults = searchData?.results ?? [];
  const files = filesData ?? [];
  const docs = docsData ?? [];
  const agents = agentsData ?? [];

  const mode = searchData?.mode ?? 'fallback';
  const engine = searchData?.engine ?? 'mysql-like';

  const isLoading = knowledgeLoading || filesLoading || docsLoading || agentsLoading;
  const hasError = knowledgeError || filesError || docsError || agentsError;
  const total = knowledgeResults.length + files.length + docs.length + agents.length;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (trimmed) {
      setSearchParams({ q: trimmed });
    } else {
      setSearchParams({});
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="mb-6">
        <form
          onSubmit={handleSearch}
          className="flex items-center max-w-2xl mx-auto h-10 px-4 rounded-lg border mb-4"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
        >
          <Search className="w-5 h-5 mr-3" style={{ color: 'var(--accent-cyan)' }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索知识、文件、文档、Agent..."
            className="flex-1 bg-transparent text-base outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
        </form>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {trimmed ? `共找到 ${total} 个结果` : '输入关键词开始搜索'}
            </span>
            {trimmed && !isLoading && (
              <span
                className="chip text-[10px] py-0 px-1.5"
                style={{
                  backgroundColor: mode === 'semantic' ? 'rgba(52,211,153,0.15)' : 'rgba(251,191,36,0.15)',
                  color: mode === 'semantic' ? '#34D399' : '#FBBF24',
                }}
              >
                {mode === 'semantic' ? `语义搜索 · ${engine}` : `关键词回退 · ${engine}`}
              </span>
            )}
          </div>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-muted)' }}>
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
          搜索中...
        </div>
      )}

      {hasError && !isLoading && (
        <div className="flex items-start gap-3 p-4 rounded-lg mb-4" style={{ backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <AlertCircle className="w-5 h-5 shrink-0" style={{ color: '#EF4444' }} />
          <div>
            <div className="text-sm font-medium" style={{ color: '#EF4444' }}>部分搜索失败</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {[knowledgeError, filesError, docsError, agentsError].filter(Boolean).map((e) => e?.message).join('；')}
            </div>
          </div>
        </div>
      )}

      {!isLoading && !hasError && trimmed && total === 0 && (
        <div className="text-center py-16 rounded-lg border border-dashed" style={{ borderColor: 'var(--border-subtle)' }}>
          <FileText className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>未找到与 “{trimmed}” 相关的结果</p>
        </div>
      )}

      {!isLoading && !hasError && knowledgeResults.length > 0 && (
        <div className="space-y-3 mb-6">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <FileText className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            知识节点 ({knowledgeResults.length})
          </h3>
          {knowledgeResults.map((item) => (
            <Link
              key={item.id}
              to={`/kb/${item.id}`}
              className="block card-base p-4 hover:border-[var(--accent-cyan)] transition-colors"
            >
              <h4 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                {highlightText(item.title ?? '(无标题)', query)}
              </h4>
              <p className="text-sm mb-2 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                {highlightText(item.snippet ?? '', query)}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="chip text-[10px] py-0 px-1.5">{item.type ?? 'note'}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>匹配度: {item.score ?? '-'}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {!isLoading && !hasError && docs.length > 0 && (
        <div className="space-y-3 mb-6">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <FolderOpen className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            知识库文档 ({docs.length})
          </h3>
          {docs.map((doc) => (
            <Link
              key={doc.id}
              to={`/doc/${doc.id}`}
              className="block card-base p-4 hover:border-[var(--accent-cyan)] transition-colors"
            >
              <h4 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                {highlightText(doc.title, query)}
              </h4>
              <p className="text-sm mb-2 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                {highlightText((doc.content ?? '').slice(0, 200), query)}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="chip text-[10px] py-0 px-1.5">{doc.format}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{new Date(doc.updatedAt).toLocaleString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {!isLoading && !hasError && files.length > 0 && (
        <div className="space-y-3 mb-6">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Paperclip className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            文件 ({files.length})
          </h3>
          {files.map((file) => (
            <div
              key={file.id}
              className="card-base p-4"
            >
              <h4 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                {highlightText(file.originalName, query)}
              </h4>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="chip text-[10px] py-0 px-1.5">{file.mimeType ?? '未知类型'}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{formatBytes(file.size)}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{new Date(file.createdAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && !hasError && agents.length > 0 && (
        <div className="space-y-3 mb-6">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Bot className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            Agent ({agents.length})
          </h3>
          {agents.map((agent) => (
            <Link
              key={agent.id}
              to={`/agents`}
              className="block card-base p-4 hover:border-[var(--accent-cyan)] transition-colors"
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{
                    background: 'linear-gradient(135deg, rgba(0,229,255,0.2), rgba(167,139,250,0.2))',
                    border: '1px solid var(--accent-cyan)',
                    color: 'var(--accent-cyan)',
                  }}
                >
                  {agent.name.slice(0, 1)}
                </div>
                <div className="flex-1">
                  <h4 className="text-base font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
                    {highlightText(agent.name, query)}
                  </h4>
                  <p className="text-sm line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                    {highlightText(agent.description ?? '', query)}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap mt-1">
                    <span className="chip text-[10px] py-0 px-1.5">{agent.type}</span>
                    <span className="chip text-[10px] py-0 px-1.5">{agent.status}</span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
