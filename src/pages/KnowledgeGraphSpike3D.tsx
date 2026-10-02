/**
 * 3D 星云预览页（实验路由 /spike3d）：方案 A「换 WebGL 引擎」的可视化探针。
 *
 * 设计定调（用户）：
 * ① 星系式整体感 —— 节点被「球形容器力」约束，发散后均匀填满一个球体，不割裂成碎团；
 * ② 距离随规模自适应 —— 斥力/边长/球半径按 ∛N 等比缩放，节点变多密度不变；
 * ③ 八卦元素 —— 球体外围一圈先天八卦卦象环（矢量画卦，无字体依赖），随时间缓转；
 * ④ 浅/深双主题 —— 跟随应用「昼白/夜」主题（useAppStore.theme），深色有 Bloom 辉光，
 *    浅色改为普通混合 + 关辉光（加法发光在白底上必然洗白）。
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

/** 先天八卦（方位序：乾兑离震巽坎艮坤）：每卦三爻，true=阳爻(整) false=阴爻(断)，自下而上 */
const TRIGRAMS: boolean[][] = [
  [true, true, true],    // 乾 ☰ 天
  [true, true, false],   // 兑 ☱ 泽
  [true, false, true],   // 离 ☲ 火
  [true, false, false],  // 震 ☳ 雷
  [false, true, true],   // 巽 ☴ 风
  [false, true, false],  // 坎 ☵ 水
  [false, false, true],  // 艮 ☶ 山
  [false, false, false], // 坤 ☷ 地
];

/** 发光纹理：平滑径向渐变（WebGL 纹理缩放无位图锯齿问题） */
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
    // 深色：白热小核 + 紧晕（防加法叠加洗白，晕宁小勿大）
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.06, color);
    g.addColorStop(0.16, color + '55');
    g.addColorStop(1, color + '00');
  } else {
    // 浅色：实心色核（白核在白底上是隐形的 → 清晰度全丢），边缘快速衰减
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

/** 卦牌纹理：圆形令牌 + 金环 + 矢量三爻（无字体依赖；令牌底色让卦象在星云中清晰可读） */
const trigramCache = new Map<string, THREE.CanvasTexture>();
function trigramTexture(lines: boolean[], color: string, isDark: boolean): THREE.CanvasTexture {
  const key = lines.map(Number).join('') + color + isDark;
  const hit = trigramCache.get(key);
  if (hit) return hit;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const cx = S / 2, R = S * 0.46;
  // 令牌底
  x.beginPath();
  x.arc(cx, cx, R, 0, Math.PI * 2);
  x.fillStyle = isDark ? 'rgba(8,12,22,0.88)' : 'rgba(255,252,246,0.92)';
  x.fill();
  // 金环（双线，外粗内细）
  x.strokeStyle = color;
  x.lineWidth = S * 0.022;
  x.beginPath(); x.arc(cx, cx, R - S * 0.014, 0, Math.PI * 2); x.stroke();
  x.lineWidth = S * 0.008;
  x.beginPath(); x.arc(cx, cx, R - S * 0.05, 0, Math.PI * 2); x.stroke();
  // 三爻
  x.strokeStyle = color;
  x.lineCap = 'round';
  x.lineWidth = S * 0.052;
  const barW = S * 0.5, gap = S * 0.115;
  const ys = [cx + gap, cx, cx - gap]; // lines[0]=下爻
  lines.forEach((solid, i) => {
    const y = ys[i];
    x.beginPath();
    if (solid) {
      x.moveTo(cx - barW / 2, y); x.lineTo(cx + barW / 2, y);
    } else {
      x.moveTo(cx - barW / 2, y); x.lineTo(cx - barW * 0.14, y);
      x.moveTo(cx + barW * 0.14, y); x.lineTo(cx + barW / 2, y);
    }
    x.stroke();
  });
  const tex = new THREE.CanvasTexture(cv);
  trigramCache.set(key, tex);
  return tex;
}

/** 分层径向力（构造性充盈）：给每个节点分派目标半径 rᵢ = R·∛(rank/N)（按 id 稳定排序），
 * 每 tick 把它拉向自己的那一层 → 径向分布在构造上就等于均匀体积填充。
 * 全局斥力（无论多弱）会把全体甩成空心壳（实测：壳定理下壳内斥力仍胜线性引力），
 * 分层径向把"往哪儿去"直接钉死，斥力只管局部舒展开 —— 这是"填满球体"的可靠做法。 */
interface ForceNode { x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number }
function makeSphereForces(R: number, onTick?: () => void) {
  let targets: Map<ForceNode, number> = new Map();
  const layered = () => {
    for (const [n, r] of targets) {
      const d = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      if (d < 1e-6) continue;
      const k = ((d - r) / d) * 0.45; // 恒定力，不随 alpha 衰减（冷却后还要保持队形）
      n.vx = (n.vx ?? 0) - (n.x ?? 0) * k;
      n.vy = (n.vy ?? 0) - (n.y ?? 0) * k;
      n.vz = (n.vz ?? 0) - (n.z ?? 0) * k;
    }
    onTick?.();
  };
  (layered as { initialize?: (nodes: ForceNode[]) => void }).initialize = (nodes) => {
    // 按 x/y/z 之外稳定可用的属性排序；d3 节点上有 index
    const sorted = [...nodes].sort((a, b) =>
      ((a as { index?: number }).index ?? 0) - ((b as { index?: number }).index ?? 0));
    const N = sorted.length;
    targets = new Map(sorted.map((n, i) => [n, R * Math.cbrt((i + 0.5) / N)]));
  };
  return { layered };
}

interface SpikeNode { id: number; name: string; cat: string; deg: number; x?: number; y?: number; z?: number }

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
    links.forEach(l => { deg.set(l.source as number, (deg.get(l.source as number) || 0) + 1); deg.set(l.target as number, (deg.get(l.target as number) || 0) + 1); });
    nodes.forEach(n => { n.deg = deg.get(n.id) || 0; });

    let disposed = false;
    try {
      const graph = ForceGraph3D<SpikeNode, { source: number; target: number }>()(containerRef.current);
      graphRef.current = graph;
      graph
        .backgroundColor('rgba(0,0,0,0)')
        .nodeThreeObject((nd) => {
          const size = 5.5 + Math.min(11, Math.log(1 + nd.deg) * 2.4);
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(COLORS[nd.cat] || COLORS.tag, isDark),
            transparent: true, depthWrite: false,
            // 浅色主题下加法发光必然洗白 → 普通混合
            ...(isDark ? { blending: THREE.AdditiveBlending } : {}),
          }));
          sprite.scale.set(size, size, 1);
          return sprite;
        })
        .nodeLabel((nd) => `${nd.name} ｜ ${LABELS[nd.cat] || nd.cat}`)
        .warmupTicks(90)
        .linkColor(() => (isDark ? 'rgba(130,170,230,0.28)' : 'rgba(55,82,128,0.5)'))
        .linkWidth(isDark ? 0.6 : 0.9)
        .linkOpacity(0.35)
        .onNodeClick((nd) => {
          const dist = 60;
          const ratio = 1 + dist / Math.hypot(nd.x || 0, nd.y || 0, nd.z || 0);
          graph.cameraPosition(
            { x: (nd.x || 0) * ratio, y: (nd.y || 0) * ratio, z: (nd.z || 0) * ratio },
            nd as never, 1200,
          );
        });

      // ---- 布局力学：规模自适应 + 球形容器 ----
      const N = nodes.length;
      const scale = Math.cbrt(N / 100);
      const sphereR = 50 * scale; // 填满目标球半径
      const charge = graph.d3Force('charge') as unknown as { strength: (v: number) => void } | null;
      charge?.strength(-8 * scale * scale);
      const linkF = graph.d3Force('link') as unknown as { distance: (v: number) => void } | null;
      linkF?.distance(10 * scale);
      graph.d3Force('x', null as never);
      graph.d3Force('y', null as never);
      graph.d3Force('z', null as never);

      // 八卦环：8 卦 sprites 排在球外环上，随容器力 tick 缓转
      const bagua = new THREE.Group();
      const glyphColor = isDark ? '#e8c36a' : '#9a7b2d';
      TRIGRAMS.forEach((lines, i) => {
        const a = (i / 8) * Math.PI * 2;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: trigramTexture(lines, glyphColor, isDark), transparent: true, depthWrite: false,
          opacity: isDark ? 0.9 : 0.8,
        }));
        const gSize = sphereR * 0.5;
        sp.scale.set(gSize, gSize, 1);
        sp.position.set(Math.cos(a) * sphereR * 1.35, 0, Math.sin(a) * sphereR * 1.35);
        bagua.add(sp);
      });
      bagua.rotation.x = 0.42; // 环面倾斜 ~24°，从侧前方看呈椭圆法阵
      graph.scene().add(bagua);
      (window as unknown as { __spikeBagua?: THREE.Group }).__spikeBagua = bagua;
      (window as unknown as { __spikeGraph?: unknown }).__spikeGraph = graph;

      // 分层径向力（tick 里顺带驱动八卦环缓转）
      const sphereForces = makeSphereForces(sphereR, () => { bagua.rotation.y += 0.0011; });
      graph.d3Force('layered', sphereForces.layered as never);

      // 灌数据：warmupTicks 在 graphData 调用时同步跑 —— 必须在所有力学配置之后，
      // 否则预热用默认力学布局，自定义斥力/容器力只在后续 tick 缝缝补补（节点逸出球外）
      graph.graphData({ nodes, links });

      // 目标球线框（稀疏经纬，暗示"填满这个球"的边界）
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(sphereR, 18, 12)),
        new THREE.LineBasicMaterial({
          color: isDark ? 0x3a5a8a : 0x8aa8d0,
          transparent: true, opacity: isDark ? 0.10 : 0.22,
        }),
      );
      graph.scene().add(wire);

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
        color: isDark ? 0x8fb4e8 : 0x7d9ac8, size: 2.2, transparent: true, opacity: isDark ? 0.55 : 0.4,
      })));

      // Bloom 辉光（仅深色主题；浅色下发光必然洗白）
      if (isDark) {
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(containerRef.current.clientWidth, containerRef.current.clientHeight),
          0.38, 0.3, 0.5,
        );
        graph.postProcessingComposer().addPass(bloom);
      }

      const ctl = graph.controls() as { autoRotate: boolean; autoRotateSpeed: number };
      ctl.autoRotate = true;
      ctl.autoRotateSpeed = 0.6;
      // 布局沉降后按图云包围盒手动取景
      setTimeout(() => {
        const gd = graph.graphData() as { nodes: SpikeNode[]; links: unknown[] };
        const xs = gd.nodes.map(n => n.x ?? 0), ys = gd.nodes.map(n => n.y ?? 0), zs = gd.nodes.map(n => n.z ?? 0);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const dim = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs), 1);
        graph.cameraPosition({ x: cx, y: cy, z: cz + dim * 1.3 }, { x: cx, y: cy, z: cz } as never, 1200);
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

  // 主题化配色
  const fg = isDark ? '#e6edf7' : '#26303e';
  const sub = isDark ? '#9fb4d8' : '#5a6a80';
  const faint = isDark ? '#6c7f9f' : '#8a98ad';

  return (
    <div style={{ position: 'fixed', inset: 0, top: 48, background: isDark ? '#04060b' : '#eef2f8', transition: 'background 0.4s' }}>
      {/* key=theme：切主题时整棵 DOM 重挂载（旧 WebGL 上下文随旧 canvas 一起销毁），
          避免在同一容器里二次初始化 3d-force-graph 渲染不出来 */}
      <div key={theme} ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {/* HUD */}
      <div style={{ position: 'absolute', left: 18, top: 16, zIndex: 10, color: sub, fontSize: 12, letterSpacing: 0.4, pointerEvents: 'none' }}>
        <b style={{ color: fg, fontSize: 15, display: 'block', marginBottom: 4, letterSpacing: 1.5 }}>
          璇玑 · 知识星云（3D 预览）
        </b>
        {graphQuery.data
          ? `${(graphQuery.data as { nodes: unknown[] }).nodes.length} 节点 · 八卦环护 · 球形充盈`
          : '载入中…'}
      </div>
      <div style={{ position: 'absolute', right: 18, top: 16, zIndex: 10, color: sub, fontSize: 12, lineHeight: '22px', background: isDark ? 'rgba(12,16,26,.55)' : 'rgba(255,255,255,.6)', border: `1px solid ${isDark ? 'rgba(120,160,220,.14)' : 'rgba(90,120,160,.2)'}`, borderRadius: 10, padding: '10px 14px', backdropFilter: 'blur(6px)' }}>
        {Object.keys(COLORS).map(c => (
          <div key={c}>
            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 7, background: COLORS[c], boxShadow: `0 0 8px ${COLORS[c]}` }} />
            {LABELS[c]}
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 18, bottom: 16, zIndex: 10, color: faint, fontSize: 11 }}>
        拖动旋转 · 滚轮缩放 · 悬停看名称 · 点击聚焦 ｜ 跟随「昼白/夜」主题切换浅深背景
      </div>
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6b9d', fontSize: 13, zIndex: 20 }}>
          渲染失败：{error}
        </div>
      )}
    </div>
  );
}
