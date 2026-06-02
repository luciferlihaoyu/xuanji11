import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import GraphControlPanel from '@/components/GraphControlPanel';
import NodeDetailPanel from '@/components/NodeDetailPanel';
import BottomInfoBar from '@/components/BottomInfoBar';
import BgImageUpload from '@/components/BgImageUpload';
import * as d3 from 'd3';

const CATEGORY_COLORS: Record<string, string> = {
  core: '#00e5ff',
  doc: '#a78bfa',
  agent: '#00d68f',
  web: '#ff8c42',
  media: '#ff6b81',
};

const CATEGORY_LABELS: Record<string, string> = {
  core: '核心知识',
  doc: '文档',
  agent: 'Agent',
  web: '网页/API',
  media: '媒体',
};

export default function KnowledgeGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { knowledgeGraph, agents, graphBgImage } = useAppStore();

  const [viewMode] = useState<'2D'>('2D');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [filteredCategories, setFilteredCategories] = useState<Set<string>>(new Set(['core', 'doc', 'agent', 'web', 'media']));
  const [gravityStrength, setGravityStrength] = useState(50);
  const [nodeSpacing, setNodeSpacing] = useState(50);
  const [isLoading, setIsLoading] = useState(true);
  const [entranceDone, setEntranceDone] = useState(false);

  // Entrance animation
  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 500);
    const timer2 = setTimeout(() => setEntranceDone(true), 2500);
    return () => { clearTimeout(timer); clearTimeout(timer2); };
  }, []);

  // Build D3 force simulation
  useEffect(() => {
    if (!svgRef.current || isLoading) return;
    const svg = d3.select(svgRef.current);
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;

    svg.selectAll('*').remove();
    const g = svg.append('g');

    // Filter nodes
    const nodes = knowledgeGraph.nodes
      .filter((n) => filteredCategories.has(n.category))
      .map((n) => ({
        ...n,
        radius: Math.max(8, Math.min(28, n.importance * 2.5 + n.connections * 0.8)),
      }));

    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = knowledgeGraph.edges
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, strength: e.strength }));

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
    filter.append('feMerge').append('feMergeNode').attr('in', 'blur');
    filter.append('feMerge').append('feMergeNode').attr('in', 'SourceGraphic');

    // Links
    g.append('g').selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'var(--border-active)')
      .attr('stroke-width', (d: any) => d.strength * 0.5)
      .attr('opacity', 0.4)
      .transition()
      .delay((_: any, i: number) => i * 30 + 500)
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
    const nodeGroups = g.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'pointer')
      .call(d3.drag<any, any>()
        .on('start', (event: any, d: any) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (event: any, d: any) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event: any, d: any) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    // Outer glow
    nodeGroups.append('circle')
      .attr('r', (d: any) => d.radius + 8)
      .attr('fill', (d: any) => CATEGORY_COLORS[d.category])
      .attr('opacity', 0.08)
      .style('filter', 'url(#node-glow)');

    // Middle ring
    nodeGroups.append('circle')
      .attr('r', (d: any) => d.radius + 3)
      .attr('fill', 'none')
      .attr('stroke', (d: any) => CATEGORY_COLORS[d.category])
      .attr('stroke-width', 0.5)
      .attr('opacity', 0.3);

    // Main node
    nodeGroups.append('circle')
      .attr('r', (d: any) => d.radius)
      .attr('fill', (d: any) => CATEGORY_COLORS[d.category])
      .attr('opacity', 0.85)
      .attr('stroke', (d: any) => CATEGORY_COLORS[d.category])
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.6);

    // Inner highlight
    nodeGroups.append('circle')
      .attr('r', (d: any) => d.radius * 0.4)
      .attr('fill', 'rgba(255,255,255,0.25)')
      .attr('opacity', 0.6);

    // Labels
    const labels = g.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text((d: any) => d.name)
      .attr('font-size', 11)
      .attr('fill', 'var(--text-secondary)')
      .attr('text-anchor', 'middle')
      .attr('dy', (d: any) => d.radius + 16)
      .style('pointer-events', 'none')
      .style('opacity', 0)
      .style('text-shadow', '0 1px 4px rgba(0,0,0,0.8)')
      .transition()
      .delay((_: any, i: number) => i * 50 + 1500)
      .duration(500)
      .style('opacity', 0.85);

    // Interactions
    nodeGroups
      .on('click', (_: any, d: any) => setSelectedNode(d.id))
      .on('mouseenter', function(_: any, d: any) {
        const idx = nodes.indexOf(d);
        g.selectAll('line').transition().duration(150)
          .attr('stroke', (l: any) => (l.source.id === d.id || l.target.id === d.id ? 'var(--accent-cyan)' : 'var(--border-subtle)'))
          .attr('stroke-width', (l: any) => (l.source.id === d.id || l.target.id === d.id ? l.strength * 1.5 : l.strength * 0.4))
          .attr('opacity', (l: any) => (l.source.id === d.id || l.target.id === d.id ? 0.9 : 0.15));
        d3.select(nodeGroups.nodes()[idx]).selectAll('circle').transition().duration(150)
          .attr('transform', 'scale(1.25)');
      })
      .on('mouseleave', function(_: any, d: any) {
        const idx = nodes.indexOf(d);
        g.selectAll('line').transition().duration(150)
          .attr('stroke', 'var(--border-active)')
          .attr('stroke-width', (l: any) => l.strength * 0.5)
          .attr('opacity', 0.4);
        d3.select(nodeGroups.nodes()[idx]).selectAll('circle').transition().duration(150)
          .attr('transform', 'scale(1)');
      });

    // Simulation
    const simulation = d3.forceSimulation(nodes as any)
      .force('link', d3.forceLink(links as any).id((d: any) => d.id).distance((d: any) => 220 - d.strength * 25))
      .force('charge', d3.forceManyBody().strength(-gravityStrength * 10))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: any) => d.radius + nodeSpacing * 0.4));

    simulation.on('tick', () => {
      g.selectAll('line')
        .attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
      nodeGroups.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
      labels.attr('x', (d: any) => d.x).attr('y', (d: any) => d.y);
      const t = Date.now() / 2000;
      flowG.selectAll('circle')
        .attr('cx', (d: any) => d.source.x + (d.target.x - d.source.x) * ((t * d.strength * 0.3) % 1))
        .attr('cy', (d: any) => d.source.y + (d.target.y - d.source.y) * ((t * d.strength * 0.3) % 1));
    });

    // Entrance
    nodeGroups.attr('transform', `translate(${width / 2},${height / 2}) scale(0)`);
    nodeGroups.transition().duration(1500).ease(d3.easeCubicOut)
      .attr('transform', (d: any) => `translate(${d.x},${d.y}) scale(1)`);

    return () => { simulation.stop(); };
  }, [isLoading, knowledgeGraph, gravityStrength, nodeSpacing, filteredCategories]);

  const toggleCategory = (cat: string) => {
    setFilteredCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) { if (next.size > 1) next.delete(cat); }
      else next.add(cat);
      return next;
    });
  };

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const selectedNodeData = selectedNode ? knowledgeGraph.nodes.find((n) => n.id === selectedNode) : null;
  const connectedEdges = selectedNode ? knowledgeGraph.edges.filter((e) => e.source === selectedNode || e.target === selectedNode) : [];

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
        {viewMode === '2D' ? '2D 力导向图' : '3D 星图'} · {knowledgeGraph.nodes.length} 节点 · {knowledgeGraph.edges.length} 连接
      </div>

      {/* Control Panel */}
      <div className={`absolute left-4 top-16 z-10 transition-all duration-500 ${entranceDone ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}>
        <GraphControlPanel
          viewMode={viewMode}
          onViewModeChange={() => {}}
          filteredCategories={filteredCategories}
          onToggleCategory={toggleCategory}
          gravityStrength={gravityStrength}
          onGravityChange={setGravityStrength}
          nodeSpacing={nodeSpacing}
          onSpacingChange={setNodeSpacing}
          categoryLabels={CATEGORY_LABELS}
          categoryColors={CATEGORY_COLORS}
          nodeCounts={Object.fromEntries(Object.keys(CATEGORY_COLORS).map((cat) => [cat, knowledgeGraph.nodes.filter((n) => n.category === cat).length]))}
        />
        {/* Background Upload */}
        <div className="mt-3 panel-floating p-3 w-[200px]">
          <BgImageUpload />
        </div>
      </div>

      {/* Detail Panel */}
      <div className={`absolute right-4 top-16 z-10 transition-all duration-500 ${selectedNode ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-full pointer-events-none'}`}>
        {selectedNodeData && (
          <NodeDetailPanel node={selectedNodeData} connectedEdges={connectedEdges} allNodes={knowledgeGraph.nodes} categoryColors={CATEGORY_COLORS} onClose={() => setSelectedNode(null)} />
        )}
      </div>

      {/* Bottom Info Bar */}
      <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 transition-all duration-500 ${entranceDone ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}>
        <BottomInfoBar nodeCount={knowledgeGraph.nodes.length} edgeCount={knowledgeGraph.edges.length} onlineAgents={onlineCount} totalAgents={agents.length} lastSync="2 分钟前" />
      </div>
    </div>
  );
}
