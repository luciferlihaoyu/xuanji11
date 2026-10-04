/**
 * spike3d 工作台组件（HUD / Tooltip / Minimap / SearchBar）。
 * 设计语言学 Jarvis UI：mono HUD、黑底青边信息卡、角落小地图、顶部搜索。
 */
import { useEffect, useRef, useState } from 'react';
import { ACCENT_DARK, ACCENT_LIGHT } from './presets';

export interface MiniNode {
  id: number; name: string; cat: string; deg: number;
  x?: number; y?: number; z?: number;
}

/* ── HUD 数据角 ─────────────────────────────────────────────── */
export function Hud({ nodeCount, linkCount, visibleCount, simStable, breadcrumb, isDark }: {
  nodeCount: number; linkCount: number; visibleCount: number;
  simStable: boolean; breadcrumb: string | null; isDark: boolean;
}) {
  const [fps, setFps] = useState(0);
  const timesRef = useRef<number[]>([]);
  const lastRef = useRef(performance.now());
  useEffect(() => {
    let raf: number;
    const tick = () => {
      const now = performance.now();
      timesRef.current.push(now - lastRef.current);
      lastRef.current = now;
      if (timesRef.current.length > 60) timesRef.current.shift();
      const avg = timesRef.current.reduce((a, b) => a + b, 1) / timesRef.current.length;
      setFps(Math.round(1000 / avg));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const accent = isDark ? ACCENT_DARK : ACCENT_LIGHT;
  return (
    <div style={{
      position: 'absolute', top: 16, left: 18, zIndex: 10, pointerEvents: 'none', userSelect: 'none',
      fontFamily: '"Courier New", ui-monospace, monospace', fontSize: 12, lineHeight: 1.7,
      color: isDark ? '#00a8cc' : '#0e7a96', textShadow: isDark ? '0 0 8px #00a8cc44' : 'none',
    }}>
      <div>NODES: {nodeCount}</div>
      <div>VISIBLE: {visibleCount}</div>
      <div>LINKS: {linkCount}</div>
      <div>FPS: {fps}</div>
      <div style={{ marginTop: 4, color: simStable ? accent : '#ff6b35' }}>
        {simStable ? '■ SIM STABLE' : '◌ SIMULATING'}
      </div>
      {breadcrumb && (
        <div style={{ marginTop: 4, color: accent, fontSize: 10, letterSpacing: '0.06em', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {breadcrumb}
        </div>
      )}
    </div>
  );
}

/* ── 富信息卡 Tooltip ───────────────────────────────────────── */
export interface TooltipData { name: string; catLabel: string; deg: number; color: string }
export function TooltipCard({ data, x, y, isDark }: { data: TooltipData | null; x: number; y: number; isDark: boolean }) {
  if (!data) return null;
  const W = 240;
  let left = x + 14;
  let top = y + 14;
  if (left + W > window.innerWidth - 20) left = x - W - 14;
  if (top > window.innerHeight - 120) top = y - 90;
  const accent = isDark ? ACCENT_DARK : ACCENT_LIGHT;
  return (
    <div style={{
      position: 'fixed', left, top, zIndex: 30, pointerEvents: 'none', maxWidth: W,
      background: isDark ? 'rgba(0,0,0,0.88)' : 'rgba(255,255,255,0.95)',
      border: `1px solid ${accent}`, borderRadius: 4, padding: '8px 10px',
      boxShadow: `0 0 12px ${accent}33`,
      fontFamily: '"Courier New", ui-monospace, monospace', fontSize: 12,
      color: isDark ? '#cdd6f4' : '#334155',
    }}>
      <div style={{ color: accent, fontWeight: 'bold', fontSize: 13, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {data.name}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: 0.85 }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: data.color }} />
        <span>{data.catLabel}</span>
        <span style={{ marginLeft: 'auto', color: isDark ? '#7f849c' : '#94a3b8' }}>连接 ×{data.deg}</span>
      </div>
    </div>
  );
}

/* ── Minimap 小地图（XZ 俯视投影 + 点击导航）────────────────── */
const MM_W = 180, MM_H = 120, MM_PAD = 8;
export function Minimap({ nodes, camPos, isDark, onNavigate }: {
  nodes: MiniNode[];
  camPos: { x: number; y: number; z: number } | null;
  isDark: boolean;
  onNavigate: (x: number, z: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const boundsRef = useRef({ minX: 0, rangeX: 1, minZ: 0, rangeZ: 1 });
  useEffect(() => {
    const cv = ref.current;
    if (!cv || nodes.length === 0) return;
    const x = cv.getContext('2d');
    if (!x) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of nodes) {
      const nx = n.x ?? 0, nz = n.z ?? 0;
      if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
      if (nz < minZ) minZ = nz; if (nz > maxZ) maxZ = nz;
    }
    const rangeX = maxX - minX || 1, rangeZ = maxZ - minZ || 1;
    boundsRef.current = { minX, rangeX, minZ, rangeZ };
    const toC = (wx: number, wz: number) => ({
      cx: MM_PAD + ((wx - minX) / rangeX) * (MM_W - MM_PAD * 2),
      cy: MM_PAD + ((wz - minZ) / rangeZ) * (MM_H - MM_PAD * 2),
    });
    x.clearRect(0, 0, MM_W, MM_H);
    x.fillStyle = isDark ? 'rgba(10,15,30,0.85)' : 'rgba(255,255,255,0.85)';
    x.fillRect(0, 0, MM_W, MM_H);
    for (const n of nodes) {
      const { cx, cy } = toC(n.x ?? 0, n.z ?? 0);
      x.fillStyle = isDark ? 'rgba(0,212,255,0.5)' : 'rgba(14,138,168,0.55)';
      x.fillRect(cx - 1, cy - 1, 2, 2);
    }
    if (camPos) {
      const { cx, cy } = toC(camPos.x, camPos.z);
      x.strokeStyle = isDark ? ACCENT_DARK : ACCENT_LIGHT;
      x.lineWidth = 1.5;
      x.beginPath(); x.arc(cx, cy, 5, 0, Math.PI * 2); x.stroke();
      const { cx: tx, cy: ty } = toC(0, 0);
      x.beginPath(); x.moveTo(cx, cy); x.lineTo(tx, ty); x.globalAlpha = 0.4; x.stroke(); x.globalAlpha = 1;
    }
  }, [nodes, camPos, isDark]);
  return (
    <canvas
      ref={ref}
      width={MM_W}
      height={MM_H}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const { minX, rangeX, minZ, rangeZ } = boundsRef.current;
        const wx = minX + ((e.clientX - r.left - MM_PAD) / (MM_W - MM_PAD * 2)) * rangeX;
        const wz = minZ + ((e.clientY - r.top - MM_PAD) / (MM_H - MM_PAD * 2)) * rangeZ;
        onNavigate(wx, wz);
      }}
      style={{
        position: 'absolute', right: 18, bottom: 16, zIndex: 10, cursor: 'crosshair',
        border: `1px solid ${isDark ? 'rgba(0,212,255,0.35)' : 'rgba(14,138,168,0.4)'}`,
        borderRadius: 4, boxShadow: isDark ? '0 0 10px #00d4ff22' : '0 2px 8px rgba(0,0,0,0.12)',
      }}
    />
  );
}

/* ── 搜索栏 + 类别过滤 ──────────────────────────────────────── */
export interface CatDef { key: string; label: string; color: string }
export function SearchBar({ nodes, cats, catFilter, onToggleCat, onPick, isDark }: {
  nodes: MiniNode[];
  cats: CatDef[];
  catFilter: Set<string>;
  onToggleCat: (k: string) => void;
  onPick: (n: MiniNode) => void;
  isDark: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const matches = q.trim()
    ? nodes.filter(n => n.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)
    : [];
  const accent = isDark ? ACCENT_DARK : ACCENT_LIGHT;
  const bg = isDark ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
  const border = `1px solid ${isDark ? 'rgba(0,212,255,0.35)' : 'rgba(14,138,168,0.35)'}`;
  return (
    <div style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 20, width: 340 }}>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { onPick(matches[0]); setQ(''); } }}
        placeholder="搜索节点，回车聚焦…"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '7px 12px', fontSize: 12, outline: 'none',
          fontFamily: '"Courier New", ui-monospace, monospace',
          background: bg, border, borderRadius: 4,
          color: isDark ? '#cdd6f4' : '#334155',
          boxShadow: `0 0 10px ${accent}22`,
        }}
      />
      {open && matches.length > 0 && (
        <div style={{ marginTop: 4, background: bg, border, borderRadius: 4, overflow: 'hidden', backdropFilter: 'blur(6px)' }}>
          {matches.map(m => (
            <div
              key={m.id}
              onMouseDown={() => { onPick(m); setQ(''); }}
              style={{
                padding: '6px 12px', fontSize: 12, cursor: 'pointer',
                color: isDark ? '#cdd6f4' : '#334155',
                fontFamily: '"Courier New", ui-monospace, monospace',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = `${accent}22`; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
            >
              {m.name}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        {cats.map(c => {
          const on = catFilter.has(c.key);
          return (
            <button
              key={c.key}
              onClick={() => onToggleCat(c.key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                fontSize: 10, padding: '2px 8px', borderRadius: 10, fontFamily: '"Courier New", monospace',
                background: on ? `${c.color}22` : 'transparent',
                border: `1px solid ${on ? c.color : isDark ? '#45475a' : '#cbd5e1'}`,
                color: on ? c.color : isDark ? '#7f849c' : '#94a3b8',
                opacity: on ? 1 : 0.6,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.color }} />
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
