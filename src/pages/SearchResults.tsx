import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, FileText, AlertCircle } from 'lucide-react';
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

export default function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const {
    data: searchData,
    isLoading,
    error,
  } = trpc.knowledge.semanticSearch.useQuery(
    { query: query.trim(), topK: 20 },
    { enabled: query.trim().length > 0, retry: 1 }
  );

  const results = searchData?.results ?? [];
  const mode = searchData?.mode ?? 'fallback';
  const engine = searchData?.engine ?? 'mysql-like';

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed) {
      setSearchParams({ q: trimmed });
    } else {
      setSearchParams({});
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Search Header */}
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
            placeholder="搜索知识库..."
            className="flex-1 bg-transparent text-base outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
        </form>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {query.trim() ? `共找到 ${results.length} 个结果` : '输入关键词开始搜索'}
            </span>
            {query.trim() && !isLoading && (
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

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-muted)' }}>
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
          搜索中...
        </div>
      )}

      {/* Error */}
      {error && !isLoading && (
        <div className="flex items-start gap-3 p-4 rounded-lg" style={{ backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <AlertCircle className="w-5 h-5 shrink-0" style={{ color: '#EF4444' }} />
          <div>
            <div className="text-sm font-medium" style={{ color: '#EF4444' }}>搜索失败</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{error.message}</div>
          </div>
        </div>
      )}

      {/* Empty */}
      {!isLoading && !error && query.trim() && results.length === 0 && (
        <div className="text-center py-16 rounded-lg border border-dashed" style={{ borderColor: 'var(--border-subtle)' }}>
          <FileText className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>未找到与 “{query.trim()}” 相关的结果</p>
        </div>
      )}

      {/* Results */}
      {!isLoading && !error && results.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <FileText className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            知识节点 ({results.length})
          </h3>
          {results.map((item) => (
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
    </div>
  );
}
