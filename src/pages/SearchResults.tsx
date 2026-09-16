import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, FileText, AlertCircle, FolderOpen, Bot, Paperclip } from 'lucide-react';
import { trpc, trpcClient } from '@/providers/trpc';

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

  // 过滤器 + 重排
  const [filterFolder, setFilterFolder] = useState<number | ''>('');
  const [filterTag, setFilterTag] = useState('');
  const [rerank, setRerank] = useState(false);
  const { data: folders } = trpc.kb.listFolders.useQuery();
  const filters = (filterFolder !== '' || filterTag.trim())
    ? { ...(filterFolder !== '' ? { folder: filterFolder } : {}), ...(filterTag.trim() ? { tags: [filterTag.trim()] } : {}) }
    : undefined;

  const {
    data: searchData,
    isLoading: knowledgeLoading,
    error: knowledgeError,
  } = trpc.kb.hybridSearch.useQuery(
    { query: trimmed, limit: 20, rerank, ...(filters ? { filters } : {}) },
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

  // 点击埋点（不阻塞跳转，失败静默）
  const logClick = (documentId: number) => {
    if (!trimmed) return;
    void trpcClient.kb.logSearchEvent.mutate({ query: trimmed, documentId, event: 'click' }).catch(() => {});
  };

  // 引用式问答（多轮 + SSE 流式）
  const [askTriggered, setAskTriggered] = useState(false);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [streaming, setStreaming] = useState('');
  const [asking, setAsking] = useState(false);
  const [askMeta, setAskMeta] = useState<{ insufficient: boolean; evidenceCount: number; model?: string; citations: Array<{ n: number; documentId: string; title: string }> } | null>(null);
  const handleAsk = () => {
    if (trimmed.length < 2 || asking) return;
    setAskTriggered(true);
    setAsking(true);
    setStreaming('');
    setAskMeta(null);
    void trpcClient.kb.logSearchEvent.mutate({ query: trimmed, event: 'ask' }).catch(() => {});
    const historyParam = encodeURIComponent(JSON.stringify(chatHistory));
    const es = new EventSource(`/api/ask/stream?query=${encodeURIComponent(trimmed)}&history=${historyParam}`);
    let full = '';
    es.addEventListener('token', (e) => {
      try {
        const { token } = JSON.parse((e as MessageEvent).data);
        full += token;
        setStreaming(full);
      } catch { /* ignore */ }
    });
    es.addEventListener('result', (e) => {
      try {
        const r = JSON.parse((e as MessageEvent).data);
        const answer = r.answer || full;
        setAskMeta({ insufficient: r.insufficient, evidenceCount: r.evidenceCount, model: r.model, citations: r.citations ?? [] });
        setChatHistory((h) => [...h, { role: 'user', content: trimmed }, { role: 'assistant', content: answer }]);
        setStreaming('');
      } catch { /* ignore */ }
      setAsking(false);
      es.close();
    });
    es.addEventListener('error', () => {
      setAsking(false);
      if (full) {
        setChatHistory((h) => [...h, { role: 'user', content: trimmed }, { role: 'assistant', content: full }]);
        setStreaming('');
      }
      es.close();
    });
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
            disabled={trimmed.length < 2 || asking}
            className="ml-2 px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-40"
            style={{ backgroundColor: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}
            title="基于知识库生成带引用的回答"
          >
            {asking ? '思考中…' : chatHistory.length > 0 ? '追问' : '问一问'}
          </button>
        </form>

        {/* 过滤器栏 */}
        <div className="flex items-center gap-2 flex-wrap max-w-2xl mx-auto mb-3">
          <select
            value={filterFolder}
            onChange={(e) => setFilterFolder(e.target.value === '' ? '' : Number(e.target.value))}
            className="text-xs px-2 py-1.5 rounded border"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          >
            <option value=''>全部文件夹</option>
            {(folders ?? []).map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
            placeholder="按标签过滤…"
            className="text-xs px-2 py-1.5 rounded border w-28 outline-none"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          />
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }} title="用 LLM 对候选结果精排（更准但更慢）">
            <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} className="accent-cyan-400" />
            AI 重排
          </label>
          {(filterFolder !== '' || filterTag.trim() || rerank) && (
            <button
              onClick={() => { setFilterFolder(''); setFilterTag(''); setRerank(false); }}
              className="text-[10px] px-2 py-1 rounded"
              style={{ color: 'var(--text-muted)' }}
            >清除</button>
          )}
        </div>

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
      {askTriggered && (chatHistory.length > 0 || streaming || asking) && (
        <div className="mb-6 rounded-lg border p-4 max-w-2xl mx-auto"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'rgba(167,139,250,0.3)' }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-semibold" style={{ color: '#a78bfa' }}>知识库问答</span>
            {askMeta?.insufficient && (
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
                证据不足
              </span>
            )}
            <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
              {askMeta ? `${askMeta.evidenceCount} 条证据${askMeta.model ? ` · ${askMeta.model}` : ''}` : asking ? '检索+生成中…' : ''}
            </span>
            <button
              onClick={() => { setChatHistory([]); setAskMeta(null); setAskTriggered(false); }}
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/5"
              style={{ color: 'var(--text-muted)' }}
              title="清空对话"
            >清空</button>
          </div>
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {chatHistory.map((msg, i) => (
              <div key={i} className={msg.role === 'user' ? 'text-right' : ''}>
                <div className={`inline-block text-sm whitespace-pre-wrap leading-relaxed rounded-lg px-3 py-2 max-w-[90%] text-left ${msg.role === 'user' ? '' : 'w-full'}`}
                  style={{
                    backgroundColor: msg.role === 'user' ? 'rgba(34,211,238,0.12)' : 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                  }}>
                  {msg.content}
                </div>
              </div>
            ))}
            {streaming && (
              <div className="text-sm whitespace-pre-wrap leading-relaxed rounded-lg px-3 py-2"
                style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                {streaming}<span className="animate-pulse" style={{ color: '#a78bfa' }}>▍</span>
              </div>
            )}
            {asking && !streaming && (
              <div className="text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                检索证据并生成回答…
              </div>
            )}
          </div>
          {askMeta && askMeta.citations.length > 0 && (
            <div className="mt-3 pt-3 border-t space-y-1" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>引用来源：</div>
              {askMeta.citations.map((c) => (
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
              onClick={() => { const n = Number(item.id); if (Number.isFinite(n)) logClick(n); }}
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
