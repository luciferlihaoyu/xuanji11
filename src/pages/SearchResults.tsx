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
  } = trpc.kb.hybridSearch.useQuery(
    { query: trimmed, limit: 20 },
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

  // 引用式问答
  const [askTriggered, setAskTriggered] = useState(false);
  const askMutation = trpc.kb.ask.useMutation();
  const handleAsk = () => {
    if (trimmed.length < 2) return;
    setAskTriggered(true);
    askMutation.mutate({ query: trimmed });
  };
  const files = filesData ?? [];
  const docs = docsData ?? [];
  const agents = agentsData ?? [];

  const keywordCount = searchData?.metadata.keywordResults ?? 0;
  const vectorCount = searchData?.metadata.vectorResults ?? 0;

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
    <div className="p-3 sm:p-6 max-w-5xl mx-auto" style={{ backgroundColor: 'var(--bg-primary)' }}>
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
          <button
            type="button"
            onClick={handleAsk}
            disabled={trimmed.length < 2 || askMutation.isPending}
            className="ml-2 px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-40"
            style={{ backgroundColor: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}
            title="基于知识库生成带引用的回答"
          >
            {askMutation.isPending ? '思考中…' : '问一问'}
          </button>
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
                  backgroundColor: 'rgba(52,211,153,0.15)',
                  color: '#34D399',
                }}
              >
                混合搜索 · 关键词 {keywordCount} + 语义 {vectorCount}
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

      {/* 引用式问答答案卡片 */}
      {askTriggered && askMutation.data && (
        <div className="mb-6 rounded-lg border p-4 max-w-2xl mx-auto"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: askMutation.data.insufficient ? 'rgba(251,191,36,0.3)' : 'rgba(167,139,250,0.3)' }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold" style={{ color: '#a78bfa' }}>知识库回答</span>
            {askMutation.data.insufficient && (
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
                证据不足
              </span>
            )}
            <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
              {askMutation.data.evidenceCount} 条证据{askMutation.data.model ? ` · ${askMutation.data.model}` : ''}
            </span>
          </div>
          <div className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-primary)' }}>
            {askMutation.data.answer}
          </div>
          {askMutation.data.citations.length > 0 && (
            <div className="mt-3 pt-3 border-t space-y-1" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>引用来源：</div>
              {askMutation.data.citations.map((c) => (
                <div key={c.n} className="text-xs flex items-start gap-2">
                  <span className="shrink-0 font-mono" style={{ color: '#a78bfa' }}>[{c.n}]</span>
                  <Link to={`/doc/${c.documentId}`} className="hover:underline truncate" style={{ color: 'var(--accent-cyan)' }}>
                    {c.title}
                  </Link>
                </div>
              ))}
            </div>
          )}
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
                {(item.reasons ?? []).map((r) => (
                  <span key={r} className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: 'rgba(34,211,238,0.1)', color: 'var(--accent-cyan)' }}>{r}</span>
                ))}
              </div>
              {(item.evidence ?? []).length > 1 && (
                <details className="mt-2 text-xs" onClick={(e) => e.preventDefault()}>
                  <summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                    {item.evidence.length} 个命中片段
                  </summary>
                  <div className="mt-1 space-y-1 pl-3 border-l-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    {item.evidence.map((ev, i) => (
                      <p key={i} className="line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                        <span className="text-[10px] mr-1" style={{ color: 'var(--text-muted)' }}>
                          [{ev.source === 'vector' ? '语义' : '关键词'}]
                        </span>
                        {highlightText(ev.snippet.slice(0, 120), query)}
                      </p>
                    ))}
                  </div>
                </details>
              )}
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
