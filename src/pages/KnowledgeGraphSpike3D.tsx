/**
 * 3D 图谱工作台（实验路由 /spike3d）——Jarvis 全套装配版。
 *
 * 设计定调（用户 2026-10-04 全选）：以 Obsidian 洁净版为画布，
 * 搬 Jarvis UI 的整套工作台：星爆高亮 + 富信息卡 + HUD 数据角 + Minimap +
 * 搜索过滤 + 侧栏笔记面板 + 设置预设 + 青色皮肤（扫描线/定制滚动条）。
 *
 * 布局力学不变：分层径向力 rᵢ=R·∛(rank/N) 体积填球 + ∛N 规模自适应。
 * 高亮实现学 Jarvis：底图不动，命中邻居的连线切青色（加色叠加的等价物），
 * 非邻居节点/连线压暗 —— 干净不糊。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import { trpc } from '@/providers/trpc';
import { useAppStore } from '@/store/useAppStore';
import { loadSettings, saveSettings, ACCENT_DARK, ACCENT_LIGHT, type SpikeSettings } from './spike3d/presets';
import { Hud, TooltipCard, Minimap, SearchBar, type MiniNode, type CatDef } from './spike3d/widgets';
import { NodeSidebar, SettingsPanel } from './spike3d/panels';

/** 六色等距色相环（60° 间隔）：深空高明度 / 昼白深一度 */
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

/** 硬边实心圆盘纹理（Obsidian 式锐边） */
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

/** 文字标签纹理（描边字，512x128） */
function labelTexture(name: string, isDark: boolean): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 384; cv.height = 96;
  const x = cv.getContext('2d')!;
  const text = name.length > 14 ? name.slice(0, 13) + '…' : name;
  x.font = `600 42px "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.lineWidth = 6;
  x.strokeStyle = isDark ? 'rgba(4,6,11,0.85)' : 'rgba(238,242,248,0.9)';
  x.strokeText(text, 192, 48);
  x.fillStyle = isDark ? '#dbe4f0' : '#334155';
  x.fillText(text, 192, 48);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

/** 分层径向力（体积填球）+ 银河旋涡（差速切向剪切，强度读 ref 可热调） */
interface ForceNode { x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number }
function makeLayeredForce(R: number) {
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
  };
  (force as { initialize?: (nodes: ForceNode[]) => void }).initialize = (nodes) => {
    const sorted = [...nodes].sort((a, b) =>
      ((a as { index?: number }).index ?? 0) - ((b as { index?: number }).index ?? 0));
    const N = sorted.length;
    targets = new Map(sorted.map((n, i) => [n, R * Math.cbrt((i + 0.5) / N)]));
  };
  return force;
}
function makeSwirlForce(strengthRef: { current: number }) {
  const force = () => {
    const s = strengthRef.current;
    if (s <= 0) return;
    for (const [n] of swirlNodesRef) {
      const rx = n.x ?? 0, rz = n.z ?? 0;
      const r = Math.hypot(rx, rz);
      if (r < 1) continue;
      const k = s * 0.02;
      n.vx = (n.vx ?? 0) + (-rz / r) * k;
      n.vz = (n.vz ?? 0) + (rx / r) * k;
    }
  };
  let swirlNodesRef: Map<ForceNode, true> = new Map();
  (force as { initialize?: (nodes: ForceNode[]) => void }).initialize = (nodes) => {
    swirlNodesRef = new Map(nodes.map(n => [n, true]));
  };
  return force;
}

/** 检测 WebGL 软渲染（SwiftShader/llvmpipe/Software）——无 GPU 设备自动进低功耗模式 */
function detectSoftwareGL(): boolean {
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
    if (!gl) return true;
    const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!ext) return false;
    const renderer = String((gl as WebGLRenderingContext).getParameter(ext.UNMASKED_RENDERER_WEBGL));
    return /swiftshader|llvmpipe|software|angle \(google/i.test(renderer);
  } catch { return false; }
}

export interface SpikeNode extends MiniNode {
  __sp?: THREE.Sprite; __label?: THREE.Sprite;
  __origBase?: number; __catOn?: boolean;
}
export interface SpikeLink { source: number | SpikeNode; target: number | SpikeNode }
type Graph3D = ReturnType<typeof ForceGraph3D<SpikeNode, SpikeLink>>;

export default function KnowledgeGraphSpike3D() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph3D | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useAppStore(s => s.theme);
  const isDark = theme === 'dark';
  const graphQuery = trpc.knowledge.getGraph.useQuery();

  const [settings, setSettings] = useState<SpikeSettings>(loadSettings);
  const [nodes, setNodes] = useState<SpikeNode[]>([]);
  const [linkCount, setLinkCount] = useState(0);
  const [graphReady, setGraphReady] = useState(0);
  const [simStable, setSimStable] = useState(false);
  const [hoverNode, setHoverNode] = useState<SpikeNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<SpikeNode | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [catFilter, setCatFilter] = useState<Set<string>>(() => new Set(Object.keys(LABELS)));
  const [camPos, setCamPos] = useState<{ x: number; y: number; z: number } | null>(null);
  const [lowSpec] = useState(detectSoftwareGL);

  // 热调引用（不触发重建）
  const paramsRef = useRef({ scale: 1, sphereR: 93 });
  const swirlRef = useRef(0);
  const labelCutRef = useRef(0);
  const hlRef = useRef<{ ids: Set<number>; active: boolean }>({ ids: new Set(), active: false });
  const neighborsRef = useRef<Map<number, Set<number>>>(new Map());
  const degSortedRef = useRef<number[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const accentRef = useRef(ACCENT_DARK);

  const COLORS = isDark ? PALETTE.dark : PALETTE.light;
  const accent = isDark ? ACCENT_DARK : ACCENT_LIGHT;
  accentRef.current = accent;

  /* ── 视觉状态统一应用（类别过滤 + 星爆高亮叠加）── */
  const applyVisualStates = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    const { ids, active } = hlRef.current;
    const gd = g.graphData() as { nodes: SpikeNode[] } | null;
    if (!gd?.nodes) return;
    for (const n of gd.nodes) {
      const catOn = n.__catOn !== false;
      let op = catOn ? 1 : 0.06;
      if (active && catOn) op = ids.has(n.id) ? 1 : 0.12;
      if (n.__sp) (n.__sp.material as THREE.SpriteMaterial).opacity = op;
      if (n.__label) (n.__label.material as THREE.SpriteMaterial).opacity = op * 0.95;
    }
    // 连线重刷（linkColor/linkWidth 闭包读 hlRef + __catOn）
    g.linkColor(g.linkColor());
    g.linkWidth(g.linkWidth());
  }, []);

  /* ── 图初始化（数据/主题变化时重建）── */
  useEffect(() => {
    if (!containerRef.current || !graphQuery.data) return;
    const raw = graphQuery.data as { nodes: { id: number; title: string; type: string }[]; edges: { sourceId: number; targetId: number }[] };
    const ns: SpikeNode[] = raw.nodes.map(n => ({ id: n.id, name: n.title, cat: n.type || 'concept', deg: 0, __catOn: true }));
    const idSet = new Set(ns.map(n => n.id));
    const ls: SpikeLink[] = raw.edges
      .filter(e => idSet.has(e.sourceId) && idSet.has(e.targetId))
      .map(e => ({ source: e.sourceId, target: e.targetId }));
    const deg = new Map<number, number>();
    const nb = new Map<number, Set<number>>();
    ls.forEach(l => {
      const s = l.source as number, t = l.target as number;
      deg.set(s, (deg.get(s) || 0) + 1);
      deg.set(t, (deg.get(t) || 0) + 1);
      if (!nb.has(s)) nb.set(s, new Set());
      if (!nb.has(t)) nb.set(t, new Set());
      nb.get(s)!.add(t); nb.get(t)!.add(s);
    });
    ns.forEach(n => { n.deg = deg.get(n.id) || 0; });
    neighborsRef.current = nb;
    degSortedRef.current = ns.map(n => n.deg).sort((a, b) => a - b);

    const N = ns.length;
    const scale = Math.cbrt(N / 100);
    const sphereR = 50 * scale;
    paramsRef.current = { scale, sphereR };
    setSimStable(false);

    let disposed = false;
    try {
      const graph = ForceGraph3D<SpikeNode, SpikeLink>()(containerRef.current);
      graphRef.current = graph;
      (window as unknown as { __spikeGraph?: unknown }).__spikeGraph = graph;
      graph
        .backgroundColor('rgba(0,0,0,0)')
        .nodeThreeObject((nd) => {
          const orig = 3.2 + Math.min(2.2, Math.log(1 + nd.deg) * 0.9);
          nd.__origBase = orig;
          const base = orig * settingsRef.current.nodeSize;
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(COLORS[nd.cat] || COLORS.tag, isDark),
            transparent: true, depthWrite: false,
          }));
          sprite.scale.set(base, base, 1);
          nd.__sp = sprite;
          const label = new THREE.Sprite(new THREE.SpriteMaterial({
            transparent: true, depthWrite: false, opacity: 0.95,
          }));
          label.scale.set(11, 2.75, 1);
          label.position.set(0, -(base / 2 + 1.9), 0);
          label.visible = false;
          nd.__label = label;
          const group = new THREE.Group();
          group.add(sprite, label);
          return group;
        })
        .warmupTicks(lowSpec ? 0 : 45)
        .cooldownTicks(lowSpec ? 300 : Infinity)
        .linkColor((l) => {
          const s = l.source as SpikeNode, t = l.target as SpikeNode;
          const { ids, active } = hlRef.current;
          const ac = accentRef.current;
          if (active) {
            const hit = ids.has(s.id) && ids.has(t.id);
            return hit ? ac : (isDark ? 'rgba(148,163,184,0.05)' : 'rgba(100,116,139,0.06)');
          }
          if (s.__catOn === false || t.__catOn === false) return isDark ? 'rgba(148,163,184,0.04)' : 'rgba(100,116,139,0.05)';
          return isDark ? 'rgba(148,163,184,0.4)' : 'rgba(100,116,139,0.5)';
        })
        .linkWidth((l) => {
          const s = l.source as SpikeNode, t = l.target as SpikeNode;
          const { ids, active } = hlRef.current;
          if (active && ids.has(s.id) && ids.has(t.id)) return 0.9;
          return 0.25;
        })
        .linkOpacity(0.5)
        .linkCurvature(lowSpec ? 0 : settingsRef.current.curvature)
        .onNodeHover((nd) => {
          setHoverNode(nd ?? null);
          if (nd) {
            const ids = new Set<number>([nd.id, ...(neighborsRef.current.get(nd.id) ?? [])]);
            hlRef.current = { ids, active: true };
          } else {
            hlRef.current = { ids: new Set(), active: false };
          }
          applyVisualStates();
        })
        .onNodeClick((nd) => {
          setSelectedNode(nd);
          const dist = 60;
          const ratio = 1 + dist / Math.hypot(nd.x || 0, nd.y || 0, nd.z || 0);
          graph.cameraPosition(
            { x: (nd.x || 0) * ratio, y: (nd.y || 0) * ratio, z: (nd.z || 0) * ratio },
            nd as never, 1200,
          );
        });

      // 布局力学
      const charge = graph.d3Force('charge') as unknown as { strength: (v: number) => void } | null;
      charge?.strength(-settingsRef.current.charge * scale * scale);
      const linkF = graph.d3Force('link') as unknown as {
        distance: (v: number) => void; strength: (v: number) => void;
      } | null;
      linkF?.distance(settingsRef.current.linkDist * scale);
      linkF?.strength(0.1);
      graph.d3Force('x', null as never);
      graph.d3Force('y', null as never);
      graph.d3Force('z', null as never);
      graph.d3Force('layered', makeLayeredForce(sphereR) as never);
      graph.d3Force('swirl', makeSwirlForce(swirlRef) as never);
      swirlRef.current = settingsRef.current.swirl;

      // 标签常显分位
      const pct = settingsRef.current.labelPct;
      labelCutRef.current = degSortedRef.current[Math.floor(degSortedRef.current.length * (1 - pct / 100))] ?? 0;

      graph.graphData({ nodes: ns, links: ls });

      // 标签纹理 idle 分批填充：先出图，文字后台渐进出现
      {
        let li = 0;
        const fillBatch = () => {
          if (disposed) return;
          const end = Math.min(li + 60, ns.length);
          for (; li < end; li++) {
            const lb = ns[li].__label;
            if (lb) (lb.material as THREE.SpriteMaterial).map = labelTexture(ns[li].name, isDark);
          }
          (lb_needsUpdate(ns, li - 1));
          if (li < ns.length) scheduleIdle(fillBatch);
        };
        const lb_needsUpdate = (arr: SpikeNode[], upto: number) => {
          for (let i = Math.max(0, upto - 59); i <= upto && i < arr.length; i++) {
            const lb = arr[i].__label;
            if (lb) (lb.material as THREE.SpriteMaterial).needsUpdate = true;
          }
        };
        const scheduleIdle = (fn: () => void) => {
          const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
          if (ric) ric(fn, { timeout: 120 }); else setTimeout(fn, 16);
        };
        scheduleIdle(fillBatch);
      }

      // 标签距离门控（Obsidian 拉近出字）：
      // 布局期挂 onEngineTick；引擎停转后由相机 change 事件接管（低功耗模式关键）
      const labelDist = sphereR * 1.1;
      const gateLabels = () => {
        const cam = graph.cameraPosition();
        for (const nd of ns) {
          const lb = nd.__label;
          if (!lb) continue;
          if (nd.deg >= labelCutRef.current) { lb.visible = nd.__catOn !== false; continue; }
          const d = Math.hypot((nd.x ?? 0) - cam.x, (nd.y ?? 0) - cam.y, (nd.z ?? 0) - cam.z);
          lb.visible = nd.__catOn !== false && d < labelDist;
        }
      };
      graph.onEngineTick(gateLabels);
      (graph.controls() as unknown as { addEventListener: (t: string, cb: () => void) => void })
        .addEventListener('change', gateLabels);

      graph.renderer().setPixelRatio(lowSpec ? 1 : Math.min(window.devicePixelRatio || 1, 2));
      const ctl = graph.controls() as { autoRotate: boolean; autoRotateSpeed: number };
      ctl.autoRotate = !lowSpec;
      ctl.autoRotateSpeed = settingsRef.current.autoRotate;
      setTimeout(() => {
        if (disposed) return;
        const gd = graph.graphData() as { nodes: SpikeNode[] };
        const xs = gd.nodes.map(n => n.x ?? 0), ys = gd.nodes.map(n => n.y ?? 0), zs = gd.nodes.map(n => n.z ?? 0);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const dim = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs), 1);
        graph.cameraPosition({ x: cx, y: cy + dim * 0.42, z: cz + dim * 1.3 }, { x: cx, y: cy, z: cz } as never, 1200);
      }, 1200);
      setTimeout(() => { if (!disposed) setSimStable(true); }, 2600);
      (graph as unknown as { onEngineStop: (cb: () => void) => void }).onEngineStop(() => {
        if (!disposed) setSimStable(true);
      });

      setNodes(ns);
      setLinkCount(ls.length);
      setGraphReady(r => r + 1);
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    }

    return () => {
      disposed = true;
      (graphRef.current as unknown as { _destructor?: () => void })?._destructor?.();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphQuery.data, isDark]);

  /* ── 设置热应用（不重建图）── */
  useEffect(() => {
    const g = graphRef.current;
    if (!g || graphReady === 0) return;
    saveSettings(settings);
    const { scale } = paramsRef.current;
    const charge = g.d3Force('charge') as unknown as { strength: (v: number) => void } | null;
    charge?.strength(-settings.charge * scale * scale);
    const linkF = g.d3Force('link') as unknown as { distance: (v: number) => void } | null;
    linkF?.distance(settings.linkDist * scale);
    g.linkCurvature(settings.curvature);
    const ctl = g.controls() as { autoRotateSpeed: number };
    ctl.autoRotateSpeed = settings.autoRotate;
    swirlRef.current = settings.swirl;
    labelCutRef.current = degSortedRef.current[Math.floor(degSortedRef.current.length * (1 - settings.labelPct / 100))] ?? 0;
    const gd = g.graphData() as { nodes: SpikeNode[] } | null;
    for (const n of gd?.nodes ?? []) {
      if (n.__origBase == null || !n.__sp) continue;
      const b = n.__origBase * settings.nodeSize;
      n.__sp.scale.set(b, b, 1);
      n.__label?.position.set(0, -(b / 2 + 1.9), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, graphReady]);

  /* ── 类别过滤应用 ── */
  useEffect(() => {
    for (const n of nodes) n.__catOn = catFilter.has(n.cat);
    applyVisualStates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catFilter, nodes]);

  /* ── Minimap 相机位置轮询 ── */
  useEffect(() => {
    const iv = setInterval(() => {
      const g = graphRef.current;
      if (g) {
        const c = g.cameraPosition();
        setCamPos({ x: c.x, y: c.y, z: c.z });
      }
    }, 500);
    return () => clearInterval(iv);
  }, []);

  const focusNode = useCallback((n: MiniNode) => {
    const g = graphRef.current;
    if (!g) return;
    setSelectedNode(n as SpikeNode);
    const dist = 60;
    const ratio = 1 + dist / Math.hypot(n.x || 0, n.y || 0, n.z || 0);
    g.cameraPosition(
      { x: (n.x || 0) * ratio, y: (n.y || 0) * ratio, z: (n.z || 0) * ratio },
      n as never, 1200,
    );
  }, []);

  const toggleCat = useCallback((k: string) => {
    setCatFilter(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  const cats: CatDef[] = Object.keys(LABELS).map(k => ({ key: k, label: LABELS[k], color: COLORS[k] }));
  const visibleCount = nodes.filter(n => catFilter.has(n.cat)).length;
  const neighborsOfSelected = selectedNode
    ? [...(neighborsRef.current.get(selectedNode.id) ?? [])]
        .map(id => nodes.find(n => n.id === id))
        .filter((n): n is SpikeNode => n != null)
        .sort((a, b) => b.deg - a.deg)
    : [];

  return (
    <div
      style={{ position: 'fixed', inset: 0, top: 48, background: isDark ? '#000000' : '#eef2f8', transition: 'background 0.4s' }}
      onMouseMove={(e) => setMouse({ x: e.clientX, y: e.clientY })}
    >
      <style>{`
        .spike3d-scroll::-webkit-scrollbar { width: 5px; }
        .spike3d-scroll::-webkit-scrollbar-track { background: ${isDark ? '#101426' : '#e8edf4'}; border-radius: 5px; }
        .spike3d-scroll::-webkit-scrollbar-thumb { background: ${isDark ? '#45475a' : '#b6c2d2'}; border-radius: 5px; }
        .spike3d-scroll::-webkit-scrollbar-thumb:hover { background: ${accent}; box-shadow: 0 0 6px ${accent}88; }
        .spike3d-root input[type="range"] { appearance: none; -webkit-appearance: none; height: 4px; border-radius: 2px; background: ${isDark ? '#1a3a4a' : '#c8d4e0'}; outline: none; }
        .spike3d-root input[type="range"]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: ${accent}; cursor: pointer; border: 2px solid ${isDark ? '#000' : '#fff'}; }
        .spike3d-root input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: ${accent}; cursor: pointer; border: 2px solid ${isDark ? '#000' : '#fff'}; }
      `}</style>
      <div className="spike3d-root" style={{ position: 'absolute', inset: 0 }}>
        <div key={theme} ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

        {/* 加载遮罩：图初始化期间先给反馈（标签纹理已 idle 懒加载，遮罩一闪而过） */}
        {graphReady === 0 && !error && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 35, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 14,
            background: isDark ? '#000000' : '#eef2f8',
            fontFamily: '"Courier New", ui-monospace, monospace',
          }}>
            <div style={{
              width: 42, height: 42, borderRadius: '50%',
              border: `2px solid ${isDark ? 'rgba(0,212,255,0.15)' : 'rgba(14,138,168,0.2)'}`,
              borderTopColor: accent, animation: 'spike3d-spin 0.9s linear infinite',
            }} />
            <div style={{ fontSize: 12, letterSpacing: '0.12em', color: accent }}>
              LOADING GRAPH…
            </div>
            <style>{`@keyframes spike3d-spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* CRT 扫描线（深色 + 开关） */}
        {isDark && settings.scanlines && (
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 40,
            background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,212,255,0.015) 2px, rgba(0,212,255,0.015) 4px)',
          }} />
        )}

        <Hud
          nodeCount={nodes.length} linkCount={linkCount} visibleCount={visibleCount}
          simStable={simStable} breadcrumb={(hoverNode ?? selectedNode)?.name ?? null} isDark={isDark}
          lowSpec={lowSpec}
        />
        <SearchBar
          nodes={nodes} cats={cats} catFilter={catFilter}
          onToggleCat={toggleCat} onPick={focusNode} isDark={isDark}
        />
        <SettingsPanel settings={settings} onChange={setSettings} isDark={isDark} />
        <Minimap
          nodes={nodes} camPos={camPos} isDark={isDark}
          onNavigate={(x, z) => {
            const g = graphRef.current;
            if (g) g.cameraPosition({ x, y: (camPos?.y ?? 100) * 0.6, z: z + 60 }, { x, y: 0, z } as never, 900);
          }}
        />
        <NodeSidebar
          node={selectedNode} neighbors={neighborsOfSelected}
          onClose={() => setSelectedNode(null)} onNavigate={focusNode} isDark={isDark}
        />
        <TooltipCard
          data={hoverNode ? {
            name: hoverNode.name, catLabel: LABELS[hoverNode.cat] || hoverNode.cat,
            deg: hoverNode.deg, color: COLORS[hoverNode.cat] || COLORS.tag,
          } : null}
          x={mouse.x} y={mouse.y} isDark={isDark}
        />
        {error && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6b9d', fontSize: 13, zIndex: 50 }}>
            渲染失败：{error}
          </div>
        )}
      </div>
    </div>
  );
}
