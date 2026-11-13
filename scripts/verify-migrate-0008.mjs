// T2-02 空库迁移验证：0000→0008 全量应用到临时库，校验新列与索引
// 用法（宿主）：docker run --rm -v TEST:/src -w /src --entrypoint sh IMAGE -c
//   'SQLITE_PATH=/tmp/verify-0008.db npx drizzle-kit migrate --force && node scripts/verify-migrate-0008.mjs'
import Database from "better-sqlite3";

const dbPath = process.env.SQLITE_PATH ?? "/tmp/verify-0008.db";
const d = new Database(dbPath);
const cols = d.prepare("PRAGMA table_info(document_chunks)").all().map((c) => c.name);
const need = ["charStart", "charEnd", "pageStart", "pageEnd", "sectionPath", "contentHash"];
const missing = need.filter((n) => !cols.includes(n));
const ecols = d.prepare("PRAGMA table_info(knowledge_edges)").all().map((c) => c.name);
const eneed = ["evidence", "evidenceDocumentId", "evidenceChunkId"];
const emissing = eneed.filter((n) => !ecols.includes(n));
const idx = d
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE '%doc_page%' OR name LIKE '%doc_hash%' OR name LIKE '%evidenceChunk%')",
  )
  .all()
  .map((r) => r.name);
console.log("document_chunks 新列缺失:", missing.length ? missing : "无 ✅");
console.log("knowledge_edges 新列缺失:", emissing.length ? emissing : "无 ✅");
console.log("新索引:", JSON.stringify(idx));
console.log("迁移日志条数:", JSON.stringify(d.prepare("SELECT idx FROM __drizzle_migrations").all().length));
d.close();
if (missing.length || emissing.length) process.exit(1);
