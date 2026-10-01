/**
 * 3D 星云预览页（实验路由 /spike3d）：方案 A「换 WebGL 引擎」的可视化探针。
 * three.js + 3d-force-graph + UnrealBloomPass 辉光泛光 + 背景星野 + 相机缓转。
 * 数据复用 trpc.knowledge.getGraph（与 2D 图谱页同接口、同登录态）。
 * 验收方式：用户亲眼看 → 满意后再把这套渲染正式替换 KnowledgeGraphCanvas。
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { forceRadial } from 'd3-force-3d';
import ForceGraph3D from '3d-force-graph';
import { trpc } from '@/providers/trpc';

/** 与 2D 图谱同口径的霓虹六色 */
const COLORS: Record<string, string> = {
  concept: '#4cc9f0', document: '#52e5a7', topic: '#ffc94d',
  entity: '#ff6b9d', note: '#a78bfa', tag: '#22d3ee',
};
const LABELS: Record<string, string> = {
  concept: '概念', document: '文档', topic: '主题',
  entity: '实体', note: '笔记', tag: '标签',
};

/** 平滑径向渐变发光纹理（WebGL 纹理缩放无位图锯齿问题） */
const texCache = new Map<string, THREE.CanvasTexture>();
function glowTexture(color: string): THREE.CanvasTexture {
  const hit = texCache.get(color);
  if (hit) return hit;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.08, color);
  g.addColorStop(0.22, color + '88');
  g.addColorStop(1, color + '00');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  texCache.set(color, tex);
  return tex;
}

interface SpikeNode { id: number; name: string; cat: string; deg: number; x?: number; y?: number; z?: number }

export default function KnowledgeGraphSpike3D() {
  const containerRef = useRef<HTMLDivElement>(null);
  type GraphInstance = ReturnType<typeof ForceGraph3D<SpikeNode, { source: number; target: number }>>;
  const graphRef = useRef<GraphInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const graphQuery = trpc.knowledge.getGraph.useQuery();

  useEffect(() => {
    if (!containerRef.current || !graphQuery.data) return;
    const raw = graphQuery.data as { nodes: { id: number; title: string; type: string }[]; edges: { sourceId: number; targetId: number }[] };
    const nodes: SpikeNode[] = raw.nodes.map(n => ({ id: n.id, name: n.title, cat: n.type || 'concept', deg: 0 }));
    const idSet = new Set(nodes.map(n => n.id));
    const links = raw.edges
      .filter(e => idSet.has(e.sourceId) && idSet.has(e.targetId))
      .map(e => ({ source: e.sourceId, target: e.targetId }));
    const deg = new Map<number, number>();
    links.forEach(l => { deg.set(l.source as number, (deg.get(l.source as number) || 0) + 1); deg.set(l.target as number, (deg.get(l.target as number) || 0) + 1); });
    nodes.forEach(n => { n.deg = deg.get(n.id) || 0; });

    let disposed = false;
    try {
      const graph = ForceGraph3D<SpikeNode, { source: number; target: number }>()(containerRef.current);
      graphRef.current = graph;
      graph
        .backgroundColor('rgba(0,0,0,0)')
        .graphData({ nodes, links })
        .nodeThreeObject((nd) => {
          const size = 11 + Math.min(22, Math.log(1 + nd.deg) * 4.2);
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(COLORS[nd.cat] || COLORS.tag),
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          }));
          sprite.scale.set(size, size, 1);
          return sprite;
        })
        .nodeLabel((nd) => `${nd.name} ｜ ${LABELS[nd.cat] || nd.cat}`)
        .warmupTicks(90)
        .linkColor(() => 'rgba(130,170,230,0.35)')
        .linkWidth(0.6)
        .linkOpacity(0.35)
        .onNodeClick((nd) => {
          const dist = 60;
          const ratio = 1 + dist / Math.hypot(nd.x || 0, nd.y || 0, nd.z || 0);
          graph.cameraPosition(
            { x: (nd.x || 0) * ratio, y: (nd.y || 0) * ratio, z: (nd.z || 0) * ratio },
            nd as never, 1200,
          );
        });

      // ---- 布局力学（用户定调：星系式整体感）----
      // 规模自适应：节点间距随 ∛N 增长 —— 节点/边变多时图云等比长大，密度不变；
      // 径向向心力把所有星团（含不连通子图）收拢成一个星系，不散成"这里一团那里一团"。
      const N = nodes.length;
      const scale = Math.cbrt(N / 100);
      const charge = graph.d3Force('charge') as unknown as { strength: (v: number) => void } | null;
      charge?.strength(-55 * scale * scale);
      const linkF = graph.d3Force('link') as unknown as { distance: (v: number) => void } | null;
      linkF?.distance(10 * scale);
      // 径向引力：弱而持续地把一切拉向质心 → 整体凝聚；强度随规模略增以抵消更大斥力
      graph.d3Force('radial', forceRadial(0, 0, 0, 0).strength(Math.min(0.10, 0.035 * scale)) as never);
      graph.d3Force('x', null as never); // 撤掉默认的轴向居中，交给径向力（3D 各向同性）
      graph.d3Force('y', null as never);
      graph.d3Force('z', null as never);

      // 背景星野：1200 个远景星点围成球壳
      const starGeo = new THREE.BufferGeometry();
      const starPos = new Float32Array(1200 * 3);
      for (let i = 0; i < 1200; i++) {
        const r = 900 + Math.random() * 1600;
        const t = Math.random() * Math.PI * 2;
        const p = Math.acos(2 * Math.random() - 1);
        starPos[i * 3] = r * Math.sin(p) * Math.cos(t);
        starPos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
        starPos[i * 3 + 2] = r * Math.cos(p);
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      graph.scene().add(new THREE.Points(starGeo, new THREE.PointsMaterial({
        color: 0x8fb4e8, size: 2.2, transparent: true, opacity: 0.55,
      })));

      // Bloom 辉光（科技感核心）
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(containerRef.current.clientWidth, containerRef.current.clientHeight),
        1.15, 0.5, 0.15,
      );
      graph.postProcessingComposer().addPass(bloom);

      const ctl = graph.controls() as { autoRotate: boolean; autoRotateSpeed: number };
      ctl.autoRotate = true;
      ctl.autoRotateSpeed = 0.6;
      // 布局沉降后按图云包围盒手动取景（starfield 会干扰 zoomToFit 的 bbox 语义）
      setTimeout(() => {
        // 自己从节点坐标算包围盒（getGraphBbox 在此版本返回默认值，不可靠）
        const gd = graph.graphData() as { nodes: SpikeNode[]; links: unknown[] };
        const xs = gd.nodes.map(n => n.x ?? 0), ys = gd.nodes.map(n => n.y ?? 0), zs = gd.nodes.map(n => n.z ?? 0);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const dim = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs), 1);
        graph.cameraPosition({ x: cx, y: cy, z: cz + dim * 0.85 }, { x: cx, y: cy, z: cz } as never, 1200);
      }, 1200);
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    }

    return () => {
      disposed = true;
      (graphRef.current as unknown as { _destructor?: () => void })?._destructor?.();
      graphRef.current = null;
    };
  }, [graphQuery.data]);

  return (
    <div style={{ position: 'fixed', inset: 0, top: 48, background: '#04060b' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {/* HUD */}
      <div style={{ position: 'absolute', left: 18, top: 16, zIndex: 10, color: '#9fb4d8', fontSize: 12, letterSpacing: 0.4, pointerEvents: 'none' }}>
        <b style={{ color: '#e6edf7', fontSize: 15, display: 'block', marginBottom: 4, letterSpacing: 1.5 }}>
          璇玑 · 知识星云（3D 预览）
        </b>
        {graphQuery.data
          ? `${(graphQuery.data as { nodes: unknown[] }).nodes.length} 节点 · WebGL + Bloom 辉光`
          : '载入中…'}
      </div>
      <div style={{ position: 'absolute', right: 18, top: 16, zIndex: 10, color: '#9fb4d8', fontSize: 12, lineHeight: '22px', background: 'rgba(12,16,26,.55)', border: '1px solid rgba(120,160,220,.14)', borderRadius: 10, padding: '10px 14px', backdropFilter: 'blur(6px)' }}>
        {Object.keys(COLORS).map(c => (
          <div key={c}>
            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 7, background: COLORS[c], boxShadow: `0 0 8px ${COLORS[c]}` }} />
            {LABELS[c]}
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 18, bottom: 16, zIndex: 10, color: '#6c7f9f', fontSize: 11 }}>
        拖动旋转 · 滚轮缩放 · 悬停看名称 · 点击聚焦 ｜ 这是实验预览页，确认效果后替换正式图谱
      </div>
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6b9d', fontSize: 13, zIndex: 20 }}>
          渲染失败：{error}
        </div>
      )}
    </div>
  );
}
