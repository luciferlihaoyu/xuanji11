#!/usr/bin/env node
/**
 * theme-bridge 守卫：防止 shadcn/radix UI 组件再次「样式静默失效」
 *
 * 背景（2026-11-10 碧霄实测）：
 *   tailwind.config.js 把 border/card/primary/muted… 全部映射为 `hsl(var(--x))`，
 *   但 index.css 里这些 --x 一个都没定义 → 生成 `background-color: hsl(undefined)`，
 *   属 invalid at computed-value time → 回落到初始值（transparent）。
 *   结果是 ui/* 组件（登录页 Card/Button/Input/Label、404、AuthLayout）渲染成「白底白字」。
 *
 * 本脚本守两道门：
 *   门1 覆盖：tailwind.config.js 里出现的每一个 hsl(var(--X))，必须在暗色 :root 与
 *            亮色 :root[data-theme="light"] 两个主题块里同时有定义。
 *   门2 防漂移：桥接变量若声明「源自某个调色板 token」，其 HSL 三元组必须与该 token
 *            在当前主题下的 hex 值一致（±1 容差），避免调色板改了、桥接忘了改。
 *
 * 用法：node tools/theme-bridge-audit.mjs        # 报告 + 退出码
 *      node tools/theme-bridge-audit.mjs --json # 机器可读
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 桥接变量 → 调色板来源。
 * 值为调色板 token 名（形如 'bg-panel'），或 { dark, light } 显式三元组说明，
 * 或 'fixed:#rrggbb'（两主题同值）。
 */
const BRIDGE_MAP = {
  'background': 'bg-primary',
  'foreground': 'text-primary',
  'card': 'bg-panel',
  'card-foreground': 'text-primary',
  'popover': 'bg-elevated',
  'popover-foreground': 'text-primary',
  'primary': 'accent-cyan',
  'primary-foreground': { dark: 'bg-primary', light: 'fixed:#ffffff' },
  'secondary': 'bg-tertiary',
  'secondary-foreground': 'text-primary',
  'muted': 'bg-secondary',
  'muted-foreground': 'text-secondary',
  'accent': 'bg-tertiary',
  'accent-foreground': 'text-primary',
  'destructive': 'accent-red',
  'destructive-foreground': 'fixed:#ffffff',
  'border': 'border-subtle',
  'input': 'border-subtle',
  'ring': 'accent-cyan',
  'sidebar-background': 'bg-secondary',
  'sidebar-foreground': 'text-primary',
  'sidebar-primary': 'accent-cyan',
  'sidebar-primary-foreground': { dark: 'bg-primary', light: 'fixed:#ffffff' },
  'sidebar-accent': 'bg-tertiary',
  'sidebar-accent-foreground': 'text-primary',
  'sidebar-border': 'border-subtle',
  'sidebar-ring': 'accent-cyan',
};

const cfgSrc = readFileSync(join(ROOT, 'tailwind.config.js'), 'utf8');
const cssSrc = readFileSync(join(ROOT, 'src/index.css'), 'utf8');

/** tailwind config 里所有 hsl(var(--X)) 引用 */
const referenced = new Set();
for (const m of cfgSrc.matchAll(/hsl\(\s*var\(\s*--([\w-]+)\s*\)/g)) referenced.add(m[1]);

/** 切出 :root 块与 :root[data-theme="light"] 块 */
function themeBlock(selector) {
  const idx = cssSrc.indexOf(selector);
  if (idx < 0) return null;
  const open = cssSrc.indexOf('{', idx);
  let depth = 0, i = open;
  for (; i < cssSrc.length; i++) {
    if (cssSrc[i] === '{') depth++;
    else if (cssSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return cssSrc.slice(open + 1, i);
}
const darkBlock = themeBlock(':root[data-theme="dark"]');
const lightBlock = themeBlock(':root[data-theme="light"]');

function parseVars(block) {
  const vars = {};
  if (!block) return vars;
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}
const darkVars = parseVars(darkBlock);
const lightVars = parseVars(lightBlock);
// :root 的「全局默认」块（--radius 等）另有一处
const defaultsVars = parseVars(themeBlock('\n  /* ===== 全局默认 ===== */'));

function hexToHsl(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let s = 0, hue = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return [Math.round(hue) % 360, Math.round(s * 100), Math.round(l * 100)];
}

function parseTriplet(v) {
  if (!v) return null;
  const m = String(v).match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const errors = [];
const warnings = [];
const rows = [];

// ── 门1：覆盖 ──
for (const name of [...referenced].sort()) {
  const inDark = name in darkVars;
  const inLight = name in lightVars;
  rows.push({ name, dark: inDark, light: inLight });
  if (!inDark) errors.push(`[覆盖] --${name} 在暗色 :root 未定义（ui/* 组件会静默失效）`);
  if (!inLight) errors.push(`[覆盖] --${name} 在亮色 :root[data-theme="light"] 未定义`);
}

// ── 门1b：config 引用的变量都应在映射表里被认领（防止新增映射无人维护） ──
for (const name of referenced) {
  if (!(name in BRIDGE_MAP) && !['radius'].includes(name)) warnings.push(`[映射] --${name} 未登记在 BRIDGE_MAP，无法做防漂移校验`);
}

// ── 门2：防漂移 ──
for (const [name, spec] of Object.entries(BRIDGE_MAP)) {
  if (!referenced.has(name)) continue;
  for (const theme of ['dark', 'light']) {
    const vars = theme === 'dark' ? darkVars : lightVars;
    const defined = parseTriplet(vars[name]);
    if (!defined) { if (errors.length === 0 || referenced.has(name)) errors.push(`[三元组] --${name} (${theme}) 缺失或格式不是 "H S% L%"：${vars[name] ?? 'undefined'}`); continue; }
    const src = typeof spec === 'object' ? spec[theme] : spec;
    let expectHex = null;
    if (typeof src === 'string' && src.startsWith('fixed:')) expectHex = src.slice(6);
    else if (typeof src === 'string') expectHex = vars[src] ?? darkVars[src] ?? defaultsVars[src];
    if (!expectHex || !/^#[0-9a-fA-F]{3,8}$/.test(expectHex.trim())) { warnings.push(`[防漂移] --${name} (${theme}) 来源 ${src} 不是 hex，跳过`); continue; }
    const expect = hexToHsl(expectHex.trim());
    const diff = expect.map((v, i) => Math.abs(v - defined[i]));
    const ok = diff[0] <= 1 && diff[1] <= 1 && diff[2] <= 1;
    if (!ok) errors.push(`[防漂移] --${name} (${theme}) 声明 ${defined.join(' ')} ≠ 来源 ${src}=${expectHex.trim()} 换算 ${expect.join(' ')}`);
  }
}

const report = {
  referencedCount: referenced.size,
  bridgedCount: rows.filter((r) => r.dark && r.light).length,
  errors,
  warnings,
  rows,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`tailwind 引用 hsl(var(--x)) 变量数：${referenced.size}`);
  console.log(`已桥接（暗+亮双主题均有定义）：${report.bridgedCount}/${referenced.size}`);
  for (const w of warnings) console.log(`WARN ${w}`);
  for (const e of errors) console.log(`ERR  ${e}`);
  console.log(errors.length === 0 ? '判定: PASS ✅ theme bridge 完整且未漂移' : `判定: FAIL ❌ ${errors.length} 处问题`);
}
process.exit(errors.length === 0 ? 0 : 1);
