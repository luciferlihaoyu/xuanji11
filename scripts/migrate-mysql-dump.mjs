/**
 * MySQL mysqldump → SQLite 迁移脚本
 *
 * 输入：mysqldump 输出的 SQL 文件（含 CREATE TABLE + INSERT INTO）
 * 输出：可直接在 better-sqlite3 加载的 .db 文件
 *
 * 用法：
 *   node scripts/migrate-mysql-dump.mjs <input.sql> <output.db>
 *
 * 设计：
 * 1. 先跑 R3 drizzle migration 建表（用项目自带的 db/migrations/）
 * 2. 解析 MySQL dump：
 *    - 从 CREATE TABLE 拿 MySQL 列顺序
 *    - 按 R3 schema 列顺序重排（用 R3 列名映射）
 * 3. 类型转换：timestamp 字符串 'YYYY-MM-DD HH:MM:SS' → unix ms 整数
 * 4. 用 INSERT INTO table (col, col, ...) VALUES (?,?,...) 显式列名
 *    这样无论 MySQL/R3 列顺序如何，SQLite 按列名匹配
 */
import Database from "better-sqlite3";
import { readFileSync, readFileSync as readJSON } from "fs";
import { argv, exit } from "process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const [inputPath, outputPath, r3ColsPath] = argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("Usage: node migrate-mysql-dump.mjs <input.sql> <output.db> [r3-cols.json]");
  exit(1);
}
const r3ColsFile = r3ColsPath || join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "r3-cols.json");
const R3_COLS = JSON.parse(readFileSync(r3ColsFile, "utf8"));

const R3_TABLES = new Set(Object.keys(R3_COLS));
// 一些表 R3 删了（用户也没说要用）
const REMOVED_IN_R3 = new Set([
  "model_pricing",     // R3 删了，改用 model_allowlist
  "model_allowlist",   // R3 也删了
  "messages",          // R3 改名为 task_messages（用户不用天宫）
  "conversations",
  "tasks", "task_artifacts", "task_dependencies", "task_messages",
  "task_threads",
  "organizations", "departments", "users_v2",  // (防御性)
  "high_cost_model_auth",  // R3 删了
  "systems",  // 旧版 system tables
  "github_*",  // 早期
  "workflow_executions",  // R3 删了
  "token_usage",  // R3 改为 tokenUsage 之类
  "mcp_servers",  // R3 schema 已建（与 dump 同时存在）
  "mcp_api_keys", "mcp_audit_log",
  "mailbox_messages",
]);

// ──────────────── 解析 INSERT ────────────────
/**
 * 找所有 INSERT INTO `table` VALUES (...);
 * 状态机：单引号 / 反斜杠转义 / 多行 INSERT
 */
function parseInserts(sql) {
  const inserts = [];
  const re = /^INSERT INTO `(\w+)` VALUES\s*/gm;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1];
    let i = m.index + m[0].length;
    const rows = [];
    while (i < sql.length) {
      while (i < sql.length && /\s/.test(sql[i])) i++;
      if (sql[i] !== "(") break;
      i++;
      const row = parseRow(sql, i);
      if (!row) break;
      i = row.end;
      rows.push(row.values);
      while (i < sql.length && /\s/.test(sql[i])) i++;
      if (sql[i] === ",") { i++; continue; }
      if (sql[i] === ";") { i++; break; }
      break;
    }
    if (rows.length) inserts.push({ table, values: rows });
  }
  return inserts;
}

function parseRow(sql, start) {
  const values = [];
  let i = start;
  while (i < sql.length) {
    while (i < sql.length && /\s/.test(sql[i])) i++;
    if (sql[i] === ")") return { values, end: i + 1 };
    if (sql[i] === "'") {
      const r = parseString(sql, i);
      values.push({ type: "string", value: r.value });
      i = r.end;
    } else if (sql[i] === "N" && sql.slice(i, i + 4) === "NULL") {
      values.push({ type: "null" });
      i += 4;
    } else {
      let j = i;
      if (sql[j] === "-") j++;
      while (j < sql.length && /[\d.eE+-]/.test(sql[j])) j++;
      const text = sql.slice(i, j);
      const num = Number(text);
      if (Number.isFinite(num)) { values.push({ type: "number", value: num }); i = j; }
      else i++;
    }
    while (i < sql.length && /\s/.test(sql[i])) i++;
    if (sql[i] === ",") { i++; continue; }
  }
  return null;
}

function parseString(sql, start) {
  let i = start + 1;
  let out = "";
  while (i < sql.length) {
    const c = sql[i];
    if (c === "\\" && i + 1 < sql.length) {
      const next = sql[i + 1];
      if (next === "'") { out += "'"; i += 2; continue; }
      if (next === "\\") { out += "\\"; i += 2; continue; }
      if (next === "n") { out += "\n"; i += 2; continue; }
      if (next === "r") { out += "\r"; i += 2; continue; }
      if (next === "t") { out += "\t"; i += 2; continue; }
      if (next === "0") { out += "\0"; i += 2; continue; }
      out += c + next; i += 2; continue;
    }
    if (c === "'") {
      if (sql[i + 1] === "'") { out += "'"; i += 2; continue; }
      return { value: out, end: i + 1 };
    }
    out += c; i++;
  }
  throw new Error("Unterminated string at " + start);
}

// ──────────────── 解析 MySQL CREATE TABLE 拿列顺序 ────────────────
function parseMysqlCols(sql, table) {
  const m = sql.match(new RegExp("CREATE TABLE `" + table + "` \\(([\\s\\S]*?)\\) ENGINE="));
  if (!m) return null;
  const cols = [];
  for (const line of m[1].split("\n")) {
    const t = line.trim().replace(/,$/, "");
    const cm = t.match(/^`(\w+)`/);
    if (cm && !["PRIMARY", "UNIQUE", "KEY", "FULLTEXT", "INDEX", "CONSTRAINT"].includes(cm[1])) {
      cols.push(cm[1]);
    }
  }
  return cols;
}

// ──────────────── 字段类型转换 ────────────────
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
function convertValue(colName, raw) {
  if (raw.type === "null") return null;
  if (raw.type === "number") return raw.value;
  if (raw.type === "string") {
    if (TIMESTAMP_RE.test(raw.value)) {
      const t = Date.parse(raw.value.replace(" ", "T") + "Z");
      if (Number.isFinite(t)) return t;
    }
    return raw.value;
  }
  return null;
}

// ──────────────── 主流程 ────────────────
console.log(`Reading ${inputPath} ...`);
const sql = readFileSync(inputPath, "utf8");
console.log(`  ${(sql.length / 1024 / 1024).toFixed(1)} MB`);

console.log("Parsing INSERT statements ...");
const inserts = parseInserts(sql);

// 给每条 INSERT 加上 mysql 列顺序
for (const ins of inserts) {
  ins.mysqlCols = parseMysqlCols(sql, ins.table);
}

const byTable = new Map();
let totalRows = 0;
for (const ins of inserts) {
  const inR3 = R3_TABLES.has(ins.table);
  if (!inR3) {
    const key = `__SKIP_not_in_r3_${ins.table}`;
    byTable.set(key, (byTable.get(key) || 0) + ins.values.length);
    continue;
  }
  byTable.set(ins.table, (byTable.get(ins.table) || 0) + ins.values.length);
  totalRows += ins.values.length;
}
console.log(`  ${inserts.length} INSERT statements, ${totalRows} rows in R3 tables`);

const skipped = [...byTable.entries()].filter(([k]) => k.startsWith("__SKIP_"));
if (skipped.length) {
  console.log("  Skipped tables:");
  for (const [k, v] of skipped) {
    const name = k.replace(/^__SKIP_not_in_r3_/, "");
    console.log(`    ${name}: ${v} rows`);
  }
}

console.log(`\nOpening ${outputPath} ...`);
const db = new Database(outputPath);
db.pragma("journal_mode = DELETE");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = OFF");

console.log("Running R3 schema migration ...");
const { drizzle } = await import("drizzle-orm/better-sqlite3");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
const orm = drizzle(db);
migrate(orm, { migrationsFolder: join(process.cwd(), "db", "migrations") });
console.log("  Schema applied.");

// 准备 INSERT statement：每张表用 `INSERT INTO table (col, col) VALUES (?, ?)` 显式列名
const stmtCache = new Map();
function getStmt(table) {
  if (stmtCache.has(table)) return stmtCache.get(table);
  const r3Cols = R3_COLS[table];
  const placeholders = r3Cols.map(() => "?").join(",");
  const sqlStmt = `INSERT OR REPLACE INTO ${table} (${r3Cols.join(",")}) VALUES (${placeholders})`;
  const stmt = db.prepare(sqlStmt);
  stmtCache.set(table, stmt);
  return stmt;
}

// 重排 + 转换
let inserted = 0;
const errors = [];
const t0 = Date.now();

const tx = db.transaction((items) => {
  for (const item of items) {
    if (!R3_TABLES.has(item.table)) continue;
    const mysqlCols = item.mysqlCols;
    const r3Cols = R3_COLS[item.table];
    // 给每行按 R3 schema 列顺序重排
    for (const row of item.values) {
      if (!mysqlCols || row.length !== mysqlCols.length) {
        if (errors.length < 10) errors.push({ table: item.table, error: `row length ${row.length} != mysql cols ${mysqlCols?.length}`, mysqlCols });
        continue;
      }
      // 建立 mysqlCol → rawValue 映射
      const map = {};
      for (let i = 0; i < mysqlCols.length; i++) map[mysqlCols[i]] = row[i];
      // 按 R3 schema 列顺序取值（如果 MySQL 没这个列，置 null）
      const ordered = r3Cols.map((col) => {
        if (col in map) return convertValue(col, map[col]);
        return null;
      });
      const stmt = getStmt(item.table);
      try { stmt.run(...ordered); inserted++; }
      catch (e) {
        if (errors.length < 10) errors.push({ table: item.table, error: e.message, firstValue: ordered[0] });
      }
    }
  }
});
tx(inserts);

const t1 = Date.now();
console.log(`\nInserted ${inserted} rows in ${((t1 - t0) / 1000).toFixed(1)}s`);
if (errors.length) {
  console.log(`Errors (first 10):`);
  for (const e of errors) console.log(`  ${e.table}: ${e.error}`);
}

// 验证
console.log("\nVerification:");
const expected = {
  users: 1, agents: 4, knowledge_nodes: 149, knowledge_edges: 326,
  kb_documents: 1755, document_chunks: 43984, system_settings: 18,
  api_keys: 4, audit_logs: 52,
};
let allOk = true;
for (const [t, want] of Object.entries(expected)) {
  try {
    const got = db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;
    const ok = got >= want * 0.95;
    if (!ok) allOk = false;
    console.log(`  ${t}: ${got} (expected ~${want}) ${ok ? "✓" : "✗"}`);
  } catch (e) { console.log(`  ${t}: not in R3 schema`); }
}

// 抽看关键数据
console.log("\nSample data:");
try {
  const users = db.prepare("SELECT id, unionId, name, role, createdAt FROM users").all();
  console.log("  users:", users);
} catch (e) { console.log("  users: error", e.message); }
try {
  const settings = db.prepare("SELECT key, category, substr(value, 1, 50) as v FROM system_settings ORDER BY id LIMIT 5").all();
  console.log("  system_settings first 5:", settings);
} catch (e) { console.log("  settings: error", e.message); }
try {
  const sample = db.prepare("SELECT id, documentId, chunkIndex, length(content) as content_len FROM document_chunks ORDER BY id LIMIT 3").all();
  console.log("  document_chunks sample:", sample);
} catch (e) { console.log("  chunks: error", e.message); }
try {
  const nodes = db.prepare("SELECT id, title, type FROM knowledge_nodes ORDER BY id LIMIT 3").all();
  console.log("  knowledge_nodes sample:", nodes);
} catch (e) { console.log("  nodes: error", e.message); }

const fileSize = readFileSync(outputPath).length;
db.close();
console.log(`\nOutput DB: ${outputPath} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
console.log(allOk ? "✅ Migration complete" : "⚠️  Migration completed with row count mismatches");
