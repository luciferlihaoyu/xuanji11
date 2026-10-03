/**
 * 3D 星云预览页（实验路由 /spike3d）——纯净星云版。
 *
 * 设计定调（用户 2026-10-02）：去掉一切八卦元素，回归星云本体。
 * 保留的画质沉淀：
 * - 分层径向力 rᵢ=R·∛(rank/N) 构造性体积填球（斥力+边界只能得空心壳）；
 * - 规模自适应（scale=∛(N/100)），节点增多球体均匀长大、密度恒定；
 * - Bloom 阈值 0.75（白热核发光、彩色节点不糊）+ setPixelRatio(min(dpr,2)) HiDPI 锐度；
 * - 活体感：核心边递质粒子流 + 节点黄金角错相脉冲呼吸 + FogExp2 深度雾 + 分级节点；
 * - 相机 20° 俯角取景（按图云包围盒手动计算，getGraphBbox 此版本返回默认值不可靠）。
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import ForceGraph3D from '3d-force-graph';
import { trpc } from '@/providers/trpc';
import { useAppStore } from '@/store/useAppStore';

/** 与 2D 图谱同口径的霓虹六色 */
const COLORS: Record<string, string> = {
  concept: '#4cc9f0', document: '#52e5a7', topic: '#ffc94d',
  entity: '#ff6b9d', note: '#a78bfa', tag: '#22d3ee',
};
const LABELS: Record<string, string> = {
  concept: '概念', document: '文档', topic: '主题',
  entity: '实体', note: '笔记', tag: '标签',
};

/** 发光纹理按主题分流：深色白热小核+紧晕；浅色实心色核（白核在白底隐形=清晰度全丢） */
const texCache = new Map<string, THREE.CanvasTexture>();
function glowTexture(color: string, isDark: boolean): THREE.CanvasTexture {
  const key = color + (isDark ? '|d' : '|l');
  const hit = texCache.get(key);
  if (hit) return hit;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  if (isDark) {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.06, color);
    g.addColorStop(0.16, color + '55');
    g.addColorStop(1, color + '00');
  } else {
    g.addColorStop(0, color);
    g.addColorStop(0.30, color);
    g.addColorStop(0.46, color + 'aa');
    g.addColorStop(0.72, color + '22');
    g.addColorStop(1, color + '00');
  }
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  texCache.set(key, tex);
  return tex;
}

/** 分层径向力（构造性充盈）：每节点目标半径 rᵢ = R·∛(rank/N)，恒力拉向自己那层（不乘 alpha）。 */
interface ForceNode { x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number }
function makeLayeredForce(R: number, onTick?: () => void) {
  let targets: Map<ForceNode, number> = new Map();
  const force = () => {
    for (const [n, r] of targets) {
      const d = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      if (d < 1e-6) continue;
      const k = ((d - r) / d) * 0.45;
      n.vx = (n.vx ?? 0) - (n.x ?? 0) * k;
      n.vy = (n.vy ?? 0) - (n.y ?? 0) * k;
      n.vz = (n.vz ?? 0) - (n.z ?? 0) * k;
    }
    onTick?.();
  };
  (force as { initialize?: (nodes: ForceNode[]) => void }).initialize = (nodes) => {
    const sorted = [...nodes].sort((a, b) =>
      ((a as { index?: number }).index ?? 0) - ((b as { index?: number }).index ?? 0));
    const N = sorted.length;
    targets = new Map(sorted.map((n, i) => [n, R * Math.cbrt((i + 0.5) / N)]));
  };
  return force;
}

interface SpikeNode {
  id: number; name: string; cat: string; deg: number;
  x?: number; y?: number; z?: number;
  __sp?: THREE.Sprite; __baseSize?: number; __phase?: number;
}

export default function KnowledgeGraphSpike3D() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ReturnType<typeof ForceGraph3D<SpikeNode, { source: number; target: number }>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useAppStore(s => s.theme);
  const isDark = theme === 'dark';
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
    links.forEach(l => { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); });
    nodes.forEach(n => { n.deg = deg.get(n.id) || 0; });

    // 分级节点阈值（supernode 前 15% / ultranode 前 2%）
    const degs = nodes.map(n => n.deg).sort((a, b) => a - b);
    const p85 = degs[Math.floor(degs.length * 0.85)] ?? 0;
    const p98 = degs[Math.floor(degs.length * 0.98)] ?? 0;

    let disposed = false;
    try {
      const graph = ForceGraph3D<SpikeNode, { source: number; target: number }>()(containerRef.current);
      graphRef.current = graph;
      (window as unknown as { __spikeGraph?: unknown }).__spikeGraph = graph;
      graph
        .backgroundColor('rgba(0,0,0,0)')
        .nodeThreeObject((nd) => {
          const tier = nd.deg >= p98 ? 2.1 : nd.deg >= p85 ? 1.45 : 1;
          const base = (5.5 + Math.min(11, Math.log(1 + nd.deg) * 2.4)) * tier;
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(COLORS[nd.cat] || COLORS.tag, isDark),
            transparent: true, depthWrite: false,
            ...(isDark ? { blending: THREE.AdditiveBlending } : {}),
          }));
          sprite.scale.set(base, base, 1);
          nd.__sp = sprite;
          nd.__baseSize = base;
          nd.__phase = (nd.id * 2.399) % (Math.PI * 2); // 黄金角错相
          return sprite;
        })
        .nodeLabel((nd) => `${nd.name} ｜ ${LABELS[nd.cat] || nd.cat}`)
        .warmupTicks(90)
        .linkColor(() => (isDark ? 'rgba(130,170,230,0.28)' : 'rgba(55,82,128,0.5)'))
        .linkWidth(isDark ? 0.6 : 0.9)
        .linkOpacity(0.35)
        .linkCurvature(0.12)
        // 递质粒子流：只给核心边（双端度数都 ≥ P85）
        .linkDirectionalParticles((l) => {
          const s = l.source as unknown as SpikeNode, t = l.target as unknown as SpikeNode;
          return (s.deg ?? 0) >= p85 && (t.deg ?? 0) >= p85 ? 2 : 0;
        })
        .linkDirectionalParticleWidth(1.7)
        .linkDirectionalParticleSpeed(0.0045)
        .linkDirectionalParticleColor(() => (isDark ? '#d4a853' : '#9c7a2e'))
        .onNodeClick((nd) => {
          const dist = 60;
          const ratio = 1 + dist / Math.hypot(nd.x || 0, nd.y || 0, nd.z || 0);
          graph.cameraPosition(
            { x: (nd.x || 0) * ratio, y: (nd.y || 0) * ratio, z: (nd.z || 0) * ratio },
            nd as never, 1200,
          );
        });

      // ---- 布局力学：规模自适应 + 分层径向填球 ----
      const N = nodes.length;
      const scale = Math.cbrt(N / 100);
      const sphereR = 50 * scale;
      const charge = graph.d3Force('charge') as unknown as { strength: (v: number) => void } | null;
      charge?.strength(-8 * scale * scale);
      const linkF = graph.d3Force('link') as unknown as { distance: (v: number) => void } | null;
      linkF?.distance(10 * scale);
      graph.d3Force('x', null as never);
      graph.d3Force('y', null as never);
      graph.d3Force('z', null as never);

      // 分层径向力（tick 驱动节点脉冲呼吸）
      let t = 0;
      graph.d3Force('layered', makeLayeredForce(sphereR, () => {
        t += 0.016;
        for (const nd of nodes) {
          const sp = nd.__sp;
          if (!sp || nd.__baseSize == null || nd.__phase == null) continue;
          const s = nd.__baseSize * (1 + 0.08 * Math.sin(t * 2.1 + nd.__phase));
          sp.scale.set(s, s, 1);
        }
      }) as never);

      // 灌数据：warmupTicks 在 graphData 调用时同步跑 —— 必须在所有力学配置之后
      graph.graphData({ nodes, links });

      // 目标球线框（极淡，暗示边界）
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(sphereR, 18, 12)),
        new THREE.LineBasicMaterial({ color: isDark ? 0x3a5a8a : 0x8aa8d0, transparent: true, opacity: isDark ? 0.06 : 0.14 }),
      );
      graph.scene().add(wire);

      // 深度雾 + 星野
      graph.scene().fog = new THREE.FogExp2(isDark ? 0x09090b : 0xeef2f8, 0.0006);
      const starGeo = new THREE.BufferGeometry();
      const starPos = new Float32Array(1200 * 3);
      for (let i = 0; i < 1200; i++) {
        const r = 900 + Math.random() * 1600;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        starPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        starPos[i * 3 + 2] = r * Math.cos(ph);
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      graph.scene().add(new THREE.Points(starGeo, new THREE.PointsMaterial({
        color: isDark ? 0x8fb4e8 : 0x7d9ac8, size: 2.2, transparent: true, opacity: isDark ? 0.55 : 0.4,
      })));

      // Bloom（仅深色；阈值 0.75 让白热核发光、彩点不糊）
      if (isDark) {
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(containerRef.current.clientWidth, containerRef.current.clientHeight),
          0.42, 0.3, 0.75,
        );
        graph.postProcessingComposer().addPass(bloom);
      }

      // HiDPI 锐度
      graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const ctl = graph.controls() as { autoRotate: boolean; autoRotateSpeed: number };
      ctl.autoRotate = true;
      ctl.autoRotateSpeed = 0.6;
      // 布局沉降后取景：相机抬高 20° 俯角
      setTimeout(() => {
        const gd = graph.graphData() as { nodes: SpikeNode[]; links: unknown[] };
        const xs = gd.nodes.map(n => n.x ?? 0), ys = gd.nodes.map(n => n.y ?? 0), zs = gd.nodes.map(n => n.z ?? 0);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const dim = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs), 1);
        graph.cameraPosition({ x: cx, y: cy + dim * 0.42, z: cz + dim * 1.3 }, { x: cx, y: cy, z: cz } as never, 1200);
      }, 1200);
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    }

    return () => {
      disposed = true;
      (graphRef.current as unknown as { _destructor?: () => void })?._destructor?.();
      graphRef.current = null;
    };
  }, [graphQuery.data, isDark]);

  const fg = isDark ? '#e6edf7' : '#26303e';
  const sub = isDark ? '#9fb4d8' : '#5a6a80';
  const faint = isDark ? '#6c7f9f' : '#8a98ad';

  return (
    <div style={{ position: 'fixed', inset: 0, top: 48, background: isDark ? '#09090b' : '#eef2f8', transition: 'background 0.4s' }}>
      {/* key=theme：切主题时整棵 DOM 重挂载（旧 WebGL 上下文随旧 canvas 销毁） */}
      <div key={theme} ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {/* HUD */}
      <div style={{ position: 'absolute', left: 18, top: 16, zIndex: 10, color: sub, fontSize: 12, letterSpacing: 0.4, pointerEvents: 'none' }}>
        <b style={{ color: fg, fontSize: 15, display: 'block', marginBottom: 4, letterSpacing: 1.5 }}>
          璇玑 · 星云图（3D 预览）
        </b>
        {graphQuery.data
          ? `${(graphQuery.data as { nodes: unknown[] }).nodes.length} 节点 · 递质放电 · 脉冲呼吸`
          : '载入中…'}
      </div>
      <div style={{ position: 'absolute', right: 18, top: 16, zIndex: 10, color: sub, fontSize: 12, lineHeight: '22px', background: isDark ? 'rgba(12,14,18,.55)' : 'rgba(255,255,255,.6)', border: `1px solid ${isDark ? 'rgba(120,160,220,.14)' : 'rgba(90,120,160,.2)'}`, borderRadius: 10, padding: '10px 14px', backdropFilter: 'blur(6px)' }}>
        {Object.keys(COLORS).map(c => (
          <div key={c}>
            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 7, background: COLORS[c], boxShadow: `0 0 8px ${COLORS[c]}` }} />
            {LABELS[c]}
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 18, bottom: 16, zIndex: 10, color: faint, fontSize: 11 }}>
        拖动旋转 · 滚轮缩放 · 悬停看名称 · 点击聚焦 ｜ 跟随「昼白/深空」主题切换
      </div>
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6b9d', fontSize: 13, zIndex: 20 }}>
          渲染失败：{error}
        </div>
      )}
    </div>
  );
}
