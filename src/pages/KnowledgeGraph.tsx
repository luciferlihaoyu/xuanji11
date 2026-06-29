import { useState, useEffect, useRef, useCallback } from 'react';
import { useKnowledgeGraph } from '@/hooks/useKnowledge';
import { useAppStore } from '@/store/useAppStore';
import GraphControlPanel from '@/components/GraphControlPanel';
import NodeDetailPanel from '@/components/NodeDetailPanel';
import BottomInfoBar from '@/components/BottomInfoBar';
import BgImageUpload from '@/components/BgImageUpload';
import * as d3 from 'd3';
import { Plus, Link2, X } from 'lucide-react';

const CATEGORY_COLORS: Record<string, string> = {
  concept: '#00e5ff',
  document: '#a78bfa',
  topic: '#00d68f',
  entity: '#ff8c42',
  note: '#ff6b81',
  tag: '#f0f0f0',
};

const CATEGORY_LABELS: Record<string, string> = {
  concept: '概念',
  document: '文档',
  topic: '主题',
  entity: '实体',
  note: '笔记',
  tag: '标签',
};

/**
 * 后端 GraphNode → 前端渲染数据映射
 */
interface RenderNode {
  id: string;
  name: string;
  category: string;
  posX: number;
  posY: number;
  radius: number;
  summary: string;
  lastUpdate: string;
  tags: string[];
  // D3 simulation internals
  x: number;
  y: number;
  fx: number | null;
  fy: number | null;
}

interface RenderEdge {
  source: string;
  target: string;
  strength: number;
  label?: string;
}

export default function KnowledgeGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<d3.Simulation<RenderNode, RenderEdge> | null>(null);
  const { agents, graphBgImage } = useAppStore();
  const {
    nodes: backendNodes,
    edges: backendEdges,
    isLoading: isGraphLoading,
    createNode,
    deleteNode,
    createEdge,
    updatePositions,
  } = useKnowledgeGraph();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);

  const [edgeMode, setEdgeMode] = useState<false | 'source'>(false);
  const edgeModeRef = useRef(edgeMode);
  useEffect(() => { edgeModeRef.current = edgeMode; }, [edgeMode]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newNode, setNewNode] = useState({ title: '', content: '', type: 'concept' as const });
  const [filteredCategories, setFilteredCategories] = useState<Set<string>>(
    new Set(['concept', 'document', 'topic', 'entity', 'note', 'tag'])
  );
  const [gravityStrength, setGravityStrength] = useState(50);
  const [nodeSpacing, setNodeSpacing] = useState(50);
  const [isLoading, setIsLoading] = useState(true);
  const [entranceDone, setEntranceDone] = useState(false);

  // 将后端数据转为前端渲染格式
  const renderNodes: RenderNode[] = backendNodes.map((n: any) => ({
    id: String(n.id),
    name: n.title ?? '未命名',
    category: n.type ?? 'concept',
    posX: (n.posX ?? 0) * 3,
    posY: (n.posY ?? 0) * 3,
    radius: 16,
    summary: n.content?.slice(0, 120) ?? '',
    lastUpdate: n.updatedAt?.toString()?.slice(0, 10) ?? '',
    tags: Array.isArray(n.metadata?.tags) ? n.metadata.tags : [],
    x: (n.posX ?? 0) * 3,
    y: (n.posY ?? 0) * 3,
    fx: null,
    fy: null,
  }));

  const renderEdges: RenderEdge[] = backendEdges.map((e: any) => ({
    source: String(e.sourceId),
    target: String(e.targetId),
    strength: e.weight ?? 1,
    label: e.label,
  }));

  // Entrance animation
  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 500);
    const timer2 = setTimeout(() => setEntranceDone(true), 2500);
    return () => { clearTimeout(timer); clearTimeout(timer2); };
  }, []);

  // Build D3 force simulation — driven by backend data
  useEffect(() => {
    if (!svgRef.current || isLoading || isGraphLoading) return;

    const svg = d3.select(svgRef.current);
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Stop previous simulation
    if (simulationRef.current) {
      simulationRef.current.stop();
      simulationRef.current = null;
    }

    svg.selectAll('*').remove();

    const g = svg.append('g');

    // Filter nodes
    const nodes: RenderNode[] = renderNodes
      .filter((n) => filteredCategories.has(n.category))
      .map((n) => ({
        ...n,
        radius: Math.max(8, Math.min(28, 8 + n.tags.length * 3)),
      }));

    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = renderEdges
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e) => ({ ...e }));

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 2])
      .on('zoom', (event) => { g.attr('transform', event.transform.toString()); });
    svg.call(zoom);

    // Arrow marker
    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 24).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L10,0L0,4 L3,0')
      .attr('fill', 'var(--accent-cyan)')
      .attr('opacity', 0.4);

    // Glow filter
    const filter = defs.append('filter').attr('id', 'node-glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    filter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '6').attr('result', 'blur');
    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'blur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Links
    const linkGroup = g.append('g');
    linkGroup.selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'var(--border-active)')
      .attr('stroke-width', (d: RenderEdge) => d.strength * 0.5 + 1)
      .attr('opacity', 0.4)
      .transition()
      .delay((_: unknown, i: number) => i * 30 + 500)
      .duration(800)
      .attr('opacity', 0.6);

    // Flow dots
    const flowG = g.append('g');
    flowG.selectAll('circle')
      .data(links)
      .join('circle')
      .attr('r', 2)
      .attr('fill', 'var(--accent-cyan)')
      .style('opacity', 0.5);

    // Node groups
    // Drag behavior (must be defined before .call())
    const dragHandler: any = d3.drag<SVGGElement, RenderNode>()
      .on('start', (event: any, d: any) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event: any, d: any) => {
        d.fx = event.x; d.fy = event.y;
      })
      .on('end', (event: any, d: any) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
        updatePositionsRef.current(nodes.map((n: RenderNode) => ({ id: Number(n.id), posX: n.x / 3, posY: n.y / 3 }))).catch((err: unknown) => {
          console.error('保存位置失败:', err);
        });
      });

    const nodeGroups = g.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'pointer')
      .call(dragHandler);

    // Outer glow
    nodeGroups.append('circle')
      .attr('r', (d) => d.radius + 8)
      .attr('fill', (d) => CATEGORY_COLORS[d.category] ?? 'var(--accent-cyan)')
      .attr('opacity', 0.08)
      .style('filter', 'url(#node-glow)');

    // Middle ring
    nodeGroups.append('circle')
      .attr('r', (d) => d.radius + 3)
      .attr('fill', 'none')
      .attr('stroke', (d) => CATEGORY_COLORS[d.category] ?? 'var(--accent-cyan)')
      .attr('stroke-width', 0.5)
      .attr('opacity', 0.3);

    // Main node
    nodeGroups.append('circle')
      .attr('r', (d) => d.radius)
      .attr('fill', (d) => CATEGORY_COLORS[d.category] ?? 'var(--accent-cyan)')
      .attr('opacity', 0.85)
      .attr('stroke', (d) => CATEGORY_COLORS[d.category] ?? 'var(--accent-cyan)')
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.6);

    // Inner highlight
    nodeGroups.append('circle')
      .attr('r', (d) => d.radius * 0.4)
      .attr('fill', 'rgba(255,255,255,0.25)')
      .attr('opacity', 0.6);

    // Labels
    const labels = g.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text((d) => d.name)
      .attr('font-size', 11)
      .attr('fill', 'var(--text-secondary)')
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => d.radius + 16)
      .style('pointer-events', 'none')
      .style('opacity', 0)
      .style('text-shadow', '0 1px 4px rgba(0,0,0,0.8)')
      .transition()
      .delay((_: unknown, i: number) => i * 50 + 1500)
      .duration(500)
      .style('opacity', 0.85);

    // Interactions
    nodeGroups
      .on('click', (_event: unknown, d: RenderNode) => {
        if (edgeModeRef.current === 'source') {
          if (selectedNodeIdRef.current === d.id) {
            setEdgeMode(false);
            setSelectedNodeId(null);
            return;
          }
          if (selectedNodeIdRef.current) {
            createEdgeRef.current({ sourceId: Number(selectedNodeIdRef.current), targetId: Number(d.id), type: 'related' })
              .then(() => {
                setEdgeMode(false);
                setSelectedNodeId(null);
                addToastRef.current({ type: 'success', title: '连线已创建' });
              })
              .catch((err: unknown) => {
                setEdgeMode(false);
                addToastRef.current({ type: 'error', title: '创建连线失败', description: err instanceof Error ? err.message : String(err) });
              });
            return;
          }
        }
        setSelectedNodeId(d.id);
      })
      .on('mouseenter', function(_event: unknown, d: RenderNode) {
        const idx = nodes.indexOf(d);
        linkGroup.selectAll('line').transition().duration(150)
          .attr('stroke', (l: any) => (l.source.id === d.id || l.target.id === d.id ? 'var(--accent-cyan)' : 'var(--border-subtle)'))
          .attr('stroke-width', (l: any) => (l.source.id === d.id || l.target.id === d.id ? l.strength * 1.5 : l.strength * 0.4))
          .attr('opacity', (l: any) => (l.source.id === d.id || l.target.id === d.id ? 0.9 : 0.15));
        d3.select(nodeGroups.nodes()[idx] as SVGGElement).selectAll('circle').transition().duration(150)
          .attr('transform', 'scale(1.25)');
      })
      .on('mouseleave', function(_event: unknown, d: RenderNode) {
        const idx = nodes.indexOf(d);
        linkGroup.selectAll('line').transition().duration(150)
          .attr('stroke', 'var(--border-active)')
          .attr('stroke-width', (l: any) => l.strength * 0.5)
          .attr('opacity', 0.4);
        d3.select(nodeGroups.nodes()[idx] as SVGGElement).selectAll('circle').transition().duration(150)
          .attr('transform', 'scale(1)');
      });

    // Simulation
    const simulation = d3.forceSimulation<RenderNode>(nodes)
      .force('link', d3.forceLink<RenderNode, RenderEdge>(links).id((d) => d.id).distance((d) => 220 - d.strength * 25))
      .force('charge', d3.forceManyBody().strength(-gravityStrength * 10))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<RenderNode>().radius((d) => d.radius + nodeSpacing * 0.4));

    simulationRef.current = simulation;

    simulation.on('tick', () => {
      linkGroup.selectAll('line')
        .attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
      nodeGroups.attr('transform', (d) => `translate(${d.x},${d.y})`);
      labels.attr('x', (d) => d.x).attr('y', (d) => d.y);
      const t = Date.now() / 2000;
      flowG.selectAll('circle')
        .attr('cx', (d: any) => d.source.x + (d.target.x - d.source.x) * ((t * d.strength * 0.3) % 1))
        .attr('cy', (d: any) => d.source.y + (d.target.y - d.source.y) * ((t * d.strength * 0.3) % 1));
    });

    // Entrance animation
    nodeGroups.attr('transform', `translate(${width / 2},${height / 2}) scale(0)`);
    nodeGroups.transition().duration(1500).ease(d3.easeCubicOut)
      .attr('transform', (d) => `translate(${d.x},${d.y}) scale(1)`);

    // Cleanup: stop simulation, clear SVG, remove zoom listeners
    return () => {
      simulation.stop();
      simulationRef.current = null;
      svg.on('.zoom', null); // remove zoom event listeners
      svg.selectAll('*').remove();
    };
  }, [isLoading, isGraphLoading, renderNodes.length, renderEdges.length, gravityStrength, nodeSpacing, filteredCategories]);

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
      });
      setNewNode({ title: '', content: '', type: 'concept' });
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

  const onlineCount = agents.filter((a) => a.status === 'online').length;

  // Find selected node from renderNodes
  const selectedNodeData = selectedNodeId ? renderNodes.find((n) => n.id === selectedNodeId) : null;
  const connectedEdges = selectedNodeId ? renderEdges.filter((e) => e.source === selectedNodeId || e.target === selectedNodeId) : [];

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: 'calc(100vh - 48px)', overflow: 'hidden' }}>
      {/* Background */}
      <div
        className="absolute inset-0 bg-grid"
        style={{
          background: graphBgImage
            ? `url(${graphBgImage}) center/cover no-repeat`
            : undefined,
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        {!graphBgImage && (
          <div className="absolute inset-0" style={{ background: 'var(--nebula-gradient)' }} />
        )}
        {/* Scanlines overlay */}
        <div className="absolute inset-0 pointer-events-none" style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,229,255,0.015) 2px, rgba(0,229,255,0.015) 4px)',
        }} />
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-10" style={{ backgroundColor: 'var(--bg-primary)' }}>
          <div className="flex flex-col items-center gap-4">
            <div className="relative w-10 h-10">
              <div className="animate-rotate w-10 h-10 border-2 border-t-transparent rounded-full" style={{ borderColor: 'var(--accent-cyan)', borderTopColor: 'transparent' }} />
              <div className="absolute inset-1 rounded-full" style={{ border: '1px solid var(--accent-cyan)', opacity: 0.3 }} />
            </div>
            <span className="text-sm tracking-wider" style={{ color: 'var(--text-secondary)' }}>
              正在加载知识星图<span className="animate-pulse">...</span>
            </span>
          </div>
        </div>
      )}

      {/* SVG */}
      <svg ref={svgRef} className="absolute inset-0 w-full h-full" style={{ zIndex: 1 }} />

      {/* Top badge */}
      <div className={`absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full text-xs font-medium border z-10 transition-all duration-500 ${entranceDone ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'}`}
        style={{ backgroundColor: 'var(--bg-glass)', backdropFilter: 'blur(12px)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
        2D 力导向图 · {renderNodes.length} 节点 · {renderEdges.length} 连接
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
              添加节点
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
            <p className="text-[10px] mt-2" style={{ color: 'var(--accent-cyan)' }}>
              点击目标节点完成连线
            </p>
          )}
        </div>
        <GraphControlPanel
          viewMode="2D"
          onViewModeChange={() => {}}
          filteredCategories={filteredCategories}
          onToggleCategory={toggleCategory}
          gravityStrength={gravityStrength}
          onGravityChange={setGravityStrength}
          nodeSpacing={nodeSpacing}
          onSpacingChange={setNodeSpacing}
          categoryLabels={CATEGORY_LABELS}
          categoryColors={CATEGORY_COLORS}
          nodeCounts={Object.fromEntries(Object.keys(CATEGORY_COLORS).map((cat) => [cat, renderNodes.filter((n) => n.category === cat).length]))}
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
          />
        )}
      </div>

      {/* Bottom Info Bar */}
      <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 transition-all duration-500 ${entranceDone ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}>
        <BottomInfoBar nodeCount={renderNodes.length} edgeCount={renderEdges.length} onlineAgents={onlineCount} totalAgents={agents.length} lastSync="后端实时" />
      </div>

      {/* Add Node Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="rounded-lg border p-6 w-[420px]" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>添加知识节点</h3>
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
            </div>
            <div className="flex justify-end gap-2 mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => setShowAddModal(false)} className="btn-ghost text-xs py-2 px-4">取消</button>
              <button onClick={handleAddNode} disabled={!newNode.title.trim()} className="btn-primary text-xs py-2 px-4">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
