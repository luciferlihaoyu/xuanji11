/**
 * spike3d 工作台面板（侧栏笔记面板 / 设置面板）。
 * 侧栏：Jarvis 式 380px 可拖宽、邻居可点跳转；设置：滑杆 + 预设 + 持久化。
 */
import { useRef, useState } from 'react';
import { trpc } from '@/providers/trpc';
import { ACCENT_DARK, ACCENT_LIGHT, PRESETS, type SpikeSettings } from './presets';
import type { MiniNode } from './widgets';

/* ── 侧栏笔记面板 ───────────────────────────────────────────── */
export function NodeSidebar({ node, neighbors, onClose, onNavigate, isDark }: {
  node: MiniNode | null;
  neighbors: MiniNode[];
  onClose: () => void;
  onNavigate: (n: MiniNode) => void;
  isDark: boolean;
}) {
  const [width, setWidth] = useState(380);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const detailQuery = trpc.knowledge.getNode.useQuery(
    { id: node?.id ?? 0 },
    { enabled: node != null && node.id > 0 },
  );
  if (!node) return null;
  const accent = isDark ? ACCENT_DARK : ACCENT_LIGHT;
  const detail = detailQuery.data as { title?: string; content?: string; createdAt?: string; updatedAt?: string } | null | undefined;

  const startDrag = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: width };
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const w = Math.min(800, Math.max(280, dragRef.current.startW + (dragRef.current.startX - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width, zIndex: 25,
      background: isDark ? 'rgba(5,8,15,0.92)' : 'rgba(255,255,255,0.95)',
      borderLeft: `1px solid ${isDark ? 'rgba(0,212,255,0.3)' : 'rgba(14,138,168,0.3)'}`,
      backdropFilter: 'blur(8px)', display: 'flex', flexDirection: 'column',
    }}>
      {/* 拖宽把手 */}
      <div
        onMouseDown={startDrag}
        style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 6, cursor: 'ew-resize', zIndex: 26 }}
      />
      {/* 头部 */}
      <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${isDark ? '#1e2433' : '#e2e8f0'}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{
            flex: 1, fontSize: 15, fontWeight: 700, color: isDark ? '#e6edf7' : '#1e293b',
            fontFamily: '"Courier New", ui-monospace, monospace', lineHeight: 1.4, wordBreak: 'break-all',
          }}>
            {node.name}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: `1px solid ${accent}55`, borderRadius: 4, cursor: 'pointer',
              color: accent, fontSize: 12, padding: '2px 8px', fontFamily: '"Courier New", monospace',
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: isDark ? '#7f849c' : '#94a3b8', fontFamily: '"Courier New", monospace' }}>
          连接 ×{node.deg}
          {detail?.createdAt ? ` · 建于 ${String(detail.createdAt).slice(0, 10)}` : ''}
        </div>
      </div>
      {/* 正文 */}
      <div className="spike3d-scroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {detailQuery.isLoading && (
          <div style={{ fontSize: 12, color: isDark ? '#7f849c' : '#94a3b8' }}>载入内容…</div>
        )}
        {detail?.content ? (
          <div style={{
            fontSize: 13, lineHeight: 1.8, color: isDark ? '#cdd6f4' : '#334155',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {detail.content}
          </div>
        ) : !detailQuery.isLoading && (
          <div style={{ fontSize: 12, color: isDark ? '#565f75' : '#a8b3c4' }}>（无正文内容）</div>
        )}
        {/* 邻居 */}
        {neighbors.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={{
              fontSize: 11, letterSpacing: '0.08em', color: accent, marginBottom: 8,
              fontFamily: '"Courier New", monospace',
            }}>
              NEIGHBORS ({neighbors.length})
            </div>
            {neighbors.slice(0, 30).map(n => (
              <div
                key={n.id}
                onClick={() => onNavigate(n)}
                style={{
                  padding: '5px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 4,
                  color: isDark ? '#9fb4d8' : '#475569',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = `${accent}18`; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                → {n.name}
              </div>
            ))}
            {neighbors.length > 30 && (
              <div style={{ fontSize: 11, color: isDark ? '#565f75' : '#a8b3c4', padding: '4px 8px' }}>
                … 其余 {neighbors.length - 30} 个从略
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── 设置面板（左侧，滑杆 + 预设）───────────────────────────── */
function Slider({ label, value, min, max, step, onChange, isDark, fmt }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; isDark: boolean; fmt?: (v: number) => string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4,
        color: isDark ? '#9fb4d8' : '#475569', fontFamily: '"Courier New", monospace',
      }}>
        <span>{label}</span>
        <span style={{ color: isDark ? ACCENT_DARK : ACCENT_LIGHT }}>{fmt ? fmt(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  );
}

export function SettingsPanel({ settings, onChange, isDark }: {
  settings: SpikeSettings;
  onChange: (s: SpikeSettings) => void;
  isDark: boolean;
}) {
  const [open, setOpen] = useState(false);
  const accent = isDark ? ACCENT_DARK : ACCENT_LIGHT;
  const set = <K extends keyof SpikeSettings>(k: K, v: SpikeSettings[K]) => onChange({ ...settings, [k]: v });

  return (
    <div style={{ position: 'absolute', left: 18, top: 150, zIndex: 20 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: isDark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)',
          border: `1px solid ${accent}55`, borderRadius: 4, cursor: 'pointer',
          color: accent, fontSize: 11, padding: '5px 10px',
          fontFamily: '"Courier New", monospace', letterSpacing: '0.08em',
          boxShadow: `0 0 8px ${accent}22`,
        }}
      >
        {open ? '▲ SETTINGS' : '▼ SETTINGS'}
      </button>
      {open && (
        <div style={{
          marginTop: 6, width: 240, padding: '12px 14px',
          background: isDark ? 'rgba(5,8,15,0.92)' : 'rgba(255,255,255,0.95)',
          border: `1px solid ${accent}44`, borderRadius: 6, backdropFilter: 'blur(8px)',
        }}>
          {/* 预设 */}
          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: accent, marginBottom: 8, fontFamily: '"Courier New", monospace' }}>
            PRESETS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
            {PRESETS.map(p => (
              <button
                key={p.name}
                onClick={() => onChange({ ...settings, ...p.settings })}
                title={p.desc}
                style={{
                  padding: '6px 4px', fontSize: 11, cursor: 'pointer', borderRadius: 4,
                  background: `${accent}14`, border: `1px solid ${accent}44`, color: accent,
                  fontFamily: '"Courier New", monospace',
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          {/* 滑杆 */}
          <Slider label="连线距离" value={settings.linkDist} min={5} max={28} step={1} isDark={isDark} onChange={v => set('linkDist', v)} />
          <Slider label="斥力强度" value={settings.charge} min={4} max={24} step={1} isDark={isDark} onChange={v => set('charge', v)} />
          <Slider label="节点大小" value={settings.nodeSize} min={0.5} max={2} step={0.1} isDark={isDark} onChange={v => set('nodeSize', v)} fmt={v => `×${v.toFixed(1)}`} />
          <Slider label="标签常显" value={settings.labelPct} min={5} max={50} step={5} isDark={isDark} onChange={v => set('labelPct', v)} fmt={v => `前${v}%`} />
          <Slider label="连线弧度" value={settings.curvature} min={0} max={0.4} step={0.02} isDark={isDark} onChange={v => set('curvature', v)} />
          <Slider label="银河旋涡" value={settings.swirl} min={0} max={1} step={0.05} isDark={isDark} onChange={v => set('swirl', v)} />
          <Slider label="自动旋转" value={settings.autoRotate} min={0} max={2} step={0.1} isDark={isDark} onChange={v => set('autoRotate', v)} />
          {isDark && (
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer',
              color: isDark ? '#9fb4d8' : '#475569', fontFamily: '"Courier New", monospace',
            }}>
              <input type="checkbox" checked={settings.scanlines} onChange={e => set('scanlines', e.target.checked)} />
              CRT 扫描线
            </label>
          )}
        </div>
      )}
    </div>
  );
}
