import { MessageSquare, Brain, RefreshCw, Check, Cpu, AlertTriangle } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAppStore } from '@/store/useAppStore';

/**
 * 模型中心 — 天枢模型列表与切换
 * 对话模型：关键词提取 / Agent LLM 调用使用
 * 嵌入模型：知识库向量化使用（更换可能改变向量维度，需重建索引）
 */
export function ModelsPanel() {
  const addToast = useAppStore((s) => s.addToast);
  const utils = trpc.useUtils();

  const statusQuery = trpc.tianshu.status.useQuery(undefined, { retry: 1, staleTime: 30_000 });
  const listQuery = trpc.tianshu.listModels.useQuery(undefined, { retry: 1, staleTime: 30_000 });

  const setChatMutation = trpc.tianshu.setChatModel.useMutation({
    onSuccess: async (data) => {
      addToast({ type: 'success', title: `对话模型已切换为 ${data.chatModel}` });
      await utils.tianshu.status.invalidate();
    },
    onError: (e) => addToast({ type: 'error', title: '设置失败', description: e.message }),
  });

  const setEmbeddingMutation = trpc.tianshu.setEmbeddingModel.useMutation({
    onSuccess: async (data) => {
      addToast({ type: 'success', title: `嵌入模型已切换为 ${data.embeddingModel}`, description: '如向量维度变化，请重建知识库索引' });
      await utils.tianshu.status.invalidate();
    },
    onError: (e) => addToast({ type: 'error', title: '设置失败', description: e.message }),
  });

  const status = statusQuery.data;
  const models = listQuery.data?.ok ? listQuery.data.models : [];
  const listError = listQuery.data && !listQuery.data.ok ? listQuery.data.error : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold mb-1 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Cpu className="w-5 h-5" />
            模型中心
          </h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            模型来源：天枢聚合网关{status?.baseUrlHost ? `（${status.baseUrlHost}）` : ''}。选择后立即生效，无需重启。
          </p>
        </div>
        <button
          onClick={() => { void statusQuery.refetch(); void listQuery.refetch(); }}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--text-muted)', border: '1px solid var(--border-color, rgba(255,255,255,0.1))' }}
        >
          <RefreshCw className="w-3.5 h-3.5" /> 刷新
        </button>
      </div>

      {/* 当前配置 */}
      <div className="card-base p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>网关状态</div>
          <div className="text-sm font-medium" style={{ color: status?.configured ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>
            {status?.configured ? '已连接' : '未配置 TIANSHU_API_KEY'}
          </div>
        </div>
        <div>
          <div className="text-xs mb-1 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
            <MessageSquare className="w-3 h-3" /> 对话模型
          </div>
          <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{status?.chatModel ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs mb-1 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
            <Brain className="w-3 h-3" /> 嵌入模型
          </div>
          <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{status?.embeddingModel ?? '—'}</div>
        </div>
      </div>

      {/* 模型列表 */}
      <div className="card-base p-4">
        <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
          可用模型（{models.length}）
        </h4>
        {listQuery.isLoading ? (
          <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : models.length === 0 ? (
          <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
            {listError ?? '未获取到模型，请检查 TIANSHU_API_KEY 配置'}
          </div>
        ) : (
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {models.map((m) => {
              const isChat = m === status?.chatModel;
              const isEmbedding = m === status?.embeddingModel;
              return (
                <div
                  key={m}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
                  style={{
                    background: isChat || isEmbedding ? 'rgba(59,130,246,0.08)' : 'transparent',
                    border: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>{m}</div>
                    <div className="flex gap-2 mt-0.5">
                      {isChat && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>
                          当前对话模型
                        </span>
                      )}
                      {isEmbedding && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(168,85,247,0.15)', color: '#a855f7' }}>
                          当前嵌入模型
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {!isChat && (
                      <button
                        onClick={() => setChatMutation.mutate({ model: m })}
                        disabled={setChatMutation.isPending}
                        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors"
                        style={{ color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)' }}
                      >
                        <Check className="w-3 h-3" /> 设为对话
                      </button>
                    )}
                    {!isEmbedding && (
                      <button
                        onClick={() => {
                          if (!window.confirm(`将嵌入模型切换为「${m}」？\n\n注意：不同嵌入模型的向量维度可能不同，切换后已有知识库向量需要重建索引才能正常检索。`)) return;
                          setEmbeddingMutation.mutate({ model: m });
                        }}
                        disabled={setEmbeddingMutation.isPending}
                        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors"
                        style={{ color: '#a855f7', border: '1px solid rgba(168,85,247,0.3)' }}
                      >
                        <Check className="w-3 h-3" /> 设为嵌入
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="flex items-start gap-2 p-3 rounded-lg text-xs"
        style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)', color: 'var(--text-muted)' }}
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#eab308' }} />
        <div>
          切换嵌入模型可能改变向量维度，已有知识库向量将无法匹配，需要重建索引。
          对话模型切换不影响已有数据，立即生效。
        </div>
      </div>
    </div>
  );
}
