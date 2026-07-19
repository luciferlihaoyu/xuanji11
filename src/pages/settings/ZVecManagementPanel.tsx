import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import type { useVectorCollections, useVectorStats } from '@/hooks/useSettings';

interface ZVecManagementPanelProps {
  readonly stats: ReturnType<typeof useVectorStats>['data'];
  readonly collections: ReturnType<typeof useVectorCollections>['data'];
  readonly isLoading: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  ready: '就绪',
  building: '构建中',
  error: '错误',
};

function statusChipClass(status: string): string {
  if (status === 'ready') return 'chip-emerald';
  if (status === 'error') return 'chip-rose';
  return 'chip-amber';
}

export function ZVecManagementPanel({ stats, collections, isLoading }: ZVecManagementPanelProps) {
  const hasDimensionMismatch =
    stats?.dimension != null &&
    stats.zvecDimension != null &&
    stats.dimension !== stats.zvecDimension;

  return (
    <div className="card-base p-4 max-w-lg">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          ZVec 向量索引
        </h4>
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} />
        ) : stats ? (
          <span className={`chip text-[10px] py-0.5 px-2 ${stats.ok ? 'chip-emerald' : 'chip-rose'}`}>
            {stats.ok ? '运行正常' : '异常'}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载状态中...
        </div>
      ) : !stats ? (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          暂无状态数据
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <div style={{ color: 'var(--text-muted)' }}>引擎</div>
              <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{stats.engine}</div>
            </div>
            <div className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <div style={{ color: 'var(--text-muted)' }}>索引大小</div>
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{stats.size}</div>
            </div>
            <div className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <div style={{ color: 'var(--text-muted)' }}>提供商</div>
              <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }} title={stats.provider}>{stats.provider}</div>
            </div>
            <div className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <div style={{ color: 'var(--text-muted)' }}>模型</div>
              <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }} title={stats.model}>{stats.model}</div>
            </div>
            <div className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <div style={{ color: 'var(--text-muted)' }}>嵌入探测维度</div>
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{stats.dimension ?? '—'}</div>
            </div>
            <div className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <div style={{ color: 'var(--text-muted)' }}>ZVec 索引维度</div>
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{stats.zvecDimension}</div>
            </div>
            <div className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <div style={{ color: 'var(--text-muted)' }}>数据目录</div>
              <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }} title={stats.zvecDataDir}>{stats.zvecDataDir}</div>
            </div>
            <div className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
              <div style={{ color: 'var(--text-muted)' }}>集合名称</div>
              <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{stats.collectionName}</div>
            </div>
          </div>

          {stats.error && (
            <div className="p-2 rounded text-xs flex gap-2" style={{ backgroundColor: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">向量引擎警告</div>
                <div>{stats.error}</div>
              </div>
            </div>
          )}

          {hasDimensionMismatch && (
            <div className="p-2 rounded text-xs flex gap-2" style={{ backgroundColor: 'rgba(255,179,71,0.1)', color: 'var(--accent-amber)' }}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">维度不一致</div>
                <div>
                  嵌入模型输出维度（{stats.dimension}）与 ZVec 索引维度（{stats.zvecDimension}）不同。写入与搜索可能失败，请在设置中调整模型维度或重建索引。
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h5 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                向量集合
              </h5>
            </div>
            {!collections || collections.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                暂无向量集合
              </div>
            ) : (
              <div className="space-y-2">
                {collections.map((collection) => (
                  <div key={collection.id} className="p-2 rounded" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {collection.name}
                      </div>
                      <span className={`chip text-[10px] py-0.5 px-2 shrink-0 ${statusChipClass(collection.status)}`}>
                        {STATUS_LABELS[collection.status] ?? collection.status}
                      </span>
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      文档数：{collection.documentCount ?? 0} · 模型：{collection.model ?? '—'} · 维度：{collection.dimension ?? '—'} · 更新于：{collection.updatedAt ? new Date(collection.updatedAt).toLocaleString() : '—'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="p-2 rounded text-xs flex gap-2" style={{ backgroundColor: 'var(--accent-cyan-dim)', color: 'var(--text-secondary)' }}>
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: 'var(--accent-cyan)' }} />
            <div>
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                API 密钥权限
              </div>
              <div>
                MCP / API 密钥需要 zvec:read 权限才能读取统计与搜索，需要 zvec:write 权限才能执行写入。旧密钥可能需要重新授权以刷新作用域。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
