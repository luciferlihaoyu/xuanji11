/**
 * 检索测试台：一页看清「这次检索为什么命中 / 命中得怎么样」。
 *
 * - 单次检索：mode / rerank / topK 可调，逐条展示分数分解（keyword·vector·rrf·rerank）、
 *   命中原因、证据片段数，以及 metadata（耗时、各路命中数、缓存）
 * - 评测集：把当前查询 + 勾选的期望文档存为用例；一键跑全量评测集出 recall@K / MRR
 *
 * 面向两类用户：人（调参看效果）、Agent/开发者（改检索逻辑前后跑同一评测集自证）。
 */
import { useState } from 'react';
import { FlaskConical, Play, Save, Trash2, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { trpc } from '@/providers/trpc';

type Mode = 'keyword' | 'vector' | 'hybrid';

interface EvalCaseRow {
  id: number;
  query: string;
  expectedDocIds: string;
  note: string | null;
  createdAt: string;
}

interface EvalResultRow {
  caseId: number;
  query: string;
  expectedDocIds: number[];
  hitDocIds: number[];
  recallAtK: number;
  reciprocalRank: number;
}

function parseExpected(raw: string): number[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

export default function SearchTestbed() {
  // ── 检索控件 ──
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('hybrid');
  const [rerank, setRerank] = useState(false);
  const [topK, setTopK] = useState(10);
  const [submitted, setSubmitted] = useState('');

  const trimmed = query.trim();
  const {
    data: searchData,
    isLoading,
    error,
  } = trpc.kb.hybridSearch.useQuery(
    { query: submitted, mode, limit: topK, rerank },
    { enabled: submitted.length > 0, retry: 1 }
  );

  // ── 评测用例 ──
  const { data: casesData, refetch: refetchCases } = trpc.searchEval.listCases.useQuery();
  const cases: EvalCaseRow[] = casesData ?? [];
  const createCase = trpc.searchEval.createCase.useMutation();
  const deleteCase = trpc.searchEval.deleteCase.useMutation();
  const runEvalMutation = trpc.searchEval.runEval.useMutation();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [evalNote, setEvalNote] = useState('');
  const [evalReport, setEvalReport] = useState<{
    results: EvalResultRow[];
    metrics: { caseCount: number; meanRecallAtK: number; mrr: number };
    durationMs: number;
  } | null>(null);
  const [message, setMessage] = useState('');

  const results = searchData?.results ?? [];
  const metadata = searchData?.metadata;
  const facets = searchData?.facets;

  const docResults = results.filter((r) => r.type === 'document');

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSaveCase = async () => {
    if (!trimmed || selectedIds.length === 0) {
      setMessage('需要查询词 + 至少勾选一个期望文档');
      return;
    }
    try {
      await createCase.mutateAsync({ query: trimmed, expectedDocIds: selectedIds, note: evalNote.trim() || undefined });
      setMessage(`已保存评测用例「${trimmed}」（期望 ${selectedIds.length} 篇）`);
      setSelectedIds([]);
      setEvalNote('');
      void refetchCases();
    } catch (e) {
      setMessage(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRunEval = async () => {
    setEvalReport(null);
    try {
      const r = await runEvalMutation.mutateAsync({ mode, rerank, topK });
      setEvalReport(r);
      setMessage('');
    } catch (e) {
      setMessage(`评测失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDeleteCase = async (id: number) => {
    try {
      await deleteCase.mutateAsync({ id });
      void refetchCases();
    } catch {
      /* 列表刷新即自愈 */
    }
  };

  const fmt = (n: number | undefined) => (n === undefined ? '·' : n.toFixed(3));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <FlaskConical size={22} className="text-cyan-400" />
        <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>检索测试台</h1>
      </div>
      <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
        调参数 → 看分数分解 → 固化评测用例 → 跑评测集。改检索逻辑前后各跑一次，用 recall@K / MRR 自证好坏。
      </p>

      {/* ── 控件行 ── */}
      <div className="flex flex-wrap items-center gap-3 mb-4 p-3 rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && trimmed && setSubmitted(trimmed)}
          placeholder="查询词，如：引用可定位"
          className="flex-1 min-w-64 px-3 py-1.5 rounded text-sm outline-none border"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', borderColor: 'var(--border-subtle)' }}
        />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          className="px-2 py-1.5 rounded text-sm border"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', borderColor: 'var(--border-subtle)' }}
        >
          <option value="hybrid">hybrid（融合）</option>
          <option value="keyword">keyword（BM25）</option>
          <option value="vector">vector（语义）</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} />
          LLM 重排
        </label>
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          topK {topK}
          <input type="range" min={1} max={20} value={topK} onChange={(e) => setTopK(Number(e.target.value))} className="w-24" />
        </label>
        <button
          onClick={() => trimmed && setSubmitted(trimmed)}
          disabled={!trimmed || isLoading}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40"
        >
          <Play size={14} /> 检索
        </button>
      </div>

      {message && (
        <div className="mb-3 text-xs px-3 py-2 rounded" style={{ background: 'rgba(34,211,238,0.08)', color: 'var(--accent-cyan)' }}>
          {message}
        </div>
      )}

      {/* ── metadata 条 ── */}
      {metadata && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] mb-3 px-3 py-2 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          <span>耗时 <b className="text-cyan-400">{metadata.durationMs}ms</b></span>
          <span>keyword 路 <b>{metadata.keywordResults}</b></span>
          <span>vector 路 <b>{metadata.vectorResults}</b></span>
          <span>返回 <b>{metadata.total}</b>/{metadata.limit}</span>
          <span>模式 <b>{metadata.mode}</b></span>
          <span>缓存 <b>{metadata.cached ? '命中' : '未命中'}</b></span>
          {facets && <span>类型分布 {Object.entries(facets.types).map(([t, c]) => `${t}:${c}`).join(' · ') || '无'}</span>}
        </div>
      )}

      {/* ── 结果表 ── */}
      {error && <div className="text-xs text-rose-400 mb-3">检索失败：{error.message}</div>}
      {isLoading && <div className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>检索中…</div>}

      {results.length > 0 && (
        <div className="overflow-x-auto mb-6 rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                <th className="px-2 py-2">期望</th>
                <th className="px-2 py-2">标题</th>
                <th className="px-2 py-2">融合分</th>
                <th className="px-2 py-2">kw</th>
                <th className="px-2 py-2">vec</th>
                <th className="px-2 py-2">rrf</th>
                <th className="px-2 py-2">rerank</th>
                <th className="px-2 py-2">来源</th>
                <th className="px-2 py-2">原因 / 证据</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const docId = Number(r.id);
                const isDoc = r.type === 'document' && Number.isFinite(docId) && docId > 0;
                const sb = r.scoreBreakdown;
                return (
                  <tr key={r.id} className="border-t" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                    <td className="px-2 py-1.5">
                      {isDoc ? (
                        <input type="checkbox" checked={selectedIds.includes(docId)} onChange={() => toggleSelect(docId)} />
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 max-w-56 truncate" style={{ color: 'var(--text-primary)' }} title={r.title}>
                      {r.title}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-cyan-400">{fmt(r.score)}</td>
                    <td className="px-2 py-1.5 font-mono">{fmt(sb?.keyword)}</td>
                    <td className="px-2 py-1.5 font-mono">{fmt(sb?.vector)}</td>
                    <td className="px-2 py-1.5 font-mono">{fmt(sb?.rrf)}</td>
                    <td className="px-2 py-1.5 font-mono">{fmt(sb?.llmRerank)}</td>
                    <td className="px-2 py-1.5">{(r.sources ?? []).join('+') || '—'}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {(r.reasons ?? []).map((reason) => (
                          <span key={reason} className="px-1 py-0.5 rounded text-[10px]" style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                            {reason}
                          </span>
                        ))}
                        {(r.evidence ?? []).length > 1 && (
                          <span className="px-1 py-0.5 rounded text-[10px]" style={{ background: 'rgba(34,211,238,0.1)', color: 'var(--accent-cyan)' }}>
                            {r.evidence.length} 片段
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 评测集管理 ── */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="p-3 rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>评测用例（{cases.length}）</div>
          <div className="flex gap-2 mb-3">
            <input
              value={evalNote}
              onChange={(e) => setEvalNote(e.target.value)}
              placeholder="备注（可选）"
              className="flex-1 px-2 py-1 rounded text-xs border"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', borderColor: 'var(--border-subtle)' }}
            />
            <button
              onClick={handleSaveCase}
              disabled={createCase.isPending || !trimmed || selectedIds.length === 0}
              className="flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40"
            >
              <Save size={12} /> 存为用例{selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}
            </button>
          </div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {cases.length === 0 && (
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                还没有用例。检索后勾选「期望」命中的文档，点「存为用例」。
              </div>
            )}
            {cases.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded" style={{ background: 'var(--bg-secondary)' }}>
                <div className="flex-1 min-w-0">
                  <div className="truncate" style={{ color: 'var(--text-primary)' }}>{c.query}</div>
                  <div style={{ color: 'var(--text-muted)' }}>
                    期望 {parseExpected(c.expectedDocIds).join(', ')}{c.note ? ` · ${c.note}` : ''}
                  </div>
                </div>
                <button onClick={() => handleDeleteCase(c.id)} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }} title="删除用例">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={handleRunEval}
            disabled={runEvalMutation.isPending || cases.length === 0}
            className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40"
          >
            {runEvalMutation.isPending ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
            跑评测集（mode={mode} rerank={rerank ? 'on' : 'off'} topK={topK}）
          </button>
        </div>

        {/* ── 评测报告 ── */}
        <div className="p-3 rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>评测报告</div>
          {!evalReport && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {runEvalMutation.isPending ? '逐条真实检索中…' : '跑一次评测集后，这里显示 recall@K / MRR。'}
            </div>
          )}
          {evalReport && (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="p-2 rounded text-center" style={{ background: 'var(--bg-secondary)' }}>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>mean recall@{topK}</div>
                  <div className="text-lg font-bold text-cyan-400">{evalReport.metrics.meanRecallAtK}</div>
                </div>
                <div className="p-2 rounded text-center" style={{ background: 'var(--bg-secondary)' }}>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>MRR</div>
                  <div className="text-lg font-bold text-violet-400">{evalReport.metrics.mrr}</div>
                </div>
                <div className="p-2 rounded text-center" style={{ background: 'var(--bg-secondary)' }}>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>用例 / 耗时</div>
                  <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {evalReport.metrics.caseCount}/{evalReport.durationMs}ms
                  </div>
                </div>
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {evalReport.results.map((r) => {
                  const good = r.recallAtK >= 0.999;
                  const bad = r.recallAtK === 0;
                  return (
                    <div key={r.caseId} className="flex items-center gap-2 text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-secondary)' }}>
                      {good ? <CheckCircle2 size={13} className="text-emerald-400 shrink-0" /> : bad ? <XCircle size={13} className="text-rose-400 shrink-0" /> : <span className="shrink-0 w-[13px] text-center" style={{ color: 'var(--text-muted)' }}>◐</span>}
                      <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>{r.query}</span>
                      <span className="font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                        recall {r.recallAtK} · rr {r.reciprocalRank} · 命中 [{r.hitDocIds.join(', ')}]
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 底部提示 */}
      {results.length > 0 && (
        <p className="text-[11px] mt-4" style={{ color: 'var(--text-muted)' }}>
          共 {results.length} 条结果，其中文档 {docResults.length} 条可勾选为期望命中。分数分解：kw/vec 为各路 RRF 分量，rrf 为融合总分，rerank 为 LLM 重排分（0~10，仅开启时显示）。
        </p>
      )}
    </div>
  );
}
