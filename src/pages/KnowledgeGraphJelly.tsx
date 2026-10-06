/**
 * 水母星图（实验路由 /jelly）——纯 2D Canvas 神经风知识图谱。
 *
 * 设计来源：用户指定参考 github.com/useroneoneone/neural-vault（水母星图）。
 * 本实现为自研等价手法（未复制其代码）：程序化线框水母 =
 * 脉动伞盖（纬线椭圆 + 经线弧前实后虚）+ 正弦摆动渐变触手 + 伞面星点闪烁。
 *
 * 为什么 2D：用户设备无 GPU，three.js 软渲染卡死；2D Canvas 用数学模拟 3D 观感，
 * 650 节点在任何设备上都能 60fps。布局零力学迭代：
 * 六类别水母椭圆环绕混沌核心，叶子按黄金角叶序螺旋绕所属水母——确定性、免 O(n²)。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { trpc } from '@/providers/trpc';

const TAU = Math.PI * 2;
const GOLDEN = 2.399963229728653; // 黄金角

/** 60° 等距六色（沿用用户定稿色板） */
const COLORS: Record<string, string> = {
  concept: '#5090f8', document: '#45c860', topic: '#f0d020',
  entity: '#f25050', note: '#d070e8', tag: '#30c8c8',
};
const LABELS: Record<string, string> = {
  concept: '概念', document: '文档', topic: '主题',
  entity: '实体', note: '笔记', tag: '标签',
};
const HUBS = Object.keys(COLORS);

interface Leaf {
  id: number; name: string; cat: string; deg: number;
  hx: number; hy: number;       // 所属水母中心
  bx: number; by: number;       // 叶序基础位置（相对水母）
  wx: number; wy: number;       // 世界坐标（含摆动，逐帧更新）
  phase: number; r: number;
  nb: number[];                  // 邻居 id
}
interface Link { a: Leaf; b: Leaf; u: number; speed: number }
interface Hub { key: string; x: number; y: number; s: number; count: number; color: string; phase: number }

/* ── 辉光 sprite 预渲染（一次性，避免逐帧径向渐变）── */
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(color: string): HTMLCanvasElement {
  const hit = glowCache.get(color);
  if (hit) return hit;
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, color);
  g.addColorStop(0.25, color + 'aa');
  g.addColorStop(1, color + '00');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  glowCache.set(color, cv);
  return cv;
}
function drawGlow(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, r: number, a: number) {
  if (a < 0.02 || r < 0.5) return;
  ctx.globalAlpha = Math.min(1, a);
  ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}
function hexA(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/* ── 程序化线框水母 ── */
function drawJelly(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, t: number, ph: number, alpha: number, hl: boolean) {
  if (alpha < 0.02) return;
  const pulse = Math.sin(t * 1.9 + ph);
  const bw = s * (1 + pulse * 0.08), bh = s * 0.8 * (1 - pulse * 0.07);
  drawGlow(ctx, color, x, y - s * 0.2, s * 2.3, alpha * (hl ? 0.55 : 0.32));
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.7;
  // 纬线（5 圈椭圆）
  for (let k = 1; k <= 5; k++) {
    const v = (k / 5) * Math.PI * 0.5, rx = Math.sin(v) * bw;
    ctx.globalAlpha = alpha * (0.16 + k * 0.05);
    ctx.beginPath(); ctx.ellipse(x, y - Math.cos(v) * bh, rx, rx * 0.26, 0, 0, TAU); ctx.stroke();
  }
  // 经线（10 条弧，前实后虚模拟 3D）
  for (let m = 0; m < 10; m++) {
    const u = (m / 10) * TAU + t * 0.35 + ph, front = Math.sin(u);
    ctx.globalAlpha = alpha * (front > 0 ? 0.45 : 0.13);
    ctx.beginPath();
    for (let q = 0; q <= 8; q++) {
      const v = (q / 8) * Math.PI * 0.5;
      const px = x + Math.sin(v) * bw * Math.cos(u), py = y - Math.cos(v) * bh + Math.sin(v) * bw * 0.26 * front;
      if (q) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.stroke();
  }
  // 触手（12 条渐变摆动 + 3 条主触手）
  const tg = ctx.createLinearGradient(0, y, 0, y + s * 2.3);
  tg.addColorStop(0, hexA(color, 0.6)); tg.addColorStop(1, hexA(color, 0));
  ctx.strokeStyle = tg; ctx.globalAlpha = alpha; ctx.lineWidth = 0.6;
  for (let i = 0; i < 12; i++) {
    const u = (i / 12) * TAU + ph, rx = Math.cos(u) * bw * 0.92, ry = Math.sin(u) * bw * 0.24;
    const L = s * (1.5 + 0.5 * Math.sin(i * 1.7 + ph));
    ctx.beginPath(); ctx.moveTo(x + rx, y + ry);
    for (let k = 1; k <= 12; k++) {
      const f = k / 12;
      ctx.lineTo(x + rx * (1 - f * 0.45) + Math.sin(t * 2.4 - f * 6 + i) * f * s * 0.22, y + ry + f * L);
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 3; i++) {
    const ox = (i - 1) * s * 0.18;
    ctx.beginPath(); ctx.moveTo(x + ox, y);
    for (let k = 1; k <= 10; k++) {
      const f = k / 10;
      ctx.lineTo(x + ox + Math.sin(t * 1.8 - f * 5 + i * 2) * f * s * 0.3, y + f * s * 2.0);
    }
    ctx.stroke();
  }
  // 伞面星点闪烁
  for (let i = 0; i < 10; i++) {
    const u = i * 2.39 + ph + t * 0.35, v = ((i * 0.37) % 1) * 1.4 + 0.1;
    const tw = 0.5 + 0.5 * Math.sin(t * 3 + i * 1.3 + ph);
    drawGlow(ctx, '#ffffff', x + Math.sin(v) * bw * Math.cos(u), y - Math.cos(v) * bh + Math.sin(v) * bw * 0.26 * Math.sin(u), 3, alpha * tw * 0.85);
  }
  drawGlow(ctx, color, x, y - bh * 0.35, s * 0.65, alpha * 0.7);
  ctx.globalAlpha = 1;
}

export default function KnowledgeGraphJelly() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const graphQuery = trpc.knowledge.getGraph.useQuery();
  const [selected, setSelected] = useState<Leaf | null>(null);
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const stateRef = useRef<{
    hubs: Hub[]; leaves: Leaf[]; links: Link[];
    cam: { x: number; y: number; k: number };
    hoverHub: Hub | null; hoverLeaf: Leaf | null; sel: Leaf | null;
    drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null;
    leafById: Map<number, Leaf>;
  } | null>(null);

  const select = useCallback((l: Leaf | null) => {
    setSelected(l);
    if (stateRef.current) stateRef.current.sel = l;
  }, []);

  /* ── 数据装配 + 布局 ── */
  useEffect(() => {
    if (!graphQuery.data) return;
    const raw = graphQuery.data as { nodes: { id: number; title: string; type: string }[]; edges: { sourceId: number; targetId: number }[] };
    const byId = new Map<number, Leaf>();
    const counts = new Map<string, number>();
    raw.nodes.forEach(n => counts.set(n.type || 'concept', (counts.get(n.type || 'concept') || 0) + 1));

    // 水母椭圆环绕（世界坐标）
    const Rx = 460, Ry = 300;
    const hubs: Hub[] = HUBS.map((key, i) => {
      const u = (i / HUBS.length) * TAU - Math.PI / 2;
      const count = counts.get(key) || 0;
      return {
        key, x: Math.cos(u) * Rx, y: Math.sin(u) * Ry,
        s: 34 + Math.min(26, Math.sqrt(count) * 1.6),
        count, color: COLORS[key], phase: i * 1.31,
      };
    });
    const hubOf = new Map(hubs.map(h => [h.key, h]));

    // 叶子：黄金角叶序绕所属水母
    const perHubIdx = new Map<string, number>();
    const leaves: Leaf[] = raw.nodes.map(n => {
      const cat = COLORS[n.type] ? n.type : 'concept';
      const hub = hubOf.get(cat)!;
      const idx = perHubIdx.get(cat) || 0;
      perHubIdx.set(cat, idx + 1);
      const rr = 8.5 * Math.sqrt(idx + 2) + hub.s * 0.9;
      const th = idx * GOLDEN;
      const l: Leaf = {
        id: n.id, name: n.title, cat, deg: 0,
        hx: hub.x, hy: hub.y,
        bx: Math.cos(th) * rr, by: Math.sin(th) * rr * 0.72,
        wx: 0, wy: 0, phase: (n.id % 100) / 15.9,
        r: 1.6, nb: [],
      };
      byId.set(l.id, l);
      return l;
    });

    // 连线
    const links: Link[] = [];
    const deg = new Map<number, number>();
    const nb = new Map<number, number[]>();
    raw.edges.forEach(e => {
      const a = byId.get(e.sourceId), b = byId.get(e.targetId);
      if (!a || !b) return;
      deg.set(a.id, (deg.get(a.id) || 0) + 1);
      deg.set(b.id, (deg.get(b.id) || 0) + 1);
      (nb.get(a.id) || nb.set(a.id, []).get(a.id)!).push(b.id);
      (nb.get(b.id) || nb.set(b.id, []).get(b.id)!).push(a.id);
      links.push({ a, b, u: Math.random(), speed: 0.02 + Math.random() * 0.02 });
    });
    leaves.forEach(l => {
      l.deg = deg.get(l.id) || 0;
      l.nb = nb.get(l.id) || [];
      l.r = 1.5 + Math.min(2.2, Math.log(1 + l.deg) * 0.75);
    });

    stateRef.current = {
      hubs, leaves, links, leafById: byId,
      cam: { x: 0, y: 0, k: 0.72 },
      hoverHub: null, hoverLeaf: null, sel: null, drag: null,
    };
  }, [graphQuery.data]);

  /* ── 渲染循环 ── */
  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let W = 0, H = 0, raf = 0, alive = true;
    const dust = Array.from({ length: 150 }, (_, i) => ({
      x: ((i * 733) % 1600) / 1600, y: ((i * 1021) % 1000) / 1000,
      r: 0.4 + ((i * 37) % 10) / 12, ph: i * 0.77, sp: 0.5 + ((i * 13) % 10) / 14,
    }));
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = wrap.clientWidth; H = wrap.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    window.addEventListener('resize', fit);

    let tPrev = performance.now(), fpsAcc = 0, fpsN = 0, fpsT = 0;
    const frame = (now: number) => {
      if (!alive) return;
      const st = stateRef.current;
      const dt = Math.min(50, now - tPrev); tPrev = now;
      const t = now / 1000;
      fpsAcc += 1000 / Math.max(dt, 1); fpsN++; fpsT += dt;
      if (fpsT > 800) { setFps(Math.round(fpsAcc / fpsN)); fpsAcc = 0; fpsN = 0; fpsT = 0; }

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, W, H);

      // 尘埃星点
      for (const d of dust) {
        const a = 0.12 + 0.1 * Math.sin(t * d.sp + d.ph);
        ctx.globalAlpha = Math.max(0.03, a);
        ctx.fillStyle = '#9fc4e8';
        ctx.beginPath(); ctx.arc(d.x * W, d.y * H, d.r, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!st) { raf = requestAnimationFrame(frame); return; }
      const { cam, hubs, leaves, links } = st;
      const k = cam.k;
      const toS = (wx: number, wy: number) => ({ x: (wx - cam.x) * k + W / 2, y: (wy - cam.y) * k + H / 2 });

      // 叶子世界坐标（基础 + 缓慢漂移）
      for (const l of leaves) {
        l.wx = l.hx + l.bx + Math.sin(t * 0.35 + l.phase) * 2.2;
        l.wy = l.hy + l.by + Math.cos(t * 0.28 + l.phase * 1.3) * 1.8;
      }

      // 高亮状态
      const hHub = st.hoverHub, hLeaf = st.hoverLeaf, sel = st.sel;
      const focusLeaf = hLeaf ?? sel;
      const focusIds = focusLeaf ? new Set([focusLeaf.id, ...focusLeaf.nb]) : null;
      const dimAll = !!(hHub || focusLeaf);

      // 中央混沌核心
      const c0 = toS(0, 0);
      drawGlow(ctx, '#7fb8ff', c0.x, c0.y, 110 * k, 0.5);
      ctx.strokeStyle = '#9fd0ff';
      for (let i = 0; i < 3; i++) {
        const u = t * 0.4 + (i * TAU) / 3;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.ellipse(c0.x, c0.y, 52 * k, 52 * k * (0.2 + 0.25 * Math.abs(Math.sin(u))), u * 0.6, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      drawGlow(ctx, '#cfe8ff', c0.x, c0.y, 14 * k, 0.9);

      // 连线（视口裁剪 + 贝塞尔）
      ctx.lineWidth = Math.max(0.4, 0.6 * k);
      for (const lk of links) {
        const A = toS(lk.a.wx, lk.a.wy), B = toS(lk.b.wx, lk.b.wy);
        if ((A.x < -60 && B.x < -60) || (A.x > W + 60 && B.x > W + 60) || (A.y < -60 && B.y < -60) || (A.y > H + 60 && B.y > H + 60)) continue;
        const hit = focusIds ? (focusIds.has(lk.a.id) && focusIds.has(lk.b.id))
          : hHub ? (lk.a.cat === hHub.key || lk.b.cat === hHub.key) : true;
        const baseA = dimAll ? (hit ? 0.55 : 0.04) : 0.09;
        ctx.strokeStyle = hexA(COLORS[lk.a.cat] || COLORS.tag, baseA);
        // 控制点：中点向中心微拉，形成柔和的弧线
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        const cx2 = mx + (c0.x - mx) * 0.16, cy2 = my + (c0.y - my) * 0.16;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(cx2, cy2, B.x, B.y); ctx.stroke();
        // 流光粒子（高亮时加速加亮）
        const sp = hit && dimAll ? lk.speed * 3.2 : lk.speed;
        lk.u = (lk.u + sp * (dt / 16.7)) % 1;
        const u = lk.u, iu = 1 - u;
        const px = iu * iu * A.x + 2 * iu * u * cx2 + u * u * B.x;
        const py = iu * iu * A.y + 2 * iu * u * cy2 + u * u * B.y;
        drawGlow(ctx, COLORS[lk.a.cat] || COLORS.tag, px, py, hit && dimAll ? 5.5 : 3, Math.min(1, baseA * 7));
        // 第二颗粒子错半相位，流光更密
        const u2 = (u + 0.5) % 1, iu2 = 1 - u2;
        drawGlow(ctx, COLORS[lk.b.cat] || COLORS.tag,
          iu2 * iu2 * A.x + 2 * iu2 * u2 * cx2 + u2 * u2 * B.x,
          iu2 * iu2 * A.y + 2 * iu2 * u2 * cy2 + u2 * u2 * B.y,
          hit && dimAll ? 4 : 2.4, Math.min(1, baseA * 6));
      }

      // 叶子
      for (const l of leaves) {
        const p = toS(l.wx, l.wy);
        if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
        const hit = focusIds ? focusIds.has(l.id) : hHub ? l.cat === hHub.key : true;
        const a = dimAll ? (hit ? 1 : 0.1) : 0.85;
        drawGlow(ctx, COLORS[l.cat], p.x, p.y, l.r * k * 2.6, a * 0.5);
        ctx.globalAlpha = a;
        ctx.fillStyle = COLORS[l.cat];
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.8, l.r * k), 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      }

      // 水母
      for (const h of hubs) {
        const p = toS(h.x, h.y);
        const hl = hHub === h;
        const a = dimAll ? (hHub ? (hl ? 1 : 0.22) : 1) : 0.95;
        drawJelly(ctx, p.x, p.y, h.s * k, h.color, t, h.phase, a, hl);
        // 水母标签（常显）
        ctx.font = `600 ${Math.max(10, 12 * Math.min(k, 1.4))}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.lineJoin = 'round'; ctx.lineWidth = 3.5; ctx.strokeStyle = '#05060a';
        const labelY = p.y + h.s * k * 2.1;
        const txt = `${LABELS[h.key]} · ${h.count}`;
        ctx.globalAlpha = a;
        ctx.strokeText(txt, p.x, labelY);
        ctx.fillStyle = h.color;
        ctx.fillText(txt, p.x, labelY);
        ctx.globalAlpha = 1;
      }

      // 叶子标签：聚焦的常显；高倍缩放显示视口内全部
      const showAll = k > 1.7;
      ctx.font = `500 ${Math.max(9, 10.5 * Math.min(k, 1.6))}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = '#05060a';
      for (const l of leaves) {
        const focused = focusIds?.has(l.id);
        if (!focused && !showAll) continue;
        const p = toS(l.wx, l.wy);
        if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) continue;
        const a = focused ? 1 : 0.55;
        const txt = l.name.length > 16 ? l.name.slice(0, 15) + '…' : l.name;
        ctx.globalAlpha = a;
        ctx.strokeText(txt, p.x, p.y + (l.r * k + 4));
        ctx.fillStyle = '#dfe8f5';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(txt, p.x, p.y + (l.r * k + 4));
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', fit); };
  }, []);

  /* ── 交互：悬停 / 拖动平移 / 滚轮缩放 / 点击 ── */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const hitTest = (mx: number, my: number) => {
      const st = stateRef.current;
      if (!st) return { hub: null, leaf: null };
      const { cam, hubs, leaves } = st;
      const rect = cv.getBoundingClientRect();
      const wx = (mx - rect.left - rect.width / 2) / cam.k + cam.x;
      const wy = (my - rect.top - rect.height / 2) / cam.k + cam.y;
      let hub: Hub | null = null;
      for (const h of hubs) {
        if (Math.hypot(wx - h.x, wy - h.y) < h.s * 1.15) { hub = h; break; }
      }
      let leaf: Leaf | null = null, best = 9 / cam.k + 3;
      if (!hub) {
        for (const l of leaves) {
          const d = Math.hypot(wx - l.wx, wy - l.wy);
          if (d < best) { best = d; leaf = l; }
        }
      }
      return { hub, leaf };
    };
    const onMove = (e: PointerEvent) => {
      const st = stateRef.current;
      if (!st) return;
      if (st.drag) {
        const dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) st.drag.moved = true;
        st.cam.x = st.drag.cx - dx / st.cam.k;
        st.cam.y = st.drag.cy - dy / st.cam.k;
        return;
      }
      const { hub, leaf } = hitTest(e.clientX, e.clientY);
      st.hoverHub = hub; st.hoverLeaf = leaf;
      cv.style.cursor = hub || leaf ? 'pointer' : 'grab';
      setHoverInfo(hub ? `${LABELS[hub.key]} · ${hub.count} 节点` : leaf ? leaf.name : null);
    };
    const onDown = (e: PointerEvent) => {
      const st = stateRef.current;
      if (!st) return;
      st.drag = { x: e.clientX, y: e.clientY, cx: st.cam.x, cy: st.cam.y, moved: false };
      cv.setPointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      const st = stateRef.current;
      if (!st) return;
      const wasDrag = st.drag?.moved;
      st.drag = null;
      if (!wasDrag) {
        const { hub, leaf } = hitTest(e.clientX, e.clientY);
        if (leaf) {
          select(leaf);
          // 聚焦相机
          st.cam.x += (leaf.wx - st.cam.x) * 0.7;
          st.cam.y += (leaf.wy - st.cam.y) * 0.7;
          st.cam.k = Math.min(2.2, Math.max(st.cam.k, 1.6));
        } else if (!hub) {
          select(null);
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = stateRef.current;
      if (!st) return;
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2, my = e.clientY - rect.top - rect.height / 2;
      const k0 = st.cam.k;
      const k1 = Math.min(6, Math.max(0.3, k0 * (e.deltaY < 0 ? 1.12 : 0.89)));
      // 以光标为锚缩放
      st.cam.x += (mx / k0 - mx / k1);
      st.cam.y += (my / k0 - my / k1);
      st.cam.k = k1;
    };
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('wheel', onWheel);
    };
  }, [select]);

  const st = stateRef.current;
  const selNeighbors = selected && st
    ? selected.nb.map(id => st.leafById.get(id)).filter((n): n is Leaf => !!n).sort((a, b) => b.deg - a.deg).slice(0, 24)
    : [];

  return (
    <div ref={wrapRef} style={{ position: 'fixed', inset: 0, top: 48, background: '#05060a' }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, touchAction: 'none' }} />
      {/* HUD */}
      <div style={{
        position: 'absolute', top: 14, left: 18, zIndex: 10, pointerEvents: 'none', userSelect: 'none',
        fontFamily: '"Courier New", ui-monospace, monospace', fontSize: 12, lineHeight: 1.7,
        color: '#00a8cc', textShadow: '0 0 8px #00a8cc44',
      }}>
        <div>NODES: {st?.leaves.length ?? 0}</div>
        <div>LINKS: {st?.links.length ?? 0}</div>
        <div>FPS: {fps}</div>
        {hoverInfo && <div style={{ marginTop: 4, color: '#00d4ff', fontSize: 10, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hoverInfo}</div>}
      </div>
      {/* 图例 */}
      <div style={{
        position: 'absolute', top: 14, right: 18, zIndex: 10, fontSize: 11, lineHeight: '20px',
        color: '#9fb4d8', fontFamily: '"Courier New", monospace', textAlign: 'right', pointerEvents: 'none',
      }}>
        {HUBS.map(h => (
          <div key={h}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: COLORS[h], marginRight: 6, boxShadow: `0 0 6px ${COLORS[h]}` }} />
            {LABELS[h]}
          </div>
        ))}
        <div style={{ marginTop: 6, color: '#5a6a80', fontSize: 10 }}>拖动平移 · 滚轮缩放 · 点击节点</div>
      </div>
      {/* 选中节点信息卡 */}
      {selected && (
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 320, zIndex: 20,
          background: 'rgba(5,8,15,0.92)', borderLeft: '1px solid rgba(0,212,255,0.3)',
          backdropFilter: 'blur(8px)', padding: '16px', overflowY: 'auto',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1, fontSize: 15, fontWeight: 700, color: '#e6edf7', fontFamily: '"Courier New", monospace', lineHeight: 1.4, wordBreak: 'break-all' }}>
              {selected.name}
            </div>
            <button onClick={() => select(null)} style={{
              background: 'transparent', border: '1px solid #00d4ff55', borderRadius: 4, cursor: 'pointer',
              color: '#00d4ff', fontSize: 12, padding: '2px 8px', fontFamily: '"Courier New", monospace',
            }}>✕</button>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: '#7f849c', fontFamily: '"Courier New", monospace' }}>
            {LABELS[selected.cat]} · 连接 ×{selected.deg}
          </div>
          {selNeighbors.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, letterSpacing: '0.08em', color: '#00d4ff', marginBottom: 8, fontFamily: '"Courier New", monospace' }}>
                NEIGHBORS ({selected.nb.length})
              </div>
              {selNeighbors.map(n => (
                <div key={n.id} onClick={() => select(n)} style={{
                  padding: '5px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 4, color: '#9fb4d8',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = '#00d4ff18'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                >
                  <span style={{ color: COLORS[n.cat] }}>●</span> {n.name}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
