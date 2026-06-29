import { Link } from 'react-router-dom';
import { X, ExternalLink, Link2, Trash2 } from 'lucide-react';

interface NodeDetailPanelProps {
  node: any;
  connectedEdges: any[];
  allNodes: any[];
  categoryColors: Record<string, string>;
  onClose: () => void;
  onDelete?: (nodeId: string) => void;
  onConnect?: (nodeId: string) => void;
}

export default function NodeDetailPanel({ node, connectedEdges, allNodes, categoryColors, onClose, onDelete, onConnect }: NodeDetailPanelProps) {
  const connectedNodes = connectedEdges.map((edge) => {
    const otherId = edge.source === node.id ? edge.target : edge.source;
    return allNodes.find((n) => n.id === otherId);
  }).filter(Boolean);

  return (
    <div className="panel-floating p-4 w-[320px]">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className="w-4 h-4 rounded shrink-0"
            style={{ backgroundColor: categoryColors[node.category] }}
          />
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {node.name}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white/5 transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Meta info grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs mb-3">
        <div>
          <span style={{ color: 'var(--text-muted)' }}>创建</span>
          <p style={{ color: 'var(--text-secondary)' }}>{node.lastUpdate}</p>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>更新</span>
          <p style={{ color: 'var(--text-secondary)' }}>{node.lastUpdate}</p>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>类别</span>
          <p style={{ color: 'var(--text-secondary)' }}>{node.category}</p>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>重要性</span>
          <p style={{ color: 'var(--text-secondary)' }}>{node.importance}/10</p>
        </div>
      </div>

      {/* Tags */}
      {node.tags && node.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {node.tags.map((tag: string) => (
            <span key={tag} className="chip">{tag}</span>
          ))}
        </div>
      )}

      {/* Summary */}
      <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
        {node.summary}
      </p>

      {/* Connected nodes */}
      {connectedNodes.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            关联知识 ({connectedNodes.length})
          </h4>
          <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
            {connectedNodes.slice(0, 5).map((n) => (
              <div key={n.id} className="flex items-center gap-2 py-1">
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: categoryColors[n.category] }}
                />
                <span className="text-xs truncate flex-1" style={{ color: 'var(--text-secondary)' }}>
                  {n.name}
                </span>
                <div className="w-10 h-[2px] rounded-full gradient-bar opacity-60" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <Link
          to={`/kb/${node.id}`}
          className="btn-primary w-full text-xs py-2 flex items-center justify-center gap-1.5"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          查看详情
        </Link>
        <div className="flex gap-2">
          {onConnect && (
            <button
              onClick={() => onConnect(node.id)}
              className="btn-secondary flex-1 text-xs py-1.5 flex items-center justify-center gap-1"
            >
              <Link2 className="w-3.5 h-3.5" />
              连线
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => {
                if (confirm(`确定要删除节点 “${node.name}” 吗？`)) {
                  onDelete(node.id);
                }
              }}
              className="btn-danger flex-1 text-xs py-1.5 flex items-center justify-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              删除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
