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

/** 物理参数（源自云霄设计稿，按真实 163 节点调过） */
const PHYS = {
  repulsion: 1800,
  repulsionCutoff: 90,
  gravity: 0.0016,
  damping: 0.86,
  springK: 0.012,
  springCap: 1.4,
  speedCap: 7,
  heatDecay: 0.992,
  coolThreshold: 0.02,
} as const;

const LABEL_FONT = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

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
      const bw = Math.max(60, maxX - minX + 120);
      const bh = Math.max(60, maxY - minY + 120);
      const s = Math.min(1.6, Math.min(W / bw, H / bh));
      scale.current = s;
      tx.current = W / 2 - ((minX + maxX) / 2) * s;
      ty.current = H / 2 - ((minY + maxY) / 2) * s;
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
      ctx.save();
      ctx.translate(tx.current, ty.current);
      ctx.scale(scale.current, scale.current);

      const ns = simNodes.current;
      const es = simEdges.current;
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

      // 连线（1px 视觉恒定）
      ctx.lineWidth = 1 / scale.current;
      const edgesEmphasis = viewModeRef.current === 'edges';
      for (const e of es) {
        const a = ns[e.a];
        const b = ns[e.b];
        const active = !focusing || (neighborSet.has(e.a) && neighborSet.has(e.b));
        ctx.strokeStyle = !focusing
          ? edgesEmphasis
            ? 'rgba(158,190,170,0.34)'
            : 'rgba(158,178,170,0.16)'
          : active
            ? 'rgba(158,190,170,0.55)'
            : 'rgba(120,130,125,0.05)';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // 节点（光晕 + 实心点）
      const nodeAlphaBase = edgesEmphasis ? 0.55 : 1;
      for (let i = 0; i < ns.length; i++) {
        const nd = ns[i];
        const color = colorsRef.current[nd.category] ?? '#7dcfff';
        const r = 3.2 + Math.min(3.2, Math.log(1 + nd.deg) * 1.25);
        const isSel = sel === nd.id;
        const isHov = hovId === nd.id;
        const dim = focusing && !neighborSet.has(i);
        const alpha = (dim ? 0.12 : 1) * nodeAlphaBase;

        // 光晕（渐变精灵）：选中/悬停更大更亮
        const glowR = r * (isSel ? 7 : isHov ? 5.5 : 3.6);
        ctx.globalAlpha = alpha * (isSel ? 0.95 : isHov ? 0.8 : 0.5);
        ctx.drawImage(getGlow(color), nd.x - glowR, nd.y - glowR, glowR * 2, glowR * 2);

        // 实心点
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r + (isHov ? 0.5 : 0), 0, 6.283);
        ctx.fill();

        // 选中白环
        if (isSel) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.2 / scale.current;
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, r + 3.5, 0, 6.283);
          ctx.stroke();
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
          ctx.globalAlpha = isPrimary ? 0.98 : 0.82;
          ctx.lineWidth = 3 / scale.current;
          ctx.strokeStyle = 'rgba(10,10,12,0.6)';
          ctx.strokeText(nd.name, nd.x + 6, nd.y - 1);
          ctx.fillStyle = '#eef2f7';
          ctx.fillText(nd.name, nd.x + 6, nd.y - 1);
        }
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }

    // ---- 主循环 ----
    useEffect(() => {
      const loop = () => {
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

      const onDown = (e: PointerEvent) => {
        cv.setPointerCapture(e.pointerId);
        downX = e.clientX;
        downY = e.clientY;
        moved = false;
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
          tx.current += e.clientX - pointer.current.x;
          ty.current += e.clientY - pointer.current.y;
          pointer.current = { x: e.clientX, y: e.clientY };
        }
        cv.style.cursor = nh >= 0 ? 'pointer' : panning.current || dragNode.current >= 0 ? 'grabbing' : 'grab';
      };

      const onUp = (e: PointerEvent) => {
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
        octx.fillStyle = '#17171a';
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
