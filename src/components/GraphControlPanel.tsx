import { RotateCcw, Focus, Download, Hexagon, Box } from 'lucide-react';

interface GraphControlPanelProps {
  viewMode: 'nodes' | 'edges';
  onViewModeChange: (mode: 'nodes' | 'edges') => void;
  spatialMode: '2d' | '3d';
  onSpatialModeChange: (mode: '2d' | '3d') => void;
  filteredCategories: Set<string>;
  onToggleCategory: (cat: string) => void;
  gravityStrength: number;
  onGravityChange: (v: number) => void;
  nodeSpacing: number;
  onSpacingChange: (v: number) => void;
  categoryLabels: Record<string, string>;
  categoryColors: Record<string, string>;
  nodeCounts: Record<string, number>;
  onFocusSelected: () => void;
  onResetView: () => void;
  onExportGraph: () => void;
}

export default function GraphControlPanel({
  viewMode, onViewModeChange, spatialMode, onSpatialModeChange, filteredCategories, onToggleCategory, gravityStrength, onGravityChange,
  nodeSpacing, onSpacingChange, categoryLabels, categoryColors, nodeCounts,
  onFocusSelected, onResetView, onExportGraph,
}: GraphControlPanelProps) {
  return (
    <div className="panel-floating p-3 w-[200px] sci-corner">
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-3 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Hexagon className="w-3.5 h-3.5" style={{ color: 'var(--accent-cyan)' }} />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--accent-cyan)' }}>图谱控制</span>
      </div>

      {/* View dimension toggle */}
      <div className="mb-3">
        <span className="text-[10px] font-medium uppercase tracking-wide block mb-2" style={{ color: 'var(--text-muted)' }}>视图模式</span>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => onSpatialModeChange('2d')}
            className={`text-[10px] py-1 rounded flex items-center justify-center gap-1 ${
              spatialMode === '2d' ? 'btn-secondary' : 'btn-ghost'
            }`}
          >
            2D 力导图
          </button>
          <button
            type="button"
            onClick={() => onSpatialModeChange('3d')}
            className={`text-[10px] py-1 rounded flex items-center justify-center gap-1 ${
              spatialMode === '3d' ? 'btn-secondary' : 'btn-ghost'
            }`}
          >
            <Box className="w-3 h-3" />
            3D 星图
          </button>
        </div>
      </div>

      {/* Category filters */}
      <div className="mb-3">
        <span className="text-[10px] font-medium uppercase tracking-wide block mb-2" style={{ color: 'var(--text-muted)' }}>节点类别</span>
        <div className="space-y-1">
          {Object.entries(categoryLabels).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer py-0.5 group">
              <div className="relative">
                <input type="checkbox" checked={filteredCategories.has(key)} onChange={() => onToggleCategory(key)} className="sr-only" />
                <span className="w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors"
                  style={{
                    borderColor: filteredCategories.has(key) ? categoryColors[key] : 'var(--border-subtle)',
                    backgroundColor: filteredCategories.has(key) ? `${categoryColors[key]}20` : 'transparent',
                  }}>
                  {filteredCategories.has(key) && (
                    <span className="text-[8px] font-bold" style={{ color: categoryColors[key] }}>✓</span>
                  )}
                </span>
              </div>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: categoryColors[key], boxShadow: `0 0 4px ${categoryColors[key]}40` }} />
              <span className="text-xs flex-1 group-hover:text-[var(--text-primary)] transition-colors" style={{ color: 'var(--text-secondary)' }}>{label}</span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>{nodeCounts[key] || 0}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Layout controls */}
      <div className="pt-3 mb-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <span className="text-[10px] font-medium uppercase tracking-wide block mb-2" style={{ color: 'var(--text-muted)' }}>布局参数</span>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-1">
            <button type="button" onClick={() => onViewModeChange('nodes')} className={`text-[10px] py-1 rounded ${viewMode === 'nodes' ? 'btn-secondary' : 'btn-ghost'}`}>节点</button>
            <button type="button" onClick={() => onViewModeChange('edges')} className={`text-[10px] py-1 rounded ${viewMode === 'edges' ? 'btn-secondary' : 'btn-ghost'}`}>边</button>
          </div>
          <div>
            <div className="flex justify-between text-[10px] mb-1 font-mono" style={{ color: 'var(--text-muted)' }}>
              <span>引力</span><span>{gravityStrength}%</span>
            </div>
            <input type="range" min={0} max={100} value={gravityStrength} onChange={(e) => onGravityChange(Number(e.target.value))}
              className="w-full h-1 rounded-full appearance-none cursor-pointer slider-cyan"
              style={{ backgroundColor: 'var(--bg-tertiary)', accentColor: 'var(--accent-cyan)' }} />
          </div>
          <div>
            <div className="flex justify-between text-[10px] mb-1 font-mono" style={{ color: 'var(--text-muted)' }}>
              <span>间距</span><span>{nodeSpacing}%</span>
            </div>
            <input type="range" min={0} max={100} value={nodeSpacing} onChange={(e) => onSpacingChange(Number(e.target.value))}
              className="w-full h-1 rounded-full appearance-none cursor-pointer"
              style={{ backgroundColor: 'var(--bg-tertiary)', accentColor: 'var(--accent-cyan)' }} />
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="pt-2 space-y-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <button type="button" onClick={onFocusSelected} className="btn-secondary w-full text-xs py-1.5 flex items-center justify-center gap-1.5"><Focus className="w-3.5 h-3.5" />聚焦选中</button>
        <button type="button" onClick={onResetView} className="btn-ghost w-full text-xs py-1.5 flex items-center justify-center gap-1.5"><RotateCcw className="w-3.5 h-3.5" />重置视图</button>
        <button type="button" onClick={onExportGraph} className="btn-ghost w-full text-xs py-1.5 flex items-center justify-center gap-1.5"><Download className="w-3.5 h-3.5" />导出图谱</button>
      </div>
    </div>
  );
}
