/**
 * 3D 图谱预览页（实验路由 /spike3d）——Obsidian 洁净版。
 *
 * 设计定调（用户 2026-10-03）：学 Obsidian 原生图谱的干净——
 * 节点清晰（硬边实心小圆、近乎均一尺寸）、连线极细（发丝级直线）、无辉光无雾无装饰。
 * 参考：用户提供的 Obsidian 图谱截图（/115/碧霄/知识脑图）。
 *
 * 砍掉（'模糊杂乱'的来源）：发光晕纹理、Bloom、加色混合、脉冲呼吸、粒子流、
 * 连线弧度、星野、线框球、深度雾、分级尺寸。
 * 保留：分层径向力体积填球、∛N 规模自适应、HiDPI 像素比、20° 俯角取景。
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import { trpc } from '@/providers/trpc';
import { useAppStore } from '@/store/useAppStore';

/** 与 2D 图谱同口径的霓虹六色 */
const PALETTE = {
  dark: {
    concept: '#5090f8', document: '#45c860', topic: '#f0d020',
    entity: '#f25050', note: '#d070e8', tag: '#30c8c8',
  } as Record<string, string>,
  light: {
    concept: '#2f6fd0', document: '#2a9e45', topic: '#c9a800',
    entity: '#cf3a3a', note: '#a84fc0', tag: '#189a9a',
  } as Record<string, string>,
};
const LABELS: Record<string, string> = {
  concept: '概念', document: '文档', topic: '主题',
  entity: '实体', note: '笔记', tag: '标签',
};

/** 硬边实心圆盘纹理（Obsidian 式）：纯色填充 + 一圈深色描边，边缘干净无渐变 */
const texCache = new Map<string, THREE.CanvasTexture>();
function glowTexture(color: string, isDark: boolean): THREE.CanvasTexture {
  const key = color + (isDark ? '|d' : '|l');
  const hit = texCache.get(key);
  if (hit) return hit;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const cx = S / 2, R = S * 0.4;
  x.beginPath(); x.arc(cx, cx, R, 0, Math.PI * 2);
  x.fillStyle = color;
  x.fill();
  x.lineWidth = S * 0.035;
  x.strokeStyle = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.5)';
  x.stroke();
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
  __sp?: THREE.Sprite; __baseSize?: number;
}

export default function KnowledgeGraphSpike3D() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ReturnType<typeof ForceGraph3D<SpikeNode, { source: number; target: number }>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useAppStore(s => s.theme);
  const isDark = theme === 'dark';
  const COLORS = isDark ? PALETTE.dark : PALETTE.light;
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

    let disposed = false;
    try {
      const graph = ForceGraph3D<SpikeNode, { source: number; target: number }>()(containerRef.current);
      graphRef.current = graph;
      (window as unknown as { __spikeGraph?: unknown }).__spikeGraph = graph;
      graph
        .backgroundColor('rgba(0,0,0,0)')
        .nodeThreeObject((nd) => {
          // Obsidian 式：尺寸近均一，度数只做轻微区分
          const base = 3.2 + Math.min(2.2, Math.log(1 + nd.deg) * 0.9);
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(COLORS[nd.cat] || COLORS.tag, isDark),
            transparent: true, depthWrite: false,
          }));
          sprite.scale.set(base, base, 1);
          nd.__sp = sprite;
          nd.__baseSize = base;
          return sprite;
        })
        .nodeLabel((nd) => `${nd.name} ｜ ${LABELS[nd.cat] || nd.cat}`)
        .warmupTicks(90)
        // Obsidian 式：发丝级直线，克制的中性色
        .linkColor(() => (isDark ? 'rgba(148,163,184,0.4)' : 'rgba(100,116,139,0.5)'))
        .linkWidth(0.25)
        .linkOpacity(0.5)
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

      // 分层径向力（体积填球）
      graph.d3Force('layered', makeLayeredForce(sphereR) as never);

      // 灌数据：warmupTicks 在 graphData 调用时同步跑 —— 必须在所有力学配置之后
      graph.graphData({ nodes, links });

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
          ? `${(graphQuery.data as { nodes: unknown[] }).nodes.length} 节点`
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
