#!/usr/bin/env node
/**
 * 璇玑移动端适配静态巡检（碧霄 2026-11-10）
 *
 * 用法：
 *   node /data/dsh/璇玑/tools/mobile-audit.mjs [--repo <dir>] [--only a.tsx,b.tsx] [--json]
 *
 * 判定项（硬红线，必须为 0）：
 *   H1 出现 100vh（应为 dvh 或 h-app/min-h-app）
 *   H2 grid-cols-N (N>=3) 且同行字符串内无 sm:/md:/lg: 前缀
 *   H3 固定宽 w-[Npx] / min-w-[Npx] N>320 且无 sm:/md:/lg: 前缀
 *   H4 文件含 <table 但全文件无 overflow-x-auto / table-scroll
 *
 * 提示项（只统计，供评审参考）：
 *   I1 text-[9px] / text-[10px] 数量
 *   I2 含 overflow-y-auto 的文件里是否有 min-h-0
 *   I3 含响应式标记的数量（≥1 表示该文件已具备移动分支）
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const REPO = path.resolve(opt('repo', '/data/dsh/璇玑/work'));
const ONLY = opt('only') ? opt('only').split(',').map((s) => s.trim()) : null;
const AS_JSON = args.includes('--json');

const ROOTS = ['src/pages', 'src/components'];
const RESPONSIVE = /(^|[\s"'`:])(sm|md|lg|xl|2xl|max-sm|max-md|max-lg):/;

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith('.test.tsx') && !e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

let files = ROOTS.flatMap((r) => walk(path.join(REPO, r)));
if (ONLY && ONLY.length) {
  files = files.filter((f) => {
    const rel = path.relative(REPO, f);
    return ONLY.some((o) => rel === o || rel.endsWith(o) || rel.endsWith('/' + o));
  });
}
if (!files.length) {
  console.error('没有匹配到文件，检查 --repo / --only 参数');
  process.exit(2);
}

const report = [];
for (const file of files) {
  const rel = path.relative(REPO, file);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const hard = [];
  const info = { tinyFont: 0, hasMinH0: src.includes('min-h-0'), overflowY: src.includes('overflow-y-auto'), responsive: (src.match(/(sm|md|lg):/g) || []).length };

  lines.forEach((line, idx) => {
    const ln = idx + 1;
    if (/\b100vh\b/.test(line) && !/100dvh/.test(line)) {
      // data-* 注释里的说明文字不算
      if (!/^\s*(\/\/|\*|\/\*)/.test(line)) hard.push({ rule: 'H1', line: ln, text: line.trim().slice(0, 120) });
    }
    for (const m of line.matchAll(/['"`]([^'"`]*)['"`]/g)) {
      const cls = m[1];
      if (!/[a-z]/.test(cls)) continue;
      // H2: grid-cols-3..12 无响应式前缀
      for (const g of cls.matchAll(/(^|\s)grid-cols-([3-9]|1[0-2])(\s|$)/g)) {
        if (!RESPONSIVE.test(cls)) hard.push({ rule: 'H2', line: ln, text: cls.slice(0, 120) });
      }
      // H3: 固定宽 > 320
      for (const w of cls.matchAll(/(^|\s)(min-)?w-\[(\d+)px\]/g)) {
        if (Number(w[3]) > 320 && !/(^|[\s"'`])(sm|md|lg|xl):/.test(cls)) hard.push({ rule: 'H3', line: ln, text: cls.slice(0, 120) });
      }
    }
    if (/text-\[(9|10)px\]/.test(line)) info.tinyFont += 1;
  });

  if (/<table/i.test(src) && !/overflow-x-auto|table-scroll/.test(src)) {
    const first = lines.findIndex((l) => /<table/i.test(l)) + 1;
    hard.push({ rule: 'H4', line: first, text: '<table 无 overflow-x-auto / table-scroll 容器' });
  }

  // 去重（同行同规则）
  const seen = new Set();
  const uniq = hard.filter((h) => {
    const k = `${h.rule}:${h.line}:${h.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  report.push({ file: rel, hard: uniq, info });
}

const hardTotal = report.reduce((n, r) => n + r.hard.length, 0);

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== 硬红线（目标 0）===');
  for (const r of report) {
    if (!r.hard.length) continue;
    console.log(`\n${r.file}  (${r.hard.length})`);
    for (const h of r.hard) console.log(`  ${h.rule} L${h.line}  ${h.text}`);
  }
  console.log(`\n硬红线合计: ${hardTotal}  文件数: ${report.length}`);
  console.log('\n=== 提示项 ===');
  const tiny = report.filter((r) => r.info.tinyFont > 0).map((r) => `${r.file}:${r.info.tinyFont}`);
  console.log('小字号(text-[9/10px]):', tiny.join(', ') || '无');
  const scrollNoMin = report.filter((r) => r.info.overflowY && !r.info.hasMinH0).map((r) => r.file);
  console.log('有 overflow-y-auto 但全文件无 min-h-0:', scrollNoMin.length ? scrollNoMin.join(', ') : '无');
  const noResp = report.filter((r) => r.info.responsive === 0).map((r) => r.file);
  console.log('完全无响应式标记:', noResp.length ? noResp.join(', ') : '无');
  console.log(`\n判定: ${hardTotal === 0 ? 'PASS ✅' : 'FAIL ❌（先修硬红线）'}`);
}

// ③ 退出码必须在输出分支**之外**计算：
// 旧实现把 `process.exit(hardTotal === 0 ? 0 : 1)` 写在 else 分支里 → --json 模式有硬红线也退出 0，
// 等于给任何用 --json 的调用方留了"假绿"后门。现在两种模式共用同一退出码（红线 → 1，无 → 0）。
process.exit(hardTotal === 0 ? 0 : 1);
