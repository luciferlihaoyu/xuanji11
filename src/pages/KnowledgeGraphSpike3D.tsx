/**
 * 3D 星云预览页（实验路由 /spike3d）——「太极八卦 · 三生万物」层级版。
 *
 * 设计定调（用户 2026-10-02）：八卦是图谱的**组织逻辑**，不是表面外观：
 *   太极中枢（一生二）→ 八卦二级枢纽（二生三，八方宫位）→ 知识节点（三生万物，逐层挂接）。
 * 外观参考：用户上传的 Jarvis UI 星系视图截图（/115/碧霄/知识脑图）。
 *
 * 结构实现：
 * - 中枢太极钉在球心；八卦枢纽钉在八方宫位（乾上天·坤下地，其余六卦布立方体顶点）；
 * - 知识节点按类别归宫：乾=主题(天) 坤=文档(地) 离=概念(火) 坎=笔记(水)
 *   震=实体(雷) 巽=标签(风) 艮=库藏(山) 兑=精选(泽·备用)；
 * - 层级连线可见：太极→八卦（金色主脉+粒子流）、八卦→知识节点（极淡金支脉），
 *   原有有机连线保留（蓝调）——"逐层连接"是结构本身的可视化；
 * - 布局：分层径向力填球（构造性均匀）+ 宫位引力（节点向所属宫位轻拉，成簇不散）。
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

const GOLD_DARK = '#d4a853';
const GOLD_LIGHT = '#9c7a2e';

/** 先天八卦：三爻（true=阳 false=阴，自下而上）+ 卦名 + 象/方位 + 宫位方向 */
const D = 1 / Math.sqrt(3);
const TRIGRAMS = [
  { lines: [true, true, true], name: '乾', dir: '天', pos: [0, 1, 0] as const },        // 天在上
  { lines: [false, false, false], name: '坤', dir: '地', pos: [0, -1, 0] as const },     // 地在下
  { lines: [true, false, true], name: '离', dir: '火', pos: [D, D, D] as const },
  { lines: [false, true, false], name: '坎', dir: '水', pos: [-D, -D, -D] as const },
  { lines: [true, false, false], name: '震', dir: '雷', pos: [D, -D, D] as const },
  { lines: [false, true, true], name: '巽', dir: '风', pos: [-D, D, -D] as const },
  { lines: [false, false, true], name: '艮', dir: '山', pos: [-D, D, D] as const },
  { lines: [true, true, false], name: '兑', dir: '泽', pos: [D, D, -D] as const },
];

/** 类别 → 宫位（乾坤震巽坎离艮兑 各有其职） */
const CAT2PALACE: Record<string, number> = {
  topic: 0,    // 乾 · 天：纲举目张
  document: 1, // 坤 · 地：厚德载物
  concept: 2,  // 离 · 火：明照四方
  note: 3,     // 坎 · 水：流转不息
  entity: 4,   // 震 · 雷：动而显现
  tag: 5,      // 巽 · 风：无孔不入
};

/** 发光纹理按主题分流：深色白热小核+紧晕；浅色实心色核 */
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

/** 卦牌纹理：令牌底 + 金环双线 + 矢量三爻 + 卦名 + 卦象 */
const trigramCache = new Map<string, THREE.CanvasTexture>();
function trigramTexture(lines: boolean[], name: string, dir: string, gold: string, isDark: boolean): THREE.CanvasTexture {
  const key = lines.map(Number).join('') + name + gold + isDark;
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

/** 太极图纹理：经典阴阳鱼矢量构造 */
function taijiTexture(gold: string, isDark: boolean): THREE.CanvasTexture {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const cx = S / 2, R = S * 0.46;
  const dark = isDark ? '#101b30' : '#2c3a52';
  x.beginPath(); x.arc(cx, cx, R, 0, Math.PI * 2); x.fillStyle = dark; x.fill();
  x.beginPath();
  x.arc(cx, cx, R, -Math.PI / 2, Math.PI / 2, false);
  x.arc(cx, cx + R / 2, R / 2, Math.PI / 2, -Math.PI / 2, true);
  x.arc(cx, cx - R / 2, R / 2, Math.PI / 2, -Math.PI / 2, false);
  x.closePath(); x.fillStyle = gold; x.fill();
  x.beginPath(); x.arc(cx, cx - R / 2, R * 0.09, 0, Math.PI * 2); x.fillStyle = dark; x.fill();
  x.beginPath(); x.arc(cx, cx + R / 2, R * 0.09, 0, Math.PI * 2); x.fillStyle = gold; x.fill();
  x.strokeStyle = gold; x.lineWidth = S * 0.018;
  x.beginPath(); x.arc(cx, cx, R, 0, Math.PI * 2); x.stroke();
  return new THREE.CanvasTexture(cv);
}

/** 分层径向力（构造性充盈）+ 宫位引力（知识节点向所属卦位轻拉成簇）。
 * 教训：全局斥力+边界容器只能得空心壳（壳定理）；恒力分层才能体积填充。 */
interface ForceNode {
  x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number;
  __palace?: readonly number[];
  __hub?: boolean;
}
function makeLayeredForce(R: number, palaceOrbit: number, onTick?: () => void) {
  let targets: Map<ForceNode, number> = new Map();
  const force = () => {
    for (const [n, r] of targets) {
      const d = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      if (d > 1e-6) {
        const k = ((d - r) / d) * 0.45;
        n.vx = (n.vx ?? 0) - (n.x ?? 0) * k;
        n.vy = (n.vy ?? 0) - (n.y ?? 0) * k;
        n.vz = (n.vz ?? 0) - (n.z ?? 0) * k;
      }
      if (n.__palace) {
        const [px, py, pz] = n.__palace;
        n.vx = (n.vx ?? 0) + (px * palaceOrbit - (n.x ?? 0)) * 0.004;
        n.vy = (n.vy ?? 0) + (py * palaceOrbit - (n.y ?? 0)) * 0.004;
        n.vz = (n.vz ?? 0) + (pz * palaceOrbit - (n.z ?? 0)) * 0.004;
      }
    }
    onTick?.();
  };
  (force as { initialize?: (nodes: ForceNode[]) => void }).initialize = (nodes) => {
    const free = nodes.filter(n => !n.__hub);
    const sorted = [...free].sort((a, b) =>
      ((a as { index?: number }).index ?? 0) - ((b as { index?: number }).index ?? 0));
    const N = sorted.length;
    targets = new Map(sorted.map((n, i) => [n, R * Math.cbrt((i + 0.5) / N)]));
  };
  return force;
}

interface SpikeNode {
  id: number; name: string; cat: string; deg: number;
  x?: number; y?: number; z?: number;
  fx?: number; fy?: number; fz?: number;
  hub?: 'taiji' | 'trigram'; tri?: number;
  __palace?: readonly number[];
  __hub?: boolean;
  __sp?: THREE.Sprite; __baseSize?: number; __phase?: number;
}
interface SpikeLink { source: number; target: number; kind?: 'core' | 'branch' }

export default function KnowledgeGraphSpike3D() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ReturnType<typeof ForceGraph3D<SpikeNode, SpikeLink>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useAppStore(s => s.theme);
  const isDark = theme === 'dark';
  const graphQuery = trpc.knowledge.getGraph.useQuery();

  useEffect(() => {
    if (!containerRef.current || !graphQuery.data) return;
    const raw = graphQuery.data as { nodes: { id: number; title: string; type: string }[]; edges: { sourceId: number; targetId: number }[] };

    // ---- 规模参数 ----
    const N = raw.nodes.length;
    const scale = Math.cbrt(N / 100);
    const sphereR = 50 * scale;
    const palaceR = sphereR * 0.45; // 八卦宫位半径

    // ---- 知识节点（三生万物）----
    const nodes: SpikeNode[] = raw.nodes.map(n => ({ id: n.id, name: n.title, cat: n.type || 'concept', deg: 0 }));
    const idSet = new Set(nodes.map(n => n.id));
    const links: SpikeLink[] = raw.edges
      .filter(e => idSet.has(e.sourceId) && idSet.has(e.targetId))
      .map(e => ({ source: e.sourceId, target: e.targetId }));
    const deg = new Map<number, number>();
    links.forEach(l => { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); });
    nodes.forEach(n => { n.deg = deg.get(n.id) || 0; });
    const degs = nodes.map(n => n.deg).sort((a, b) => a - b);
    const p85 = degs[Math.floor(degs.length * 0.85)] ?? 0;
    const p98 = degs[Math.floor(degs.length * 0.98)] ?? 0;

    // ---- 归宫：每个知识节点挂到所属卦位 ----
    const palaceCount = new Array<number>(8).fill(0);
    nodes.forEach(n => {
      const pi = CAT2PALACE[n.cat] ?? 6; // 未识别类别入艮宫（山·库藏）
      n.__palace = TRIGRAMS[pi].pos;
      palaceCount[pi]++;
    });

    // ---- 中枢太极（一生二）+ 八卦枢纽（二生三）----
    const hubId = (i: number) => -(i + 1);
    const taijiNode: SpikeNode = {
      id: -100, name: '太极 · 中枢', cat: 'hub', deg: 0,
      hub: 'taiji', __hub: true, fx: 0, fy: 0, fz: 0,
    };
    const trigramNodes: SpikeNode[] = TRIGRAMS.map((tg, i) => ({
      id: hubId(i), name: `${tg.name} · ${tg.dir}`, cat: 'hub', deg: 0,
      hub: 'trigram', __hub: true, tri: i,
      fx: tg.pos[0] * palaceR, fy: tg.pos[1] * palaceR, fz: tg.pos[2] * palaceR,
    }));
    // 层级连线：太极→八卦（主脉）+ 八卦→知识节点（支脉）
    const coreLinks: SpikeLink[] = trigramNodes.map(t => ({ source: -100, target: t.id, kind: 'core' as const }));
    const palace2hub = new Map<readonly number[], number>();
    TRIGRAMS.forEach((tg, i) => palace2hub.set(tg.pos, hubId(i)));
    const branchLinks: SpikeLink[] = nodes.map(n => ({ source: palace2hub.get(n.__palace!)!, target: n.id, kind: 'branch' as const }));
    const allNodes = [taijiNode, ...trigramNodes, ...nodes];
    const allLinks = [...coreLinks, ...branchLinks, ...links];

    const gold = isDark ? GOLD_DARK : GOLD_LIGHT;
    let disposed = false;
    try {
      const graph = ForceGraph3D<SpikeNode, SpikeLink>()(containerRef.current);
      graphRef.current = graph;
      (window as unknown as { __spikeGraph?: unknown }).__spikeGraph = graph;
      graph
        .backgroundColor('rgba(0,0,0,0)')
        .nodeThreeObject((nd) => {
          if (nd.hub === 'taiji') {
            const s = sphereR * 0.34;
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({
              map: taijiTexture(gold, isDark), transparent: true, depthWrite: false,
            }));
            sp.scale.set(s, s, 1);
            return sp;
          }
          if (nd.hub === 'trigram') {
            const tg = TRIGRAMS[nd.tri!];
            const s = sphereR * 0.24;
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({
              map: trigramTexture(tg.lines, tg.name, tg.dir, gold, isDark), transparent: true, depthWrite: false,
            }));
            sp.scale.set(s, s, 1);
            return sp;
          }
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
        .nodeLabel((nd) => nd.hub === 'taiji'
          ? '太极 · 知识中枢'
          : nd.hub === 'trigram'
            ? `${TRIGRAMS[nd.tri!].name}宫 · ${TRIGRAMS[nd.tri!].dir}（${palaceCount[nd.tri!]} 节点）`
            : `${nd.name} ｜ ${LABELS[nd.cat] || nd.cat}`)
        .warmupTicks(90)
        // 三层连线配色：主脉金亮、支脉极淡金、有机连线蓝调
        .linkColor((l) => {
          if (l.kind === 'core') return isDark ? 'rgba(212,168,83,0.85)' : 'rgba(156,122,46,0.9)';
          if (l.kind === 'branch') return isDark ? 'rgba(212,168,83,0.10)' : 'rgba(156,122,46,0.16)';
          return isDark ? 'rgba(130,170,230,0.28)' : 'rgba(55,82,128,0.5)';
        })
        .linkWidth((l) => (l.kind === 'core' ? 1.6 : l.kind === 'branch' ? 0.3 : isDark ? 0.6 : 0.9))
        .linkOpacity(0.35)
        .linkCurvature((l) => (l.kind ? 0 : 0.12))
        // 递质粒子流：主脉（太极→八卦）金色4粒 —— 能量自中枢流向八方
        .linkDirectionalParticles((l) => (l.kind === 'core' ? 4 : 0))
        .linkDirectionalParticleWidth(2.2)
        .linkDirectionalParticleSpeed(0.006)
        .linkDirectionalParticleColor(() => gold)
        .onNodeClick((nd) => {
          const dist = nd.hub ? 90 : 60;
          const ratio = 1 + dist / Math.hypot(nd.x || 0, nd.y || 0, nd.z || 0);
          graph.cameraPosition(
            { x: (nd.x || 0) * ratio, y: (nd.y || 0) * ratio, z: (nd.z || 0) * ratio },
            nd as never, 1200,
          );
        });

      // ---- 布局力学：分层径向填球 + 宫位成簇（八卦枢纽已钉死）----
      const charge = graph.d3Force('charge') as unknown as { strength: (v: number) => void } | null;
      charge?.strength(-8 * scale * scale);
      const linkF = graph.d3Force('link') as unknown as {
        distance: (fn: (l: SpikeLink) => number) => void;
        strength: (fn: (l: SpikeLink) => number) => void;
      } | null;
      // 层级连线定距定强：主脉钉距、支脉弱牵引、有机连线照旧
      linkF?.distance((l) => (l.kind === 'core' ? palaceR : l.kind === 'branch' ? sphereR * 0.5 : 10 * scale));
      linkF?.strength((l) => (l.kind === 'core' ? 0.9 : l.kind === 'branch' ? 0.05 : 0.3));
      graph.d3Force('x', null as never);
      graph.d3Force('y', null as never);
      graph.d3Force('z', null as never);

      // 分层径向力（tick 驱动节点脉冲呼吸）
      let t = 0;
      graph.d3Force('layered', makeLayeredForce(sphereR, sphereR * 0.72, () => {
        t += 0.016;
        for (const nd of nodes) {
          const sp = nd.__sp;
          if (!sp || nd.__baseSize == null || nd.__phase == null) continue;
          const s = nd.__baseSize * (1 + 0.08 * Math.sin(t * 2.1 + nd.__phase));
          sp.scale.set(s, s, 1);
        }
      }) as never);

      // 灌数据：warmupTicks 在 graphData 调用时同步跑 —— 必须在所有力学配置之后
      graph.graphData({ nodes: allNodes, links: allLinks });

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

      // Bloom（仅深色；阈值 0.75 让金牌不糊、白热核仍发光）
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
        const free = gd.nodes.filter(n => !n.hub);
        const xs = free.map(n => n.x ?? 0), ys = free.map(n => n.y ?? 0), zs = free.map(n => n.z ?? 0);
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
  const gold = isDark ? GOLD_DARK : GOLD_LIGHT;

  return (
    <div style={{ position: 'fixed', inset: 0, top: 48, background: isDark ? '#09090b' : '#eef2f8', transition: 'background 0.4s' }}>
      {/* key=theme：切主题时整棵 DOM 重挂载（旧 WebGL 上下文随旧 canvas 销毁） */}
      <div key={theme} ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {/* HUD */}
      <div style={{ position: 'absolute', left: 18, top: 16, zIndex: 10, color: sub, fontSize: 12, letterSpacing: 0.4, pointerEvents: 'none' }}>
        <b style={{ color: fg, fontSize: 15, display: 'block', marginBottom: 4, letterSpacing: 1.5 }}>
          璇玑 · 太极八卦图（3D 预览）
        </b>
        {graphQuery.data
          ? `${(graphQuery.data as { nodes: unknown[] }).nodes.length} 节点 · 太极生两仪 · 八卦定八方 · 三生万物`
          : '载入中…'}
      </div>
      <div style={{ position: 'absolute', right: 18, top: 16, zIndex: 10, color: sub, fontSize: 12, lineHeight: '22px', background: isDark ? 'rgba(12,14,18,.55)' : 'rgba(255,255,255,.6)', border: `1px solid ${isDark ? 'rgba(120,160,220,.14)' : 'rgba(90,120,160,.2)'}`, borderRadius: 10, padding: '10px 14px', backdropFilter: 'blur(6px)' }}>
        <div style={{ marginBottom: 4 }}>
          <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 7, background: gold, boxShadow: `0 0 8px ${gold}` }} />
          太极中枢 · 八卦宫位
        </div>
        {Object.keys(COLORS).map(c => (
          <div key={c}>
            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 7, background: COLORS[c], boxShadow: `0 0 8px ${COLORS[c]}` }} />
            {LABELS[c]}（{TRIGRAMS[CAT2PALACE[c]].name}宫）
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 18, bottom: 16, zIndex: 10, color: faint, fontSize: 11 }}>
        拖动旋转 · 滚轮缩放 · 悬停看名称 · 点击聚焦 ｜ 金线=层级主脉（粒子流） · 蓝线=有机关联
      </div>
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6b9d', fontSize: 13, zIndex: 20 }}>
          渲染失败：{error}
        </div>
      )}
    </div>
  );
}
