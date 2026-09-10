import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useKnowledgeGraph } from '@/hooks/useKnowledge';
import { useAppStore } from '@/store/useAppStore';
import GraphControlPanel from '@/components/GraphControlPanel';
import NodeDetailPanel from '@/components/NodeDetailPanel';
import BottomInfoBar from '@/components/BottomInfoBar';
import BgImageUpload from '@/components/BgImageUpload';
import KnowledgeGraphCanvas, { type KnowledgeGraphCanvasHandle } from '@/components/KnowledgeGraphCanvas';
import { Plus, Link2, X, ExternalLink, Edit3, Trash2 } from 'lucide-react';

/** Tokyo Night 配色（云霄设计稿定稿色板） */
const CATEGORY_COLORS: Record<string, string> = {
  concept: '#7aa2f7',
  document: '#9ece6a',
  topic: '#e0af68',
  entity: '#f7768e',
  note: '#bb9af7',
  tag: '#7dcfff',
};

const CATEGORY_LABELS: Record<string, string> = {
  concept: '概念',
  document: '文档',
  topic: '主题',
  entity: '实体',
  note: '笔记',
  tag: '标签',
};

interface RenderNode {
  id: string;
  name: string;
  category: string;
  posX: number;
  posY: number;
  summary: string;
  lastUpdate: string;
  tags: string[];
  importance: number;
  metadata: Record<string, unknown>;
  x: number;
  y: number;
}

interface RenderEdge {
  source: string;
  target: string;
  strength: number;
  label?: string;
}

export default function KnowledgeGraph() {
  const canvasRef = useRef<KnowledgeGraphCanvasHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { agents, graphBgImage, graphBgScale } = useAppStore();
  const {
    nodes: backendNodes,
    edges: backendEdges,
    isLoading: isGraphLoading,
    createNode,
    updateNode,
    deleteNode,
    createEdge,
    updatePositions,
  } = useKnowledgeGraph();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);

  const [edgeMode, setEdgeMode] = useState<false | 'source'>(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newNode, setNewNode] = useState({ title: '', content: '', type: 'concept' as const, importance: 5, tags: '' });
  const [filteredCategories, setFilteredCategories] = useState<Set<string>>(
    new Set(['concept', 'document', 'topic', 'entity', 'note', 'tag'])
  );
  const [gravityStrength, setGravityStrength] = useState(50);
  const [nodeSpacing, setNodeSpacing] = useState(50);
  const [viewMode, setViewMode] = useState<'nodes' | 'edges'>('nodes');
  const [isLoading, setIsLoading] = useState(true);
  const [entranceDone, setEntranceDone] = useState(false);

  // Right-click context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);

  // Edit trigger — when set, NodeDetailPanel starts in edit mode
  const [editTriggerId, setEditTriggerId] = useState<string | null>(null);

  // 后端数据 → 渲染格式（useMemo 稳定引用）
  const renderNodes = useMemo<RenderNode[]>(() => backendNodes.map((n: any) => ({
    id: String(n.id),
    name: n.title ?? '未命名',
    category: n.type ?? 'concept',
    posX: n.posX ?? 0,
    posY: n.posY ?? 0,
    summary: n.content?.slice(0, 120) ?? '',
    lastUpdate: n.updatedAt?.toString()?.slice(0, 10) ?? '',
    tags: Array.isArray(n.metadata?.tags) ? n.metadata.tags : [],
    importance: typeof n.metadata?.importance === 'number' ? n.metadata.importance : 5,
    metadata: (n.metadata as Record<string, unknown>) ?? {},
    x: (n.posX ?? 0) * 3,
    y: (n.posY ?? 0) * 3,
  })), [backendNodes]);

  const renderEdges = useMemo<RenderEdge[]>(() => backendEdges.map((e: any) => ({
    source: String(e.sourceId),
    target: String(e.targetId),
    strength: e.weight ?? 1,
    label: e.label,
  })), [backendEdges]);

  // 过滤后的画布数据
  const canvasNodes = useMemo(
    () => renderNodes
      .filter((n) => filteredCategories.has(n.category))
      .map((n) => ({ id: n.id, name: n.name, category: n.category, x: n.x, y: n.y })),
    [renderNodes, filteredCategories]
  );
  const canvasEdges = useMemo(() => {
    const ids = new Set(canvasNodes.map((n) => n.id));
    return renderEdges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, strength: e.strength }));
  }, [canvasNodes, renderEdges]);

  // 顶栏搜索事件：按名称定位节点并聚焦
  useEffect(() => {
    const handler = (event: Event) => {
      const query = (event as CustomEvent<string>).detail;
      if (!query) return;
      const q = query.toLowerCase();
      const target = canvasNodes.find((n) => n.name.toLowerCase().includes(q));
      if (!target) {
        addToastRef.current({ type: 'warning', title: '未找到匹配节点' });
        return;
      }
      setSelectedNodeId(target.id);
      canvasRef.current?.focusNode(target.id);
    };
    window.addEventListener('knowledge-graph-search', handler);
    return () => window.removeEventListener('knowledge-graph-search', handler);
  }, [canvasNodes]);

  // Entrance animation
  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 500);
    const timer2 = setTimeout(() => setEntranceDone(true), 2500);
    return () => { clearTimeout(timer); clearTimeout(timer2); };
  }, []);

  // 数据加载完成后移除加载罩（canvas 内部会自行 fit）
  useEffect(() => {
    if (!isGraphLoading) setIsLoading(false);
  }, [isGraphLoading]);

  // ---- 画布回调 ----

  const handleCanvasNodeClick = useCallback((id: string | null) => {
    if (edgeMode === 'source') {
      if (id === null) return; // 连线模式点空白：不变更
      if (selectedNodeIdRef.current === id) {
        setEdgeMode(false);
        setSelectedNodeId(null);
        return;
      }
      if (selectedNodeIdRef.current) {
        createEdgeRef.current({ sourceId: Number(selectedNodeIdRef.current), targetId: Number(id), type: 'related' })
          .then(() => {
            setEdgeMode(false);
            addToastRef.current({ type: 'success', title: '连线已创建' });
          })
          .catch((err: unknown) => {
            setEdgeMode(false);
            addToastRef.current({ type: 'error', title: '创建连线失败', description: err instanceof Error ? err.message : String(err) });
          });
        return;
      }
    }
    setSelectedNodeId(id);
  }, [edgeMode]);

  const handleCanvasContextMenu = useCallback((nodeId: string, x: number, y: number) => {
    setContextMenu({ x, y, nodeId });
  }, []);

  const handleSavePositions = useCallback((positions: Array<{ id: string; x: number; y: number }>) => {
    updatePositionsRef.current(
      positions.map((p) => ({ id: Number(p.id), posX: p.x / 3, posY: p.y / 3 }))
    ).catch((err: unknown) => {
      console.error('保存位置失败:', err);
    });
  }, []);

  const handleFocusSelected = useCallback(() => {
    if (!selectedNodeId) {
      addToastRef.current({ type: 'info', title: '请先选择一个节点' });
      return;
    }
    const ok = canvasRef.current?.focusNode(selectedNodeId);
    if (!ok) {
      addToastRef.current({ type: 'warning', title: '选中节点当前不可见' });
    }
  }, [selectedNodeId]);

  const handleResetView = useCallback(() => {
    canvasRef.current?.resetView();
  }, []);

  const handleExportGraph = useCallback(() => {
    canvasRef.current?.exportPng();
  }, []);

  const toggleCategory = useCallback((cat: string) => {
    setFilteredCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) { if (next.size > 1) next.delete(cat); }
      else next.add(cat);
      return next;
    });
  }, []);

  const { addToast } = useAppStore();
  const addToastRef = useRef(addToast);
  useEffect(() => { addToastRef.current = addToast; }, [addToast]);

  const createEdgeRef = useRef(createEdge);
  useEffect(() => { createEdgeRef.current = createEdge; }, [createEdge]);

  const updatePositionsRef = useRef(updatePositions);
  useEffect(() => { updatePositionsRef.current = updatePositions; }, [updatePositions]);

  const handleAddNode = async () => {
    if (!newNode.title.trim()) return;
    try {
      await createNode({
        title: newNode.title,
        content: newNode.content,
        type: newNode.type,
        posX: Math.random() * 200 - 100,
        posY: Math.random() * 200 - 100,
        metadata: {
          tags: newNode.tags.split(',').map((t) => t.trim()).filter(Boolean),
          importance: newNode.importance,
        },
      });
      setNewNode({ title: '', content: '', type: 'concept', importance: 5, tags: '' });
      setShowAddModal(false);
      addToast({ type: 'success', title: '节点已创建' });
    } catch (err) {
      addToast({ type: 'error', title: '创建节点失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleDeleteNode = async (nodeId: string) => {
    try {
      await deleteNode({ id: Number(nodeId) });
      setSelectedNodeId(null);
      addToast({ type: 'success', title: '节点已删除' });
    } catch (err) {
      addToast({ type: 'error', title: '删除节点失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleConnectStart = (nodeId: string) => {
    setEdgeMode('source');
    setSelectedNodeId(nodeId);
  };

  const handleUpdateNode = async (nodeId: string, data: { name: string; category: string; importance: number; tags: string[]; summary: string }) => {
    try {
      const existing = renderNodes.find((n) => n.id === nodeId);
      const existingMetadata = (existing?.metadata as Record<string, unknown>) ?? {};
      await updateNode({
        id: Number(nodeId),
        title: data.name,
        type: data.category as 'concept' | 'document' | 'topic' | 'entity' | 'note' | 'tag',
        content: data.summary,
        metadata: { ...existingMetadata, tags: data.tags, importance: data.importance },
      });
      addToast({ type: 'success', title: '节点已更新' });
    } catch (err) {
      addToast({ type: 'error', title: '更新节点失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  // Context menu actions
  const handleContextMenuView = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setContextMenu(null);
  };

  const handleContextMenuEdit = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setEditTriggerId(nodeId);
    setContextMenu(null);
  };

  const handleContextMenuConnect = (nodeId: string) => {
    setEdgeMode('source');
    setSelectedNodeId(nodeId);
    setContextMenu(null);
  };

  const handleContextMenuDelete = async (nodeId: string) => {
    setContextMenu(null);
    const node = renderNodes.find((n) => n.id === nodeId);
    if (node && !confirm(`确定要删除节点 "${node.name}" 吗？`)) return;
    await handleDeleteNode(nodeId);
  };

  // Close context menu on any click or escape
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    const timer = setTimeout(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
      window.addEventListener('keydown', closeOnEsc);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', closeOnEsc);
    };
  }, [contextMenu]);

  const onlineCount = agents.filter((a) => a.status === 'active').length;

  const selectedNodeData = selectedNodeId ? renderNodes.find((n) => n.id === selectedNodeId) : null;
  const connectedEdges = selectedNodeId ? renderEdges.filter((e) => e.source === selectedNodeId || e.target === selectedNodeId) : [];

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: 'calc(100vh - 48px)', overflow: 'hidden' }}>
      {/* Background */}
      <div
        className="absolute inset-0 bg-grid"
        style={{
          backgroundImage: graphBgImage ? `url(${graphBgImage})` : undefined,
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          // 100% ≈ 宽度铺满；用户可调 20%~200%
          backgroundSize: graphBgImage ? `${graphBgScale}% auto` : undefined,
          backgroundColor: '#f2f4f8',
        }}
      >
        {!graphBgImage && (
          <div className="absolute inset-0" style={{
            background: 'radial-gradient(ellipse at 50% 42%, #ffffff 0%, #f2f4f8 62%, #e4e9f0 100%)',
          }} />
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-10" style={{ backgroundColor: '#f2f4f8' }}>
          <div className="flex flex-col items-center gap-4">
            <div className="relative w-10 h-10">
              <div className="animate-rotate w-10 h-10 border-2 border-t-transparent rounded-full" style={{ borderColor: '#7aa2f7', borderTopColor: 'transparent' }} />
              <div className="absolute inset-1 rounded-full" style={{ border: '1px solid #7aa2f7', opacity: 0.3 }} />
            </div>
            <span className="text-sm tracking-wider" style={{ color: '#8a9099' }}>
              正在加载知识图谱<span className="animate-pulse">...</span>
            </span>
          </div>
        </div>
      )}

      {/* Obsidian 风格 Canvas */}
      {!isGraphLoading && (
        <KnowledgeGraphCanvas
          ref={canvasRef}
          nodes={canvasNodes}
          edges={canvasEdges}
          selectedNodeId={selectedNodeId}
          edgeMode={edgeMode === 'source'}
          viewMode={viewMode}
          gravityStrength={gravityStrength}
          nodeSpacing={nodeSpacing}
          categoryColors={CATEGORY_COLORS}
          onNodeClick={handleCanvasNodeClick}
          onNodeContextMenu={handleCanvasContextMenu}
          onSavePositions={handleSavePositions}
        />
      )}

      {/* Top badge */}
      <div className={`absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full text-xs font-medium border z-10 transition-all duration-500 ${entranceDone ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'}`}
        style={{ backgroundColor: 'rgba(255,255,255,.72)', backdropFilter: 'blur(12px)', borderColor: 'rgba(30,40,60,0.10)', color: '#5a6472' }}>
        知识图谱 · {renderNodes.length} 节点 · {renderEdges.length} 连接
      </div>

      {/* Control Panel */}
      <div className={`absolute left-4 top-16 z-10 transition-all duration-500 ${entranceDone ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}>
        <div className="panel-floating p-2 mb-3 w-[200px]">
          <div className="flex gap-2">
            <button
              onClick={() => setShowAddModal(true)}
              className="btn-primary flex-1 text-xs py-1.5 flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              新建节点
            </button>
            <button
              onClick={() => {
                if (edgeMode) {
                  setEdgeMode(false);
                  setSelectedNodeId(null);
                } else if (selectedNodeId) {
                  setEdgeMode('source');
                } else {
                  addToast({ type: 'info', title: '请先选择一个节点' });
                }
              }}
              className={`flex-1 text-xs py-1.5 flex items-center justify-center gap-1 ${edgeMode ? 'btn-danger' : 'btn-secondary'}`}
            >
              {edgeMode ? <X className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
              {edgeMode ? '取消连线' : '连线'}
            </button>
          </div>
          {edgeMode && (
            <p className="text-[10px] mt-2" style={{ color: '#7aa2f7' }}>
              点击目标节点完成连线
            </p>
          )}
        </div>
        <GraphControlPanel
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          filteredCategories={filteredCategories}
          onToggleCategory={toggleCategory}
          gravityStrength={gravityStrength}
          onGravityChange={setGravityStrength}
          nodeSpacing={nodeSpacing}
          onSpacingChange={setNodeSpacing}
          categoryLabels={CATEGORY_LABELS}
          categoryColors={CATEGORY_COLORS}
          nodeCounts={Object.fromEntries(Object.keys(CATEGORY_COLORS).map((cat) => [cat, renderNodes.filter((n) => n.category === cat).length]))}
          onFocusSelected={handleFocusSelected}
          onResetView={handleResetView}
          onExportGraph={handleExportGraph}
        />
        {/* Background Upload */}
        <div className="mt-3 panel-floating p-3 w-[200px]">
          <BgImageUpload />
        </div>
      </div>

      {/* Detail Panel */}
      <div className={`absolute right-4 top-16 z-10 transition-all duration-500 ${selectedNodeData ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-full pointer-events-none'}`}>
        {selectedNodeData && (
          <NodeDetailPanel
            node={selectedNodeData}
            connectedEdges={connectedEdges}
            allNodes={renderNodes}
            categoryColors={CATEGORY_COLORS}
            onClose={() => setSelectedNodeId(null)}
            onDelete={handleDeleteNode}
            onConnect={handleConnectStart}
            onUpdate={handleUpdateNode}
            startInEdit={editTriggerId === selectedNodeData.id}
            onEditDone={() => setEditTriggerId(null)}
            categoryLabels={CATEGORY_LABELS}
          />
        )}
      </div>

      {/* Bottom Info Bar */}
      <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 transition-all duration-500 ${entranceDone ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}>
        <BottomInfoBar nodeCount={renderNodes.length} edgeCount={renderEdges.length} onlineAgents={onlineCount} totalAgents={agents.length} lastSync="后端实时" />
      </div>

      {/* Create Node Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="rounded-lg border p-6 w-[420px]" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>新建知识节点</h3>
              <button onClick={() => setShowAddModal(false)} className="p-1 rounded hover:bg-white/5">
                <X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>标题 *</label>
                <input
                  type="text"
                  value={newNode.title}
                  onChange={(e) => setNewNode((p) => ({ ...p, title: e.target.value }))}
                  className="input-base text-xs w-full"
                  placeholder="节点标题"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>内容</label>
                <textarea
                  value={newNode.content}
                  onChange={(e) => setNewNode((p) => ({ ...p, content: e.target.value }))}
                  className="input-base text-xs w-full h-24 resize-none"
                  placeholder="节点内容摘要"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>类型</label>
                <select
                  value={newNode.type}
                  onChange={(e) => setNewNode((p) => ({ ...p, type: e.target.value as typeof p.type }))}
                  className="input-base text-xs w-full"
                >
                  {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="flex justify-between text-xs font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                  <span>重要性</span>
                  <span style={{ color: '#7aa2f7' }}>{newNode.importance}/10</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={newNode.importance}
                  onChange={(e) => setNewNode((p) => ({ ...p, importance: Number(e.target.value) }))}
                  className="w-full h-1 rounded-full appearance-none cursor-pointer"
                  style={{ backgroundColor: 'var(--bg-tertiary)', accentColor: '#7aa2f7' }}
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>标签（逗号分隔）</label>
                <input
                  type="text"
                  value={newNode.tags}
                  onChange={(e) => setNewNode((p) => ({ ...p, tags: e.target.value }))}
                  className="input-base text-xs w-full"
                  placeholder="标签1, 标签2, ..."
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => setShowAddModal(false)} className="btn-ghost text-xs py-2 px-4">取消</button>
              <button onClick={handleAddNode} disabled={!newNode.title.trim()} className="btn-primary text-xs py-2 px-4">创建</button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          className="absolute z-50 panel-floating py-1 min-w-[140px]"
          style={{
            left: Math.min(contextMenu.x, (containerRef.current?.clientWidth ?? 0) - 150),
            top: Math.min(contextMenu.y, (containerRef.current?.clientHeight ?? 0) - 160),
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <button
            onClick={() => handleContextMenuView(contextMenu.nodeId)}
            className="w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <ExternalLink className="w-3.5 h-3.5" style={{ color: '#7aa2f7' }} />
            查看详情
          </button>
          <button
            onClick={() => handleContextMenuEdit(contextMenu.nodeId)}
            className="w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Edit3 className="w-3.5 h-3.5" style={{ color: '#7aa2f7' }} />
            编辑节点
          </button>
          <button
            onClick={() => handleContextMenuConnect(contextMenu.nodeId)}
            className="w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Link2 className="w-3.5 h-3.5" style={{ color: '#7aa2f7' }} />
            连线
          </button>
          <div style={{ borderTop: '1px solid var(--border-subtle)' }} className="my-1" />
          <button
            onClick={() => handleContextMenuDelete(contextMenu.nodeId)}
            className="w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-white/5 transition-colors"
            style={{ color: 'var(--accent-rose)' }}
          >
            <Trash2 className="w-3.5 h-3.5" />
            删除节点
          </button>
          <button
            onClick={() => {
              setContextMenu(null);
              addToast({ type: 'info', title: '节点禁用功能开发中' });
            }}
            className="w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-3.5 h-3.5" />
            禁用节点
          </button>
        </div>
      )}
    </div>
  );
}
