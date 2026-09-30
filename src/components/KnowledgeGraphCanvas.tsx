import { useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';

/**
 * Obsidian Graph View 风格的知识图谱画布（纯 Canvas 2D，零 WebGL 依赖）。
 * 设计稿：obsidian-graph-mockup-v1.html（云霄），按老板反馈调整：
 *  - 标签不常驻：仅悬停/选中时显示（选中节点 + 其邻居）
 *  - 节点带渐变光晕（科技感）
 *  - 去除 3D 模式，仅此一个视图
 */

export interface GraphCanvasNode {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly x: number;
  readonly y: number;
}

export interface GraphCanvasEdge {
  readonly source: string;
  readonly target: string;
  readonly strength: number;
}

export interface KnowledgeGraphCanvasHandle {
  zoomBy: (factor: number) => void;
  /** 平滑聚焦到指定节点（节点须当前可见），返回是否找到 */
  focusNode: (id: string) => boolean;
  /** 复位视图：整图适配视口居中 */
  resetView: () => void;
  /** 导出当前画布为 PNG 并下载 */
  exportPng: () => void;
}

interface KnowledgeGraphCanvasProps {
  readonly nodes: readonly GraphCanvasNode[];
  readonly edges: readonly GraphCanvasEdge[];
  readonly selectedNodeId: string | null;
  /** 连线模式：点击节点回调交给外层判定（创建边 or 选中） */
  readonly edgeMode: boolean;
  readonly viewMode: 'nodes' | 'edges';
  /** 0-100，映射到斥力强度 */
  readonly gravityStrength: number;
  /** 0-100，映射到连线理想长度 */
  readonly nodeSpacing: number;
  readonly categoryColors: Record<string, string>;
  readonly onNodeClick: (id: string | null) => void;
  readonly onNodeContextMenu: (id: string, x: number, y: number) => void;
  /** 拖拽结束后回存全部节点位置（世界坐标） */
  readonly onSavePositions: (positions: Array<{ id: string; x: number; y: number }>) => void;
  /** 画布就绪/数据变化后回调当前可见节点数（用于空态提示等） */
  readonly onStatsChange?: (nodes: number, edges: number) => void;
}

interface SimNode {
  id: string;
  name: string;
  category: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  deg: number;
}

interface SimEdge {
  a: number;
  b: number;
  rest: number;
}

/**
 * 「类脑 / Neural」主题（深空底 + 发光神经元节点 + 聚焦渐变突触 + 景深尘埃）。
 * 参考手法：beautiful-graph（vignette 氛围 + 两层景深尘埃 + 悬停邻域聚焦）、
 * 神经网络/脑图谱可视化（发光核 + 软晕 + 突触连线）。全部为只读常量——调观感只改这里。
 */
const THEME = {
  /** 背景线框球：浅亮蓝、低透明，衬深色底 */
  guideStrong: 'rgba(150,190,235,0.18)',
  guideFaint: 'rgba(150,190,235,0.07)',
  /** 基础边：单色素描线（每帧每边建渐变太贵，1958 条边只给聚焦态做渐变） */
  edgeLine: 'rgba(120,160,220,0.20)',
  edgeLineEmphasis: 'rgba(120,160,220,0.34)',
  edgeDim: 'rgba(120,160,220,0.05)',
  /** 聚焦态边：源→目标 渐变 + 提亮 */
  edgeActive: 0.8,
  /** 标签：深底上用「亮字 + 深色描边光晕」 */
  labelStroke: 'rgba(8,12,20,0.9)',
  labelFill: '#e6edf7',
  /** 景深尘埃：两层（近层稍大稍亮，带视差与微闪） */
  dust: { near: 70, far: 110, nearA: 0.5, farA: 0.22, nearR: 1.5, farR: 0.9, twinkle: 0.16 },
  /** 分类色缺失时的回退色（与 CATEGORY_COLORS.tag 一致） */
  fallbackColor: '#22d3ee',
  /** 尘埃填充色（浅亮蓝白） */
  dustFill: '#cfe3ff',
  /** 导出 PNG 的垫色（与页面深空底一致，不然导出图背景比所见亮） */
  exportPad: '#0a0d14',
  /**
   * 恒星配置：分类 → 恒星演化阶段。
   * 选恒星而非行星的工程理由：行星靠纹理（坑/云带）= 预渲染位图，放大必糊；
   * 恒星 = 平滑光晕 + 炽热星核 + 星芒，全是光滑形状，矢量绘制任意缩放都锐利。
   * glow=光晕半径倍数；spikes=星芒长度倍数；core=星核半径倍数；twinkle=闪烁幅度。
   */
  stars: {
    concept:  { stage: '蓝巨星',   glow: 5.2, spikes: 2.4, core: 1.0,  twinkle: 0.08 },
    document: { stage: '类太阳星', glow: 4.4, spikes: 1.5, core: 1.0,  twinkle: 0.05 },
    topic:    { stage: '红巨星',   glow: 6.4, spikes: 1.7, core: 1.15, twinkle: 0.12 },
    entity:   { stage: '脉冲星',   glow: 4.6, spikes: 3.2, core: 0.8,  twinkle: 0.22 },
    note:     { stage: '白矮星',   glow: 3.1, spikes: 0.8, core: 0.75, twinkle: 0.03 },
    tag:      { stage: '原恒星',   glow: 4.0, spikes: 1.2, core: 0.9,  twinkle: 0.10 },
  } as Record<string, { stage: string; glow: number; spikes: number; core: number; twinkle: number }>,
  /** 星芒/星核的配色常量（173 为指纹哨兵，便于线上 bundle 验证） */
  starSpike: 'rgba(255,255,255,0.6173)',
  starCoreInner: 'rgba(255,255,255,0.95)',
  /** 选中脉冲：周期（毫秒）与半径幅度（世界单位） */
  pulse: { period: 1400, amp: 1.6 },
} as const;

/** hex → rgba（聚焦态边做渐变用；分类色恒为 #rrggbb） */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 景深尘埃点（固定种子：分布稳定，不随重渲染抖动）；屏幕空间坐标，范围 [0,1) */
function makeDust(count: number): { x: number; y: number; p: number }[] {
  let s = 1337;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: count }, () => ({ x: rnd(), y: rnd(), p: rnd() * 6.283 }));
}

/** 物理参数（源自云霄设计稿，按真实 163 节点调过） */
const PHYS = {
  repulsion: 1800,
  repulsionCutoff: 90,
  gravity: 0.003,
  damping: 0.86,
  springK: 0.012,
  springCap: 1.4,
  speedCap: 7,
  heatDecay: 0.992,
  coolThreshold: 0.02,
  /** 球形边界：越界回推强度 */
  boundaryK: 0.02,
  /** 平移惯性衰减 */
  panInertia: 0.94,
  /** 呼吸回温间隔（帧）：冷却后的微动让图保持"活"感 */
  breathEvery: 35,
  breathHeat: 0.7,
} as const;

/** 球形边界半径：随节点数缓慢增长，固定大小、非无限区域 */
function boundsRadius(nodeCount: number): number {
  return 170 + 24 * Math.sqrt(Math.max(nodeCount, 4));
}

const LABEL_FONT = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

/** hex 与 白/黑 混合（星球明暗用；t∈[0,1]，0=原色） */
function mixWith(hex: string, toWhite: boolean, t: number): string {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const target = toWhite ? 255 : 0;
  const m = (c: number) => Math.round(c + (target - c) * t);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

/** 分类色 → 预渲染光晕精灵（radial gradient），避免每帧建渐变 */
function makeGlowSprite(color: string): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, color + 'cc');
  g.addColorStop(0.25, color + '55');
  g.addColorStop(0.6, color + '1a');
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

const KnowledgeGraphCanvas = forwardRef<KnowledgeGraphCanvasHandle, KnowledgeGraphCanvasProps>(
  function KnowledgeGraphCanvas(props, ref) {
    const {
      nodes,
      edges,
      selectedNodeId,
      edgeMode,
      viewMode,
      gravityStrength,
      nodeSpacing,
      categoryColors,
      onNodeClick,
      onNodeContextMenu,
      onSavePositions,
      onStatsChange,
    } = props;

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // ---- 可变模拟状态（ref 持有，避免 react 重渲触发重建） ----
    const simNodes = useRef<SimNode[]>([]);
    const simEdges = useRef<SimEdge[]>([]);
    const idIndex = useRef<Map<string, number>>(new Map());
    const heat = useRef(1);
    const cool = useRef(false);
    const rafId = useRef(0);
    const glowCache = useRef<Map<string, HTMLCanvasElement>>(new Map());
    // 景深尘埃（两层）：初始化一次，固定种子稳定分布
    const dustNear = useRef(makeDust(THEME.dust.near));
    const dustFar = useRef(makeDust(THEME.dust.far));

    // 视口变换
    const tx = useRef(0);
    const ty = useRef(0);
    const scale = useRef(1);
    const fittedOnce = useRef(false);

    // 交互状态
    const hover = useRef(-1);
    const dragNode = useRef(-1);
    const panning = useRef(false);
    const pointer = useRef({ x: 0, y: 0 });
    const panVel = useRef({ x: 0, y: 0 });

    // 选中态联动（动画循环内读取最新值）
    const selectedRef = useRef<string | null>(selectedNodeId);
    useEffect(() => {
      selectedRef.current = selectedNodeId;
    }, [selectedNodeId]);
    const edgeModeRef = useRef(edgeMode);
    useEffect(() => {
      edgeModeRef.current = edgeMode;
    }, [edgeMode]);
    const viewModeRef = useRef(viewMode);
    useEffect(() => {
      viewModeRef.current = viewMode;
    }, [viewMode]);
    const gravityRef = useRef(gravityStrength);
    useEffect(() => {
      gravityRef.current = gravityStrength;
      warm();
    }, [gravityStrength]);
    const spacingRef = useRef(nodeSpacing);
    useEffect(() => {
      spacingRef.current = nodeSpacing;
      warm();
    }, [nodeSpacing]);
    const colorsRef = useRef(categoryColors);
    useEffect(() => {
      colorsRef.current = categoryColors;
    }, [categoryColors]);

    function warm() {
      heat.current = 1;
      cool.current = false;
    }

    const getGlow = useCallback((color: string) => {
      let sprite = glowCache.current.get(color);
      if (!sprite) {
        sprite = makeGlowSprite(color);
        glowCache.current.set(color, sprite);
      }
      return sprite;
    }, []);


    // ---- 数据同步：props.nodes/edges → 模拟状态（保留已有节点位置，新节点撒 centroid 附近） ----
    useEffect(() => {
      const prev = idIndex.current;
      const prevNodes = simNodes.current;
      const nextNodes: SimNode[] = [];
      const nextIndex = new Map<string, number>();

      // 质心（新节点出生在质心附近）
      let cx = 0;
      let cy = 0;
      for (const n of prevNodes) {
        cx += n.x;
        cy += n.y;
      }
      if (prevNodes.length > 0) {
        cx /= prevNodes.length;
        cy /= prevNodes.length;
      }

      nodes.forEach((n) => {
        const oldIdx = prev.get(n.id);
        const old = oldIdx !== undefined ? prevNodes[oldIdx] : undefined;
        nextIndex.set(n.id, nextNodes.length);
        // 位置来源：① 已在模拟中的节点保留原位；② 后端保存的位置；
        // ③ 后端坐标为 (0,0)（未布局过）时随机散开——否则全堆原点、
        //    距离为 0 斥力无方向，布局死锁
        let px: number;
        let py: number;
        if (old) {
          px = old.x;
          py = old.y;
        } else if (Math.abs(n.x) > 0.5 || Math.abs(n.y) > 0.5) {
          px = n.x;
          py = n.y;
        } else {
          px = cx + (Math.random() - 0.5) * 120;
          py = cy + (Math.random() - 0.5) * 120;
        }
        nextNodes.push({
          id: n.id,
          name: n.name,
          category: n.category,
          x: px,
          y: py,
          vx: old?.vx ?? 0,
          vy: old?.vy ?? 0,
          fx: old?.fx ?? null,
          fy: old?.fy ?? null,
          deg: 0,
        });
      });

      const nextEdges: SimEdge[] = [];
      const restBase = 40 - 0; // 由 nodeSpacing 微调（在 step 里读 spacingRef）
      for (const e of edges) {
        const a = nextIndex.get(e.source);
        const b = nextIndex.get(e.target);
        if (a === undefined || b === undefined) continue;
        nextEdges.push({ a, b, rest: restBase + (1 - Math.min(e.strength, 8)) * 2 });
        nextNodes[a].deg++;
        nextNodes[b].deg++;
      }

      simNodes.current = nextNodes;
      simEdges.current = nextEdges;
      idIndex.current = nextIndex;

      // 坐标归一化：后端保存的坐标跨度可能上千像素，直接取景会缩得很小、
      // 节点看不见。把整体布局压缩到 ~800px 世界跨度（Obsidian 稿的尺度），
      // 仅在跨度过大时触发；归一化后的坐标会在下次拖拽时回存后端
      if (nextNodes.length > 1) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nextNodes) {
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x > maxX) maxX = n.x;
          if (n.y > maxY) maxY = n.y;
        }
        const span = Math.max(maxX - minX, maxY - minY);
        if (span > 900) {
          const f = 800 / span;
          const ncx = (minX + maxX) / 2;
          const ncy = (minY + maxY) / 2;
          for (const n of nextNodes) {
            n.x = ncx + (n.x - ncx) * f;
            n.y = ncy + (n.y - ncy) * f;
          }
        }
      }

      warm();
      onStatsChange?.(nextNodes.length, nextEdges.length);
    }, [nodes, edges, onStatsChange]);

    // ---- 视口自适应 ----
    const fitView = useCallback(() => {
      const cv = canvasRef.current;
      if (!cv || simNodes.current.length === 0) return;
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of simNodes.current) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
      // 取景以球形边界为准：容器是固定大小，整球进视口 + 一圈留白
      const ccx = (minX + maxX) / 2;
      const ccy = (minY + maxY) / 2;
      const R = boundsRadius(simNodes.current.length) + 40;
      const bw = Math.max(60, Math.max(maxX - minX + 120, R * 2));
      const bh = Math.max(60, Math.max(maxY - minY + 120, R * 2));
      const s = Math.min(1.6, Math.min(W / bw, H / bh));
      scale.current = s;
      tx.current = W / 2 - ccx * s;
      ty.current = H / 2 - ccy * s;
    }, []);

    // ---- 物理步进 ----
    function step() {
      const ns = simNodes.current;
      const es = simEdges.current;
      const n = ns.length;
      if (n === 0) return;
      const repK = PHYS.repulsion * (0.4 + gravityRef.current / 50);
      const restScale = 0.7 + spacingRef.current / 50;

      let cx = 0;
      let cy = 0;
      for (const nd of ns) {
        cx += nd.x;
        cy += nd.y;
      }
      cx /= n;
      cy /= n;

      // 球形边界半径（固定大小容器；质心即球心）
      const R = boundsRadius(n);

      const cutoff2 = PHYS.repulsionCutoff * PHYS.repulsionCutoff;
      for (let i = 0; i < n; i++) {
        const ni = ns[i];
        if (ni.fx !== null && ni.fy !== null) {
          ni.x = ni.fx;
          ni.y = ni.fy;
          ni.vx = 0;
          ni.vy = 0;
          continue;
        }
        let fx = (cx - ni.x) * PHYS.gravity;
        let fy = (cy - ni.y) * PHYS.gravity;
        // 球形边界：越界节点被按比例推回球内（软墙）
        {
          const bx = ni.x - cx;
          const by = ni.y - cy;
          const bd = Math.sqrt(bx * bx + by * by);
          if (bd > R) {
            const over = bd - R;
            fx -= (bx / bd) * over * PHYS.boundaryK;
            fy -= (by / bd) * over * PHYS.boundaryK;
          }
        }
        for (let j = i + 1; j < n; j++) {
          const nj = ns[j];
          let dx = ni.x - nj.x;
          let dy = ni.y - nj.y;
          const d2 = dx * dx + dy * dy + 0.4;
          if (d2 > cutoff2) continue;
          let f = repK / d2;
          if (f > 2.6) f = 2.6;
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          fx += dx * f;
          fy += dy * f;
          nj.vx -= dx * f;
          nj.vy -= dy * f;
        }
        ni.vx = (ni.vx + fx) * PHYS.damping;
        ni.vy = (ni.vy + fy) * PHYS.damping;
      }
      for (const e of es) {
        const a = ns[e.a];
        const b = ns[e.b];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
        let disp = (d - e.rest * restScale) * PHYS.springK;
        if (disp > PHYS.springCap) disp = PHYS.springCap;
        if (disp < -PHYS.springCap) disp = -PHYS.springCap;
        dx /= d;
        dy /= d;
        a.vx += dx * disp;
        a.vy += dy * disp;
        b.vx -= dx * disp;
        b.vy -= dy * disp;
      }
      for (const nd of ns) {
        if (nd.fx !== null) continue;
        const sp = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy);
        if (sp > PHYS.speedCap) {
          nd.vx *= PHYS.speedCap / sp;
          nd.vy *= PHYS.speedCap / sp;
        }
        nd.x += nd.vx * heat.current;
        nd.y += nd.vy * heat.current;
      }
      heat.current *= PHYS.heatDecay;
      if (heat.current < PHYS.coolThreshold) cool.current = true;
    }

    // ---- 渲染 ----
    function render() {
      const cv = canvasRef.current;
      if (!cv) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = cv.clientWidth;
      const H = cv.clientHeight;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const nowMs = performance.now();

      // 景深尘埃（屏幕空间，在视口变换之前）：远层小且暗、近层稍大且亮，
      // 都跟随平移做轻微视差并微闪 → 深空"活"感；缩放时近层随放大更明显（深度提示）。
      {
        const tw = nowMs / 1000;
        const draw = (pts: { x: number; y: number; p: number }[], base: number, radius: number, parallax: number) => {
          ctx.fillStyle = THEME.dustFill;
          for (const pt of pts) {
            const twinkle = 1 + THEME.dust.twinkle * Math.sin(pt.p + tw * 0.9);
            const a = base * twinkle * Math.min(1.4, 0.6 + scale.current * 0.5);
            ctx.globalAlpha = a;
            const x = pt.x * W + tx.current * parallax;
            const y = pt.y * H + ty.current * parallax;
            ctx.beginPath();
            ctx.arc(x, y, radius * (0.7 + 0.6 * Math.abs(Math.sin(pt.p + tw * 0.5))), 0, 6.283);
            ctx.fill();
          }
        };
        draw(dustFar.current, THEME.dust.farA, THEME.dust.farR, 0.05);
        draw(dustNear.current, THEME.dust.nearA, THEME.dust.nearR, 0.12);
        ctx.globalAlpha = 1;
      }

      ctx.save();
      ctx.translate(tx.current, ty.current);
      ctx.scale(scale.current, scale.current);

      const ns = simNodes.current;
      const es = simEdges.current;

      // 球形边界容器（线框球：外圆 + 两道经纬椭圆弧，暗示球体）
      if (ns.length > 0) {
        let cx = 0;
        let cy = 0;
        for (const nd of ns) {
          cx += nd.x;
          cy += nd.y;
        }
        cx /= ns.length;
        cy /= ns.length;
        const R = boundsRadius(ns.length);
        const lw = 1 / scale.current;
        // 外圆（深空底：浅亮蓝、低透明，衬底不抢戏）
        ctx.strokeStyle = THEME.guideStrong;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, 6.283);
        ctx.stroke();
        // 经线椭圆（竖）
        ctx.strokeStyle = THEME.guideFaint;
        ctx.beginPath();
        ctx.ellipse(cx, cy, R, R * 0.32, 0, 0, 6.283);
        ctx.stroke();
        // 纬线椭圆（横）
        ctx.beginPath();
        ctx.ellipse(cx, cy, R * 0.32, R, 0, 0, 6.283);
        ctx.stroke();
      }

      const sel = selectedRef.current;
      const hov = hover.current;
      const hovId = hov >= 0 ? ns[hov]?.id : undefined;

      // 邻居集合（选中节点 + 悬停节点 各自取邻居）
      const focusId = sel ?? hovId;
      const neighborSet = new Set<number>();
      if (focusId !== undefined) {
        const fi = idIndex.current.get(focusId);
        if (fi !== undefined) {
          neighborSet.add(fi);
          for (const e of es) {
            if (e.a === fi) neighborSet.add(e.b);
            if (e.b === fi) neighborSet.add(e.a);
          }
        }
      }
      const focusing = focusId !== undefined;

      // 连线：非聚焦 = 单色素描线（省渐变开销）；聚焦邻域 = 源→目标 渐变提亮（突触感）
      ctx.lineWidth = 1 / scale.current;
      const edgesEmphasis = viewModeRef.current === 'edges';
      for (const e of es) {
        const a = ns[e.a];
        const b = ns[e.b];
        const active = !focusing || (neighborSet.has(e.a) && neighborSet.has(e.b));
        if (focusing && !active) {
          ctx.strokeStyle = THEME.edgeDim;
        } else if (focusing && active) {
          const ca = colorsRef.current[a.category] ?? THEME.fallbackColor;
          const cb = colorsRef.current[b.category] ?? THEME.fallbackColor;
          const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          g.addColorStop(0, hexToRgba(ca, THEME.edgeActive));
          g.addColorStop(1, hexToRgba(cb, THEME.edgeActive));
          ctx.strokeStyle = g;
        } else {
          ctx.strokeStyle = edgesEmphasis ? THEME.edgeLineEmphasis : THEME.edgeLine;
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // 节点 = 恒星（矢量绘制：光晕精灵 + 星芒 + 炽热星核 —— 全光滑形状，任意缩放都锐利）
      const nodeAlphaBase = edgesEmphasis ? 0.55 : 1;
      for (let i = 0; i < ns.length; i++) {
        const nd = ns[i];
        const color = colorsRef.current[nd.category] ?? THEME.fallbackColor;
        const star = THEME.stars[nd.category] ?? THEME.stars.tag;
        const r = 3.2 + Math.min(3.2, Math.log(1 + nd.deg) * 1.25);
        const isSel = sel === nd.id;
        const isHov = hovId === nd.id;
        const dim = focusing && !neighborSet.has(i);
        // 闪烁：相位用索引做种子，互不同步 → 星海"活"感
        const tw = 1 - star.twinkle + star.twinkle * Math.sin(nowMs / 700 + i * 2.39);
        const alpha = (dim ? 0.10 : 1) * nodeAlphaBase * tw;

        // 光晕（平滑渐变精灵，放大无锯齿）：尺寸随恒星阶段（巨星更大）
        const glowR = r * star.glow * (isSel ? 1.6 : isHov ? 1.3 : 1);
        ctx.globalAlpha = alpha * (isSel ? 1 : isHov ? 0.9 : 0.62);
        ctx.drawImage(getGlow(color), nd.x - glowR, nd.y - glowR, glowR * 2, glowR * 2);

        // 星芒：4 点衍射芒（细长三角形对），矢量绘制 → 缩放不糊；脉冲星芒最长
        if (!dim && star.spikes > 0.5) {
          const L = r * star.spikes * (isHov ? 1.25 : 1) * 3;
          const w = Math.max(0.4 / scale.current, r * 0.10);
          ctx.globalAlpha = alpha * 0.8;
          ctx.fillStyle = THEME.starSpike;
          ctx.beginPath();
          ctx.moveTo(nd.x - L, nd.y); ctx.lineTo(nd.x, nd.y - w); ctx.lineTo(nd.x + L, nd.y); ctx.lineTo(nd.x, nd.y + w);
          ctx.closePath();
          ctx.moveTo(nd.x, nd.y - L); ctx.lineTo(nd.x - w, nd.y); ctx.lineTo(nd.x, nd.y + L); ctx.lineTo(nd.x + w, nd.y);
          ctx.closePath();
          ctx.fill();
        }

        // 炽热星核：近白高温核（色温偏向分类色）+ 纯白内点 —— 两层矢量圆
        const coreR = r * star.core * (isHov ? 1.12 : 1);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = mixWith(color, true, 0.78);
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, coreR * 0.55, 0, 6.283);
        ctx.fill();
        ctx.globalAlpha = alpha * 0.95;
        ctx.fillStyle = THEME.starCoreInner;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, Math.max(0.5 / scale.current, coreR * 0.22), 0, 6.283);
        ctx.fill();

        // 选中：缓转轨道环（保留，作为"选中标记"）
        if (isSel) {
          const phase = (nowMs % THEME.pulse.period) / THEME.pulse.period;
          const orbR = r + 3.5 + Math.sin(phase * 6.283) * THEME.pulse.amp;
          ctx.save();
          ctx.translate(nd.x, nd.y);
          ctx.rotate(-0.42 + phase * 0.5); // 缓转
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = 1.4 / scale.current;
          ctx.beginPath();
          ctx.ellipse(0, 0, orbR * 1.5, orbR * 0.5, 0, 0, 6.283);
          ctx.stroke();
          ctx.globalAlpha = 0.25;
          ctx.beginPath();
          ctx.ellipse(0, 0, (orbR + 2.5) * 1.5, (orbR + 2.5) * 0.5, 0, 0, 6.283);
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;

      // 标签：仅悬停节点 + 选中节点及其邻居（老板要求：不常驻）
      const labelTargets = new Set<number>();
      if (hov >= 0 && hov < ns.length) labelTargets.add(hov);
      if (sel !== null) {
        for (const i of neighborSet) labelTargets.add(i);
      }
      if (labelTargets.size > 0) {
        ctx.font = LABEL_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        for (const i of labelTargets) {
          const nd = ns[i];
          const isPrimary = sel === nd.id || hov === i;
          ctx.globalAlpha = isPrimary ? 0.98 : 0.85;
          ctx.lineWidth = 3 / scale.current;
          // 深底：亮字 + 深色描边光晕（原来白描边 + 深字是浅底方案，已不适配）
          ctx.strokeStyle = THEME.labelStroke;
          ctx.strokeText(nd.name, nd.x + 6, nd.y - 1);
          ctx.fillStyle = THEME.labelFill;
          ctx.fillText(nd.name, nd.x + 6, nd.y - 1);
        }
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }

    // ---- 主循环（含平移惯性 + 呼吸回温） ----
    useEffect(() => {
      let frame = 0;
      const loop = () => {
        frame++;
        // 平移惯性：松手后视图继续滑行并衰减
        if (panVel.current.x !== 0 || panVel.current.y !== 0) {
          tx.current += panVel.current.x;
          ty.current += panVel.current.y;
          panVel.current.x *= PHYS.panInertia;
          panVel.current.y *= PHYS.panInertia;
          if (Math.abs(panVel.current.x) < 0.05 && Math.abs(panVel.current.y) < 0.05) {
            panVel.current = { x: 0, y: 0 };
          }
        }
        // 呼吸：冷却后周期性回温——必须同时注入速度！
        // heat 只是位移乘数（x += v*heat），冷却阶段阻尼早已把 v 耗到 ≈0，
        // 只调 heat 是「给没油的车踩油门」，图不会动。
        if (cool.current && frame % PHYS.breathEvery === 0) {
          heat.current = PHYS.breathHeat;
          cool.current = false;
          for (const nd of simNodes.current) {
            if (nd.fx !== null) continue;
            const a = Math.random() * 6.283;
            const f = 1.5 + Math.random() * 1.5; // 1.5~3.0 px/帧 的明显游动
            nd.vx += Math.cos(a) * f;
            nd.vy += Math.sin(a) * f;
          }
        }
        if (!cool.current) step();
        render();
        rafId.current = requestAnimationFrame(loop);
      };
      rafId.current = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(rafId.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- resize ----
    useEffect(() => {
      const cv = canvasRef.current;
      const container = containerRef.current;
      if (!cv || !container) return;
      const apply = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        cv.width = container.clientWidth * dpr;
        cv.height = container.clientHeight * dpr;
        cv.style.width = `${container.clientWidth}px`;
        cv.style.height = `${container.clientHeight}px`;
        if (!fittedOnce.current && simNodes.current.length > 0) {
          fittedOnce.current = true;
          fitView();
        }
      };
      apply();
      const ro = new ResizeObserver(apply);
      ro.observe(container);
      return () => ro.disconnect();
    }, [fitView]);

    // 首次数据到达时补一次 fit（resize 先于数据的情况）
    useEffect(() => {
      if (!fittedOnce.current && simNodes.current.length > 0) {
        fittedOnce.current = true;
        // 先跑若干步让布局初步成形再取景
        for (let i = 0; i < 40; i++) step();
        fitView();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes.length]);

    // ---- 命中检测 ----
    function hit(clientX: number, clientY: number): number {
      const cv = canvasRef.current;
      if (!cv) return -1;
      const r = cv.getBoundingClientRect();
      const mx = clientX - r.left;
      const my = clientY - r.top;
      const ns = simNodes.current;
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < ns.length; i++) {
        const nd = ns[i];
        const sx = nd.x * scale.current + tx.current;
        const sy = nd.y * scale.current + ty.current;
        const d2 = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
        const hitR = 14 * 14; // 屏幕空间 14px 命中半径（小节点也好点）
        if (d2 < hitR && d2 < bd) {
          bd = d2;
          best = i;
        }
      }
      return best;
    }

    // ---- 指针交互 ----
    useEffect(() => {
      const cv = canvasRef.current;
      if (!cv) return;

      let downX = 0;
      let downY = 0;
      let moved = false;
      // 双指捏合缩放（移动端）：跟踪活动触点
      const activePointers = new Map<number, { x: number; y: number }>();
      let pinchDist = 0;

      const onDown = (e: PointerEvent) => {
        cv.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activePointers.size === 2) {
          // 进入捏合：取消拖拽/平移
          dragNode.current = -1;
          panning.current = false;
          const pts = [...activePointers.values()];
          pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          moved = true;
          return;
        }
        downX = e.clientX;
        downY = e.clientY;
        moved = false;
        panVel.current = { x: 0, y: 0 }; // 抓住即停（打断惯性）
        const h = hit(e.clientX, e.clientY);
        if (h >= 0 && e.button === 0) {
          dragNode.current = h;
          warm();
        } else if (e.button === 0) {
          panning.current = true;
          pointer.current = { x: e.clientX, y: e.clientY };
        }
      };

      const onMove = (e: PointerEvent) => {
        if (activePointers.has(e.pointerId)) {
          activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }
        if (activePointers.size === 2 && pinchDist > 0) {
          // 捏合缩放：以两指中点为锚点
          const pts = [...activePointers.values()];
          const nd2 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          const r = cv.getBoundingClientRect();
          const mx = (pts[0].x + pts[1].x) / 2 - r.left;
          const my = (pts[0].y + pts[1].y) / 2 - r.top;
          const ns2 = Math.min(3.2, Math.max(0.25, scale.current * (nd2 / pinchDist)));
          tx.current = mx - (mx - tx.current) * (ns2 / scale.current);
          ty.current = my - (my - ty.current) * (ns2 / scale.current);
          scale.current = ns2;
          pinchDist = nd2;
          return;
        }
        const nh = hit(e.clientX, e.clientY);
        if (nh !== hover.current) hover.current = nh;
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;

        if (dragNode.current >= 0) {
          const r = cv.getBoundingClientRect();
          const wx = (e.clientX - r.left - tx.current) / scale.current;
          const wy = (e.clientY - r.top - ty.current) / scale.current;
          const nd = simNodes.current[dragNode.current];
          nd.fx = wx;
          nd.fy = wy;
          warm();
        } else if (panning.current) {
          const dx = e.clientX - pointer.current.x;
          const dy = e.clientY - pointer.current.y;
          tx.current += dx;
          ty.current += dy;
          panVel.current = { x: dx, y: dy }; // 记录瞬时速度，松手后惯性滑行
          pointer.current = { x: e.clientX, y: e.clientY };
        }
        cv.style.cursor = nh >= 0 ? 'pointer' : panning.current || dragNode.current >= 0 ? 'grabbing' : 'grab';
      };

      const onUp = (e: PointerEvent) => {
        activePointers.delete(e.pointerId);
        if (activePointers.size < 2) pinchDist = 0;
        if (activePointers.size > 0) return; // 还有触点在，不做点击判定
        const wasDraggingNode = dragNode.current;
        if (dragNode.current >= 0) {
          const nd = simNodes.current[dragNode.current];
          nd.fx = null;
          nd.fy = null;
          dragNode.current = -1;
          warm();
          // 拖拽结束回存位置（静默，失败不影响交互）
          onSavePositions(simNodes.current.map((n) => ({ id: n.id, x: n.x, y: n.y })));
        }
        panning.current = false;
        cv.style.cursor = 'grab';

        // 点击（未移动）才触发选择/连线判定
        if (!moved && e.button === 0) {
          const h = hit(e.clientX, e.clientY);
          if (h >= 0) {
            onNodeClick(simNodes.current[h].id);
          } else if (wasDraggingNode < 0) {
            onNodeClick(null);
          }
        }
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const f = Math.exp(-e.deltaY * 0.0012);
        const ns2 = Math.min(3.2, Math.max(0.25, scale.current * f));
        tx.current = mx - (mx - tx.current) * (ns2 / scale.current);
        ty.current = my - (my - ty.current) * (ns2 / scale.current);
        scale.current = ns2;
      };

      const onCtx = (e: MouseEvent) => {
        e.preventDefault();
        const h = hit(e.clientX, e.clientY);
        if (h >= 0) {
          const r = cv.getBoundingClientRect();
          onNodeContextMenu(simNodes.current[h].id, e.clientX - r.left, e.clientY - r.top);
        }
      };

      cv.addEventListener('pointerdown', onDown);
      cv.addEventListener('pointermove', onMove);
      cv.addEventListener('pointerup', onUp);
      cv.addEventListener('pointercancel', onUp);
      cv.addEventListener('wheel', onWheel, { passive: false });
      cv.addEventListener('contextmenu', onCtx);
      return () => {
        cv.removeEventListener('pointerdown', onDown);
        cv.removeEventListener('pointermove', onMove);
        cv.removeEventListener('pointerup', onUp);
        cv.removeEventListener('pointercancel', onUp);
        cv.removeEventListener('wheel', onWheel);
        cv.removeEventListener('contextmenu', onCtx);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onNodeClick, onNodeContextMenu, onSavePositions]);

    // ---- 对外 API ----
    useImperativeHandle(ref, () => ({
      focusNode(id: string) {
        const i = idIndex.current.get(id);
        const cv = canvasRef.current;
        if (i === undefined || !cv) return false;
        const nd = simNodes.current[i];
        const W = cv.clientWidth;
        const H = cv.clientHeight;
        const targetScale = Math.max(1.15, scale.current);
        // 平滑动画（~450ms ease-out）
        const startTx = tx.current;
        const startTy = ty.current;
        const startScale = scale.current;
        const endTx = W / 2 - nd.x * targetScale;
        const endTy = H / 2 - nd.y * targetScale;
        const t0 = performance.now();
        const animate = (now: number) => {
          const t = Math.min(1, (now - t0) / 450);
          const eased = t * (2 - t);
          tx.current = startTx + (endTx - startTx) * eased;
          ty.current = startTy + (endTy - startTy) * eased;
          scale.current = startScale + (targetScale - startScale) * eased;
          if (t < 1) requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
        return true;
      },
      zoomBy(factor: number) {
        const cv = canvasRef.current;
        if (!cv) return;
        const mx = cv.clientWidth / 2;
        const my = cv.clientHeight / 2;
        const ns2 = Math.min(3.2, Math.max(0.25, scale.current * factor));
        tx.current = mx - (mx - tx.current) * (ns2 / scale.current);
        ty.current = my - (my - ty.current) * (ns2 / scale.current);
        scale.current = ns2;
      },
      resetView() {
        fitView();
      },
      exportPng() {
        const cv = canvasRef.current;
        if (!cv) return;
        // 画布是透明的：导出前垫一层主题底色
        const out = document.createElement('canvas');
        out.width = cv.width;
        out.height = cv.height;
        const octx = out.getContext('2d');
        if (!octx) return;
        octx.fillStyle = THEME.exportPad;
        octx.fillRect(0, 0, out.width, out.height);
        octx.drawImage(cv, 0, 0);
        const link = document.createElement('a');
        link.download = `knowledge-graph-${Date.now()}.png`;
        link.href = out.toDataURL('image/png');
        link.click();
      },
    }));

    return (
      <div ref={containerRef} className="absolute inset-0" style={{ zIndex: 1 }}>
        <canvas ref={canvasRef} style={{ display: 'block', cursor: 'grab' }} />
      </div>
    );
  },
);

export default KnowledgeGraphCanvas;
