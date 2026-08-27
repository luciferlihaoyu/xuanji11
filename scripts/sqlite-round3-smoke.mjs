/**
 * Round 3 烟雾测：验证 sqlite 替换 mysql 后的最小 drizzle 调用链。
 * node scripts/sqlite-round3-smoke.mjs
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { sql, eq } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

const dbFile = process.env.SQLITE_SMOKE_PATH ?? ":memory:";
const raw = new Database(dbFile);
try { raw.loadExtension("node_modules/sqlite-vec-linux-x64/vec0"); }
catch (e) { console.warn("vec0 load warn:", e?.message); }
raw.pragma("foreign_keys = ON");

const users = sqliteTable("smoke_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  unionId: text("unionId").notNull().unique(),
  name: text("name"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`),
});

raw.exec("DROP TABLE IF EXISTS smoke_users");
raw.exec(`CREATE TABLE smoke_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unionId TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
)`);

const db = drizzle(raw, { schema: { users } });

const inserted = db.insert(users).values({ unionId: "u1", name: "alice", role: "user" }).run();
console.log("insert:", { lastInsertRowid: inserted.lastInsertRowid, changes: inserted.changes });
const newId = Number(inserted.lastInsertRowid);

const all = db.select().from(users).all();
console.log("select all:", all);

db.update(users).set({ name: "alice-updated" }).where(eq(users.id, newId)).run();
const after = db.select().from(users).all();
console.log("after update:", after);

db.delete(users).where(eq(users.id, newId)).run();
const empty = db.select().from(users).all();
console.log("after delete:", empty);

raw.exec("CREATE TABLE smoke_j(id INTEGER PRIMARY KEY, meta TEXT)");
raw.prepare("INSERT INTO smoke_j(meta) VALUES(?)").run(JSON.stringify({ documentId: "d-99" }));
const rows = raw.prepare("SELECT json_extract(meta, '$.documentId') AS d FROM smoke_j").all();
console.log("json_extract row:", rows);

console.log("smoke OK");
raw.close();
