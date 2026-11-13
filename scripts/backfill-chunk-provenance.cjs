// T2-05：历史块位置元数据回填（不重嵌入、不碰页码/向量/FTS/正文）
//
// 用法（生产容器内）：
//   node backfill-chunk-provenance.mjs            # dry-run：只统计，不写库
//   node backfill-chunk-provenance.mjs --apply    # 真写
//
// ⚠️ 本文件内联的 chunkTextWithOffsets 必须与 api/lib/document-indexer.ts 的实现保持同步
// （dist 打包产物无具名导出，只能内联）。防漂移手段：每行回填前断言不变式
// `normalized.slice(charStart, charEnd) === content`，实现漂移会当场失败并记入 mismatch。
const { createHash } = require("node:crypto");
const Database = require("better-sqlite3");

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.SQLITE_PATH ?? "/data/app/xuanji.db";

function chunkTextWithOffsets(text, maxChars = 800, overlap = 100) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized ? [{ content: normalized, start: 0, end: normalized.length }] : [];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + maxChars, normalized.length);
    let slice = normalized.slice(start, end);
    if (end < normalized.length) {
      const lb = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf(". "));
      if (lb > overlap) slice = slice.slice(0, lb + 1);
    }
    let guardCut = 0;
    if (slice.length > 0) {
      const first = slice.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) { slice = slice.slice(1); guardCut = 1; }
      if (slice.length > 0) {
        const last = slice.charCodeAt(slice.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
      }
    }
    const content = slice.trim();
    const contentStart = start + guardCut + (slice.length - slice.trimStart().length);
    chunks.push({ content, start: contentStart, end: contentStart + content.length });
    if (end >= normalized.length || slice.length <= overlap) break;
    start += slice.length - overlap;
  }
  return chunks.filter((c) => c.content.length > 0);
}

function sha256Hex16(s) {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

// 与 api/lib/section-path.ts 的 buildSectionPath 保持同步
function buildSectionPath(text, offset) {
  if (offset <= 0) return undefined;
  const lines = text.slice(0, offset).split("\n");
  const stack = new Map();
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    for (const l of [...stack.keys()]) if (l >= level) stack.delete(l);
    stack.set(level, m[2]);
  }
  if (stack.size === 0) return undefined;
  return [...stack.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join(" > ");
}

const db = new Database(DB_PATH);
if (APPLY) db.exec("BEGIN IMMEDIATE");

const docs = db.prepare("SELECT id, content FROM kb_documents WHERE deletedAt IS NULL AND content IS NOT NULL").all();
const getChunks = db.prepare("SELECT id, content, chunkIndex FROM document_chunks WHERE documentId = ? ORDER BY chunkIndex");
const upd = db.prepare("UPDATE document_chunks SET charStart=?, charEnd=?, sectionPath=?, contentHash=? WHERE id=?");

let scanned = 0, matched = 0, filled = 0, mismatch = 0, emptyDocs = 0;
const mismatchSamples = [];
const t0 = Date.now();

for (const doc of docs) {
  scanned++;
  if (scanned % 200 === 0) {
    console.log(`进度 ${scanned}/${docs.length} | matched=${matched} filled=${filled} mismatch=${mismatch}`);
  }
  const rows = getChunks.all(doc.id);
  if (rows.length === 0) { emptyDocs++; continue; }
  const normalized = doc.content.replace(/\r\n/g, "\n").trim();
  const parts = chunkTextWithOffsets(doc.content);
  if (parts.length !== rows.length) {
    mismatch++;
    if (mismatchSamples.length < 10) mismatchSamples.push({ docId: doc.id, reason: "块数不同", db: rows.length, fresh: parts.length });
    continue;
  }
  let ok = true;
  const batch = [];
  for (let i = 0; i < parts.length; i++) {
    const row = rows[i];
    const p = parts[i];
    if (row.content !== p.content) {
      ok = false;
      if (mismatchSamples.length < 10) mismatchSamples.push({ docId: doc.id, chunkIndex: i, reason: "内容不同" });
      break;
    }
    // 不变式自校验（防内联实现与仓库实现漂移）
    if (normalized.slice(p.start, p.end) !== p.content) {
      ok = false;
      if (mismatchSamples.length < 10) mismatchSamples.push({ docId: doc.id, chunkIndex: i, reason: "不变式失败（实现漂移?）" });
      break;
    }
    batch.push([p.start, p.end, buildSectionPath(normalized, p.end) ?? null, sha256Hex16(p.content), row.id]);
  }
  if (!ok) { mismatch++; continue; }
  matched++;
  if (APPLY) {
    for (const args of batch) upd.run(...args);
    filled += batch.length;
  } else {
    filled += batch.length;
  }
}

if (APPLY) db.exec("COMMIT");
console.log("=== 回填结果");
console.log(JSON.stringify({
  mode: APPLY ? "apply" : "dry-run",
  scanned, matched, filled, mismatch, emptyDocs,
  elapsedMs: Date.now() - t0,
}, null, 2));
if (mismatchSamples.length) console.log("mismatch 样本:", JSON.stringify(mismatchSamples, null, 2));
db.close();
