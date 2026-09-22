#!/usr/bin/env node
/**
 * 向量召回低归因实验（可复现证据，2026-09-22 立）
 *
 * 用途：回答「纯向量 recall@5 只有 0.3 是不是检索坏了」。
 * 做两组对照：
 *   A. 逐条评测用例：把 `searchEval.listCases` 的查询按 vector 模式检索 limit=50，
 *      看期望文档命中名次（名次都很靠后/找不到 = 用例可分性问题）。
 *   B. 唯一内容反证：取若干文档正文**中段原句**当查询，看向量 top5 是否命中源文档。
 *      若 A 差而 B 好 → 嵌入管线健康，低指标来自"用例本身是同族兄弟分辨题"。
 *
 * 凭据从环境变量读（**不要把口令写进仓库**）：
 *   XUANJI_BASE=https://xuanji.xianrealme.com \
 *   XUANJI_ADMIN_USER=admin XUANJI_ADMIN_PASSWORD=... \
 *   node scripts/vector-recall-attribution.mjs [--json out.json]
 *
 * 只读：只用 tRPC query（GET），不做任何写操作。
 */

const BASE = process.env.XUANJI_BASE || 'https://xuanji.xianrealme.com';
const USER = process.env.XUANJI_ADMIN_USER || 'admin';
const PASS = process.env.XUANJI_ADMIN_PASSWORD || '';
const UA = process.env.XUANJI_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

if (!PASS) {
  console.error('缺少 XUANJI_ADMIN_PASSWORD 环境变量（口令不入仓）');
  process.exit(2);
}

let cookie = '';
const headers = () => ({
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': UA,
  Cookie: cookie,
});

async function login() {
  const r = await fetch(`${BASE}/api/trpc/auth.login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA },
    body: JSON.stringify({ json: { username: USER, password: PASS } }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
}

async function query(proc, input) {
  const url = `${BASE}/api/trpc/${proc}` + (input ? `?input=${encodeURIComponent(JSON.stringify({ json: input }))}` : '');
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`${proc} ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(`${proc}: ${JSON.stringify(d.error).slice(0, 160)}`);
  return d.result.data.json;
}

const parseExpected = (raw) => {
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((n) => typeof n === 'number') : []; }
  catch { return []; }
};

await login();

// ── A. 逐条评测用例：期望文档在向量结果里的名次 ──
const cases = (await query('searchEval.listCases')) || [];
const caseRows = [];
for (const c of cases) {
  const expected = parseExpected(c.expectedDocIds);
  const res = (await query('kb.hybridSearch', { query: c.query, mode: 'vector', limit: 50 }))?.results || [];
  const ids = res.map((x) => String(x.id));
  const ranks = expected.map((e) => (ids.indexOf(String(e)) >= 0 ? ids.indexOf(String(e)) + 1 : null));
  caseRows.push({ caseId: c.id, query: c.query, expectedDocIds: expected, ranks, top5: res.slice(0, 5).map((x) => ({ id: x.id, title: x.title })) });
}

// ── B. 唯一内容反证：正文中段原句 → 向量 top5 是否命中源文档 ──
const docs = (await query('kb.listDocuments', { limit: 60 })) || [];
const items = Array.isArray(docs) ? docs : docs.items || docs.documents || [];
const probeRows = [];
for (const d of items.slice(0, 40)) {
  if (typeof d.id !== 'number') continue;
  const doc = (await query('kb.getDocument', { id: d.id })) || {};
  const body = doc.content || '';
  if (body.length < 400) continue;
  const text = body.replace(/[#*`>\-[\]()]/g, ' ');
  const sents = text.split(/[。\n]/).map((s) => s.trim()).filter((s) => s.length >= 40 && s.length <= 70);
  if (sents.length < 3) continue;
  const q = sents[Math.floor(sents.length / 2)];
  const res = (await query('kb.hybridSearch', { query: q, mode: 'vector', limit: 5 }))?.results || [];
  const ids = res.map((x) => String(x.id));
  const idx = ids.indexOf(String(d.id));
  probeRows.push({ docId: d.id, query: q, rank: idx >= 0 ? idx + 1 : null });
  if (probeRows.length >= 12) break;
}

const hitCases = caseRows.filter((r) => r.ranks.some((x) => x !== null && x <= 5)).length;
const probeHits = probeRows.filter((r) => r.rank !== null).length;
const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  evalCases: { total: caseRows.length, top5Hits: hitCases, rows: caseRows },
  uniqueContentProbes: { total: probeRows.length, top5Hits: probeHits, rows: probeRows },
  verdict:
    probeRows.length > 0 && probeHits / probeRows.length >= 0.6 && hitCases / Math.max(caseRows.length, 1) < 0.6
      ? '嵌入管线健康：低指标来自用例集（同族兄弟文档分辨题），不是检索链路缺陷'
      : '需进一步排查检索链路（唯一内容反证未达预期）',
};

console.log(JSON.stringify(report, null, 2));
const outIdx = process.argv.indexOf('--json');
if (outIdx > 0 && process.argv[outIdx + 1]) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[outIdx + 1], JSON.stringify(report, null, 2));
  console.error(`已写入 ${process.argv[outIdx + 1]}`);
}
