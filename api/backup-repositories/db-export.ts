/**
 * 数据库导出（默认备份范围之一）
 *
 * 用 mysql2/promise 连接池，在 `START TRANSACTION WITH CONSISTENT SNAPSHOT`
 * 下把基础表导出为 schema JSON + NDJSON 行流，写入 staging 的 database/ 目录。
 * 不调用 mysqldump；失败时抛错，由 executeBackup 标记备份失败。
 */
import * as path from "path";
import { promises as fsp } from "fs";
import { createPool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { getTableName } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import * as schema from "@db/schema";
import { env } from "../lib/env";

const TABLE_NAME_RE = /^[A-Za-z0-9_]+$/;

interface PoolConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

function readPoolConfig(): PoolConfig {
  if (env.databaseUrl) {
    const url = new URL(env.databaseUrl);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    };
  }
  return {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? "3306"),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "",
  };
}

/** 从 db/schema.ts 实际定义的表（白名单），避免导出无关/系统表。 */
function schemaTableNames(): string[] {
  return (Object.values(schema) as unknown[])
    .filter((v): v is MySqlTable => v instanceof MySqlTable)
    .map((t) => getTableName(t));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "bigint") return value.toString();
  return value;
}

export interface DbExportResult {
  readonly tables: string[];
  readonly rows: number;
}

export async function exportDatabaseTables(targetDir: string): Promise<DbExportResult> {
  const pool = createPool({ ...readPoolConfig(), connectionLimit: 5 });
  const whitelist = new Set(schemaTableNames());
  const tables: string[] = [];
  let rows = 0;

  const conn: PoolConnection = await pool.getConnection();
  try {
    await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");

    const [tableRows] = await conn.query<RowDataPacket[]>(
      "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"
    );
    for (const row of tableRows) {
      const name = String(row.TABLE_NAME ?? "");
      if (TABLE_NAME_RE.test(name) && whitelist.has(name)) {
        tables.push(name);
      }
    }

    await fsp.mkdir(targetDir, { recursive: true });
    for (const name of tables) {
      const [columns] = await conn.query<RowDataPacket[]>(
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        [name]
      );
      const schemaJson = {
        table: name,
        columns: columns.map((c) => ({
          name: String(c.COLUMN_NAME ?? ""),
          dataType: String(c.DATA_TYPE ?? ""),
          columnType: String(c.COLUMN_TYPE ?? ""),
          nullable: c.IS_NULLABLE === "YES",
          key: String(c.COLUMN_KEY ?? ""),
          default: c.COLUMN_DEFAULT,
        })),
      };
      await fsp.writeFile(path.join(targetDir, `${name}.schema.json`), JSON.stringify(schemaJson, null, 2));

      const [dataRows] = await conn.query<RowDataPacket[]>(`SELECT * FROM \`${name}\``);
      const lines = dataRows.map((r) => JSON.stringify(r, jsonReplacer));
      await fsp.writeFile(path.join(targetDir, `${name}.ndjson`), lines.length > 0 ? `${lines.join("\n")}\n` : "");
      rows += dataRows.length;
    }

    await conn.query("COMMIT");
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    conn.release();
    await pool.end().catch(() => undefined);
  }

  return { tables, rows };
}
