import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { X, ExternalLink, Link2, Trash2, Edit3, Save } from 'lucide-react';

interface NodeDetailPanelProps {
  node: any;
  connectedEdges: any[];
  allNodes: any[];
  categoryColors: Record<string, string>;
  categoryLabels?: Record<string, string>;
  onClose: () => void;
  onDelete?: (nodeId: string) => void;
  onConnect?: (nodeId: string) => void;
  onUpdate?: (nodeId: string, data: { name: string; category: string; importance: number; tags: string[]; summary: string }) => void;
  startInEdit?: boolean;
  onEditDone?: () => void;
}

export default function NodeDetailPanel({
  node,
  connectedEdges,
  allNodes,
  categoryColors,
  categoryLabels,
  onClose,
  onDelete,
  onConnect,
  onUpdate,
  startInEdit,
  onEditDone,
}: NodeDetailPanelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState<string>(node.name ?? '');
  const [editCategory, setEditCategory] = useState<string>(node.category ?? 'concept');
  const [editImportance, setEditImportance] = useState<number>(node.importance ?? 5);
  const [editTags, setEditTags] = useState<string>((node.tags ?? []).join(', '));
  const [editSummary, setEditSummary] = useState<string>(node.summary ?? '');

  // Sync edit fields when node changes or startInEdit is triggered
  useEffect(() => {
    setEditName(node.name ?? '');
    setEditCategory(node.category ?? 'concept');
    setEditImportance(node.importance ?? 5);
    setEditTags((node.tags ?? []).join(', '));
    setEditSummary(node.summary ?? '');
  }, [node.id, node.name, node.category, node.importance, node.tags, node.summary]);

  useEffect(() => {
    if (startInEdit) {
      setIsEditing(true);
    }
  }, [startInEdit]);

  const handleSave = () => {
    if (!onUpdate) return;
    const tags = editTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    onUpdate(String(node.id), {
      name: editName.trim() || node.name,
      category: editCategory,
      importance: editImportance,
      tags,
      summary: editSummary,
    });
    setIsEditing(false);
    onEditDone?.();
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    onEditDone?.();
  };

  const connectedNodes = connectedEdges
    .map((edge) => {
      const otherId = edge.source === node.id ? edge.target : edge.source;
      return allNodes.find((n) => n.id === otherId);
    })
    .filter(Boolean);

  return (
    <div className="panel-floating p-4 w-[320px]">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className="w-4 h-4 rounded shrink-0"
            style={{ backgroundColor: categoryColors[node.category] }}
          />
          {isEditing ? (
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="input-base text-sm font-bold flex-1"
              style={{ color: 'var(--text-primary)' }}
            />
          ) : (
            <h3 className="text-lg font-bold truncate" style={{ color: 'var(--text-primary)' }}>
              {node.name}
            </h3>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white/5 transition-colors shrink-0"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {isEditing ? (
        /* ===== Edit Mode ===== */
        <div className="space-y-3 mb-4">
          {/* Category */}
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wide block mb-1.5" style={{ color: 'var(--text-muted)' }}>
              类别
            </label>
            <div className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded shrink-0"
                style={{ backgroundColor: categoryColors[editCategory] }}
              />
              <select
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value)}
                className="input-base text-xs flex-1"
              >
                {Object.keys(categoryColors).map((key) => (
                  <option key={key} value={key}>
                    {categoryLabels?.[key] ?? key}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Importance */}
          <div>
            <div className="flex justify-between text-[10px] mb-1 font-mono" style={{ color: 'var(--text-muted)' }}>
              <span className="uppercase tracking-wide">重要性</span>
              <span style={{ color: 'var(--accent-cyan)' }}>{editImportance}/10</span>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              value={editImportance}
              onChange={(e) => setEditImportance(Number(e.target.value))}
              className="w-full h-1 rounded-full appearance-none cursor-pointer"
              style={{ backgroundColor: 'var(--bg-tertiary)', accentColor: 'var(--accent-cyan)' }}
            />
          </div>

          {/* Tags */}
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wide block mb-1.5" style={{ color: 'var(--text-muted)' }}>
              标签（逗号分隔）
            </label>
            <input
              type="text"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              className="input-base text-xs w-full"
              placeholder="标签1, 标签2, ..."
            />
            {editTags.trim() && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {editTags
                  .split(',')
                  .map((t: string) => t.trim())
                  .filter(Boolean)
                  .map((tag: string, i: number) => (
                    <span key={`${tag}-${i}`} className="chip">{tag}</span>
                  ))}
              </div>
            )}
          </div>

          {/* Summary */}
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wide block mb-1.5" style={{ color: 'var(--text-muted)' }}>
              摘要
            </label>
            <textarea
              value={editSummary}
              onChange={(e) => setEditSummary(e.target.value)}
              className="input-base text-xs w-full h-20 resize-none"
              placeholder="节点内容摘要"
            />
          </div>
        </div>
      ) : (
        /* ===== View Mode ===== */
        <>
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
              <p style={{ color: 'var(--text-secondary)' }}>
                {categoryLabels?.[node.category] ?? node.category}
              </p>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>重要性</span>
              <p style={{ color: 'var(--text-secondary)' }}>{node.importance ?? '-'}/10</p>
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
            {node.summary || '暂无摘要'}
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
        </>
      )}

      {/* Actions */}
      <div className="space-y-2 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        {isEditing ? (
          <>
            <button
              onClick={handleSave}
              className="btn-primary w-full text-xs py-2 flex items-center justify-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              保存
            </button>
            <button
              onClick={handleCancelEdit}
              className="btn-ghost w-full text-xs py-2 flex items-center justify-center gap-1.5"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <Link
              to={`/kb/${node.id}`}
              className="btn-primary w-full text-xs py-2 flex items-center justify-center gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              查看详情
            </Link>
            <div className="flex gap-2">
              {onUpdate && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="btn-secondary flex-1 text-xs py-1.5 flex items-center justify-center gap-1"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  编辑
                </button>
              )}
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
                    if (confirm(`确定要删除节点 "${node.name}" 吗？`)) {
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
          </>
        )}
      </div>
    </div>
  );
}
