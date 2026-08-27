import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

type DbInstance = ReturnType<typeof drizzle<typeof fullSchema>>;
let instance: DbInstance | null = null;
let dbInstance: Database.Database | null = null;

/** 测试用：注入 fake db 实例。 */
export function _setDbForTests(db: Database.Database): void {
  dbInstance = db;
  instance = drizzle(db, { schema: fullSchema });
}

/** 测试用：重置回真实 DB。 */
export function _resetDbForTests(): void {
  dbInstance = null;
  instance = null;
}

/** 暴露底层 Database 实例（用于 vec0 扩展加载等需要原生 db 的场景）。 */
export function getRawDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(env.sqlitePath);
    // 启动时尝试加载 sqlite-vec 扩展（vec0），失败不致命——引擎降级到内存 fallback
    try {
      dbInstance.loadExtension("node_modules/sqlite-vec-linux-x64/vec0");
    } catch (err) {
      console.warn(
        "[SQLite] 加载 sqlite-vec 扩展失败，向量引擎将使用内存 fallback:",
        err instanceof Error ? err.message : err,
      );
    }
    // 启用外键约束（SQLite 默认关闭）
    dbInstance.pragma("foreign_keys = ON");
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("synchronous = NORMAL");
  }
  return dbInstance;
}

export function getDb(): DbInstance {
  if (!instance) {
    instance = drizzle(getRawDb(), { schema: fullSchema });
  }
  return instance;
}
