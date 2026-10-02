/**
 * 3D 星云预览页（实验路由 /spike3d）——「璇玑浑天仪」版。
 *
 * 设计定调（用户 + 博士调研 2026-10）：
 * ① 球形充盈 —— 分层径向力 rᵢ=R·∛(rank/N) 构造性均匀体积填充（斥力+边界只能得空心壳）；
 * ② 浑天仪环 —— 三层差速同心环：天池太极（中心自转）+ 卦环（卦符+卦名+方位三件套）
 *    + 24 刻度外环（反向旋转），两条朱砂「天心十道」正交准线，倾角 15° 保仪器正位感；
 *    （参考：风水罗盘分层 / I Ching Sphere / tai-chi-diagram-science 的「Scholarly not mystical」）
 * ③ 活体脑核 —— 递质粒子流（只给核心边）+ 节点错相位脉冲呼吸 + FogExp2 深度雾 + 分级节点；
 *    （参考：Eyewire 荧光分色 / Jarvis UI 分级节点 / 3d-force-graph 内置粒子流）
 * ④ 配色纪律 —— 深空 #09090b（禁纯黑）、学士金 #d4a853、朱砂 #c8433c 仅天心十道一处。
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

/** 浑天仪配色纪律 */
const GOLD_DARK = '#d4a853';   // 学士金（深空主题）
const GOLD_LIGHT = '#9c7a2e';  // 昼白下加深保对比
const CINNABAR = '#c8433c';    // 朱砂（仅天心十道）

/** 先天八卦（序：乾兑离震巽坎艮坤）：三爻 true=阳(整) false=阴(断)，自下而上；配卦名与方位 */
const TRIGRAMS = [
  { lines: [true, true, true], name: '乾', dir: '天 · 南' },
  { lines: [true, true, false], name: '兑', dir: '泽 · 东南' },
  { lines: [true, false, true], name: '离', dir: '火 · 东' },
  { lines: [true, false, false], name: '震', dir: '雷 · 东北' },
  { lines: [false, true, true], name: '巽', dir: '风 · 西南' },
  { lines: [false, true, false], name: '坎', dir: '水 · 西' },
  { lines: [false, false, true], name: '艮', dir: '山 · 西北' },
  { lines: [false, false, false], name: '坤', dir: '地 · 北' },
];

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

/** 卦牌纹理：令牌底 + 金环双线 + 矢量三爻 + 卦名 + 方位（罗盘三件套） */
const trigramCache = new Map<string, THREE.CanvasTexture>();
function trigramTexture(lines: boolean[], name: string, dir: string, gold: string, isDark: boolean): THREE.CanvasTexture {
  const key = lines.map(Number).join('') + name + gold;
  const hit = trigramCache.get(key);
  if (hit) return hit;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const cx = S / 2, R = S * 0.46;
  x.beginPath(); x.arc(cx, cx, R, 0, Math.PI * 2);
  x.fillStyle = isDark ? 'rgba(9,9,11,0.88)' : 'rgba(255,252,246,0.94)';
  x.fill();
  x.strokeStyle = gold;
  x.lineWidth = S * 0.02;
  x.beginPath(); x.arc(cx, cx, R - S * 0.013, 0, Math.PI * 2); x.stroke();
  x.lineWidth = S * 0.007;
  x.beginPath(); x.arc(cx, cx, R - S * 0.045, 0, Math.PI * 2); x.stroke();
  // 三爻（上半区）
  x.lineCap = 'round';
  x.lineWidth = S * 0.048;
  const barW = S * 0.46, gap = S * 0.1, cyBars = S * 0.36;
  const ys = [cyBars + gap, cyBars, cyBars - gap]; // lines[0]=下爻
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
  // 卦名 + 方位（罗盘三件套的文字层）
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillStyle = gold;
  x.font = `${S * 0.17}px "Noto Serif CJK SC", "Songti SC", "SimSun", serif`;
  x.fillText(name, cx, S * 0.66);
  x.globalAlpha = 0.75;
  x.font = `${S * 0.075}px "Noto Serif CJK SC", "Songti SC", "SimSun", serif`;
  x.fillText(dir, cx, S * 0.81);
  x.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  trigramCache.set(key, tex);
  return tex;
}

/** 太极图纹理（天池）：经典阴阳鱼矢量构造 */
function taijiTexture(gold: string, isDark: boolean): THREE.CanvasTexture {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const cx = S / 2, R = S * 0.46;
  const dark = isDark ? '#101b30' : '#2c3a52';
  // 阴鱼底
  x.beginPath(); x.arc(cx, cx, R, 0, Math.PI * 2); x.fillStyle = dark; x.fill();
  // 阳鱼（金）：右半圆 + 两条小半圆 S 曲线
  x.beginPath();
  x.arc(cx, cx, R, -Math.PI / 2, Math.PI / 2, false);
  x.arc(cx, cx + R / 2, R / 2, Math.PI / 2, -Math.PI / 2, true);
  x.arc(cx, cx - R / 2, R / 2, Math.PI / 2, -Math.PI / 2, false);
  x.closePath(); x.fillStyle = gold; x.fill();
  // 鱼眼
  x.beginPath(); x.arc(cx, cx - R / 2, R * 0.09, 0, Math.PI * 2); x.fillStyle = dark; x.fill();
  x.beginPath(); x.arc(cx, cx + R / 2, R * 0.09, 0, Math.PI * 2); x.fillStyle = gold; x.fill();
  // 外环
  x.strokeStyle = gold; x.lineWidth = S * 0.018;
  x.beginPath(); x.arc(cx, cx, R, 0, Math.PI * 2); x.stroke();
  return new THREE.CanvasTexture(cv);
}

/** 刻度环纹理：24 长刻度 + 96 短刻度 + 内外缘细线（仪器感） */
function tickRingTexture(gold: string): THREE.CanvasTexture {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const cx = S / 2;
  x.strokeStyle = gold;
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    const major = i % 5 === 0;
    const r0 = S * (major ? 0.415 : 0.44);
    const r1 = S * 0.475;
    x.lineWidth = major ? S * 0.006 : S * 0.003;
    x.beginPath();
    x.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0);
    x.lineTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1);
    x.stroke();
  }
  x.lineWidth = S * 0.004;
  x.beginPath(); x.arc(cx, cx, S * 0.412, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.arc(cx, cx, S * 0.478, 0, Math.PI * 2); x.stroke();
  return new THREE.CanvasTexture(cv);
}

/** 分层径向力（构造性充盈）：每节点目标半径 rᵢ = R·∛(rank/N)（按 index 稳定排序），
 * 每 tick 恒力拉向自己那层（不乘 alpha —— 冷却后仍保持队形）。
 * 教训：全局斥力+边界容器只能得空心壳（壳定理下壳内斥力仍胜线性引力）。 */
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
    links.forEach(l => { deg.set(l.source as number, (deg.get(l.source as number) || 0) + 1); deg.set(l.target as number, (deg.get(l.target as number) || 0) + 1); });
    nodes.forEach(n => { n.deg = deg.get(n.id) || 0; });

    // 分级节点阈值（Jarvis UI 式：supernode 前 15% / ultranode 前 2%）
    const degs = nodes.map(n => n.deg).sort((a, b) => a - b);
    const p85 = degs[Math.floor(degs.length * 0.85)] ?? 0;
    const p98 = degs[Math.floor(degs.length * 0.98)] ?? 0;

    const gold = isDark ? GOLD_DARK : GOLD_LIGHT;
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
        // 递质粒子流：只给核心边（双端度数都 ≥ P85），活体脑核的"放电"
        .linkDirectionalParticles((l) => {
          const s = l.source as unknown as SpikeNode, t = l.target as unknown as SpikeNode;
          return (s.deg ?? 0) >= p85 && (t.deg ?? 0) >= p85 ? 2 : 0;
        })
        .linkDirectionalParticleWidth(1.7)
        .linkDirectionalParticleSpeed(0.0045)
        .linkDirectionalParticleColor(() => gold)
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

      // ---- 浑天仪：三层差速同心环 + 天心十道 ----
      const armillary = new THREE.Group();
      armillary.rotation.x = 0.26; // 倾角 15°，保仪器正位感
      const ringMedal = new THREE.Group();
      const ringTicks = new THREE.Group();
      const taijiSpin = new THREE.Group();
      armillary.add(ringMedal, ringTicks, taijiSpin);

      // 卦环：卦符+卦名+方位三件套令牌
      TRIGRAMS.forEach((tg, i) => {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 2; // 乾居南（面向观者）
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: trigramTexture(tg.lines, tg.name, tg.dir, gold, isDark),
          transparent: true, depthWrite: false,
        }));
        const gSize = sphereR * 0.46;
        sp.scale.set(gSize, gSize, 1);
        sp.position.set(Math.cos(a) * sphereR * 1.32, 0, Math.sin(a) * sphereR * 1.32);
        ringMedal.add(sp);
      });

      // 天池太极：球心平盘，自转
      const taiji = new THREE.Mesh(
        new THREE.PlaneGeometry(sphereR * 0.42, sphereR * 0.42),
        new THREE.MeshBasicMaterial({ map: taijiTexture(gold, isDark), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      );
      taiji.rotation.x = -Math.PI / 2;
      taijiSpin.add(taiji);

      // 刻度外环：平盘贴图，反向旋转
      const ticks = new THREE.Mesh(
        new THREE.PlaneGeometry(sphereR * 3.6, sphereR * 3.6),
        new THREE.MeshBasicMaterial({ map: tickRingTexture(gold), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85 }),
      );
      ticks.rotation.x = -Math.PI / 2;
      ringTicks.add(ticks);

      // 天心十道：两条朱砂正交准线
      for (const rz of [0, Math.PI / 2]) {
        const line = new THREE.Mesh(
          new THREE.PlaneGeometry(sphereR * 3.5, sphereR * 0.016),
          new THREE.MeshBasicMaterial({ color: CINNABAR, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
        );
        line.rotation.x = -Math.PI / 2;
        line.rotation.z = rz;
        armillary.add(line);
      }
      graph.scene().add(armillary);

      // 分层径向力（tick 驱动：三环差速 + 节点脉冲呼吸）
      let t = 0;
      graph.d3Force('layered', makeLayeredForce(sphereR, () => {
        t += 0.016;
        ringMedal.rotation.y += 0.0008;
        ringTicks.rotation.y -= 0.0005;
        taijiSpin.rotation.y += 0.006;
        // 节点脉冲（黄金角错相位正弦呼吸，"活体"感）
        for (const nd of nodes) {
          const sp = nd.__sp;
          if (!sp || nd.__baseSize == null || nd.__phase == null) continue;
          const s = nd.__baseSize * (1 + 0.08 * Math.sin(t * 2.1 + nd.__phase));
          sp.scale.set(s, s, 1);
        }
      }) as never);

      // 灌数据：warmupTicks 在 graphData 调用时同步跑 —— 必须在所有力学配置之后
      graph.graphData({ nodes, links });

      // 目标球线框（稀疏经纬，暗示球体边界）
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(sphereR, 18, 12)),
        new THREE.LineBasicMaterial({ color: isDark ? 0x3a5a8a : 0x8aa8d0, transparent: true, opacity: isDark ? 0.08 : 0.18 }),
      );
      graph.scene().add(wire);

      // 深度雾（FogExp2）：远景衰减出纵深
      graph.scene().fog = new THREE.FogExp2(isDark ? 0x09090b : 0xeef2f8, 0.0006);

      // 背景星野：1200 个远景星点围成球壳
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

      // Bloom 辉光（仅深色；浅色下发光必然洗白）
      if (isDark) {
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(containerRef.current.clientWidth, containerRef.current.clientHeight),
          0.42, 0.3, 0.75,
        );
        graph.postProcessingComposer().addPass(bloom);
      }

      // HiDPI 锐度：渲染分辨率跟随设备像素比（封顶 2 防性能税）
      graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const ctl = graph.controls() as { autoRotate: boolean; autoRotateSpeed: number };
      ctl.autoRotate = true;
      ctl.autoRotateSpeed = 0.6;
      // 布局沉降后按图云包围盒手动取景（getGraphBbox 此版本返回默认值，不可靠）
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

  // 主题化配色
  const fg = isDark ? '#e6edf7' : '#26303e';
  const sub = isDark ? '#9fb4d8' : '#5a6a80';
  const faint = isDark ? '#6c7f9f' : '#8a98ad';

  return (
    <div style={{ position: 'fixed', inset: 0, top: 48, background: isDark ? '#09090b' : '#eef2f8', transition: 'background 0.4s' }}>
      {/* key=theme：切主题时整棵 DOM 重挂载（旧 WebGL 上下文随旧 canvas 销毁），
          避免同容器二次初始化 3d-force-graph 渲染不出来 */}
      <div key={theme} ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {/* HUD */}
      <div style={{ position: 'absolute', left: 18, top: 16, zIndex: 10, color: sub, fontSize: 12, letterSpacing: 0.4, pointerEvents: 'none' }}>
        <b style={{ color: fg, fontSize: 15, display: 'block', marginBottom: 4, letterSpacing: 1.5 }}>
          璇玑 · 浑天仪（3D 预览）
        </b>
        {graphQuery.data
          ? `${(graphQuery.data as { nodes: unknown[] }).nodes.length} 节点 · 天池太极 · 八卦差速环 · 递质放电`
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
