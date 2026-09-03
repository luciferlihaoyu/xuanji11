// 修复迁移库中 json 字段的双重转义问题
// 用法: node fix-json-escapes.mjs <db> [--dry-run]
import Database from "better-sqlite3";

const dbPath = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!dbPath) {
  console.error("Usage: node fix-json-escapes.mjs <db> [--dry-run]");
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

/**
 * 尝试把字符串解析成合法 JSON；不合法则尝试还原 MySQL 转义。
 * mysqldump 把 json 列当字符串导出：值里的 " 变成 \"、\ 变成 \\。
 * 迁移脚本的 INSERT 解析器又把 \" 还原成 "、\\ 还原成 \，
 * 最终 SQLite 里存的字节是 {\\"a":1}（一个反斜杠+引号）。
 * 这里用字符串 replaceAll 逐层去掉转义，直到能解析。
 */
function fixJsonValue(raw) {
  if (raw === null || raw === undefined || raw === "") return raw;
  try {
    JSON.parse(raw);
    return raw; // 已经是合法 JSON
  } catch {
    /* 尝试还原 */
  }
  // 注意：JS 源文件里 '\\"' 是「反斜杠+引号」两个字面字符
  const candidates = [
    raw.replaceAll('\\"', '"'), // \" -> "（去掉一层）
    raw.replaceAll('\\\\', '\\'), // \\ -> \（双反斜杠变单）
    raw.replaceAll('\\"', '"').replaceAll('\\\\', '\\'),
  ];
  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch {
      /* 下一个候选 */
    }
  }
  return raw; // 修不了就原样
}

/** 扫描所有表中列名符合 json 语义的列。 */
const jsonColumns = [];
{
  const cols = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'vec_%'",
    )
    .all();
  for (const { name: table } of cols) {
    const pragma = db.prepare(`PRAGMA table_info("${table}")`).all();
    for (const col of pragma) {
      const jsonish = /^(metadata|tags|config|canvas|triggers|connections|permissions|manifest|input|output|style|embedding)$/i.test(
        col.name,
      );
      if (jsonish) jsonColumns.push({ table, column: col.name });
    }
  }
}

let totalFixed = 0;
let totalRows = 0;
for (const { table, column } of jsonColumns) {
  // 用主键列定位（rowid 可能因主键别名不可用，用每行 id 列）
  const pkCol = db.prepare(`PRAGMA table_info("${table}")`).all().find((c) => c.pk)?.name ?? "rowid";
  const rows = db
    .prepare(`SELECT "${pkCol}" AS pk, "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" != ''`)
    .all();
  for (const row of rows) {
    totalRows++;
    const fixed = fixJsonValue(row.v);
    if (fixed !== row.v) {
      if (!dryRun) {
        db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${pkCol}" = ?`).run(fixed, row.pk);
      }
      totalFixed++;
    }
  }
}

// === 额外：system_settings 已知 JSON 值键（结构化 JSON 存在 value 文本列里） ===
const settingsJsonKeys = ["embedding_model_templates"];
if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_settings'").get()) {
  for (const key of settingsJsonKeys) {
    const row = db
      .prepare("SELECT value FROM system_settings WHERE key = ? AND value IS NOT NULL AND value != ''")
      .get(key);
    if (!row) continue;
    totalRows++;
    const fixed = fixJsonValue(row.value);
    if (fixed !== row.value) {
      if (!dryRun) {
        db.prepare("UPDATE system_settings SET value = ? WHERE key = ?").run(fixed, key);
      }
      totalFixed++;
      console.log(`system_settings.${key}: 已修复双转义`);
    } else {
      console.log(`system_settings.${key}: 无需修复（已是合法 JSON 或不可解析）`);
    }
  }
}

console.log(`修复 ${dryRun ? "(dry-run)" : ""}: 共 ${totalRows} 行 json 值，修复 ${totalFixed} 个 (${jsonColumns.length} 个表列 + system_settings 专项)`);
db.close();
