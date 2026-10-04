/**
 * spike3d 工作台：设置与预设（Jarvis UI 学习成果）。
 * 设置持久化 localStorage；预设 = 力学参数 + 视觉参数的组合包。
 */

export interface SpikeSettings {
  linkDist: number;   // 连线距离系数（×scale）
  charge: number;     // 斥力强度系数（×scale²，取正值，内部取负）
  nodeSize: number;   // 节点尺寸倍率 0.5-2
  labelPct: number;   // 标签常显的度数分位（5-50，= 前 N%）
  autoRotate: number; // 自动旋转速度 0-2
  curvature: number;  // 连线弧度 0-0.4
  swirl: number;      // 银河旋涡（差速切向剪切）0-1
  scanlines: boolean; // CRT 扫描线（仅深色）
}

export const DEFAULT_SETTINGS: SpikeSettings = {
  linkDist: 15, charge: 12, nodeSize: 1, labelPct: 15,
  autoRotate: 0.6, curvature: 0.12, swirl: 0, scanlines: true,
};

export interface SpikePreset {
  name: string;
  desc: string;
  settings: Partial<SpikeSettings>;
}

/** 预设（致敬 Jarvis 的银河/旋臂/烟火/超新星，按我们的力学体系翻译） */
export const PRESETS: SpikePreset[] = [
  {
    name: '星云默认',
    desc: 'Obsidian 洁净基线',
    settings: { ...DEFAULT_SETTINGS },
  },
  {
    name: '银河旋涡',
    desc: '差速剪切出旋臂',
    settings: { linkDist: 13, charge: 8, curvature: 0.25, swirl: 0.5, labelPct: 10, autoRotate: 0.8 },
  },
  {
    name: '紧凑星团',
    desc: '高密度聚拢',
    settings: { linkDist: 8, charge: 6, curvature: 0.05, swirl: 0, labelPct: 25, autoRotate: 0.4 },
  },
  {
    name: '松散原野',
    desc: '疏朗呼吸感',
    settings: { linkDist: 22, charge: 18, curvature: 0.18, swirl: 0, labelPct: 10, autoRotate: 0.5 },
  },
];

const KEY = 'spike3d-settings-v1';

export function loadSettings(): SpikeSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<SpikeSettings>) };
  } catch { /* 忽略损坏数据 */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: SpikeSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 私密模式 */ }
}

/** Jarvis 强调色系（深色青 / 浅色深青） */
export const ACCENT_DARK = '#00d4ff';
export const ACCENT_LIGHT = '#0e8aa8';
