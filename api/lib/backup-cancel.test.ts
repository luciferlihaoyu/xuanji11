/**
 * P0-4：备份长任务的取消必须**真的生效**——不能只把信号挂在句柄上就宣称取消成功。
 * 这里用真实执行链路（executeBackup → 上传循环）+ 注入的假仓库，
 * 断言取消请求到达后上传在文件之间停下、运行标记为 cancelled（而不是 failed）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import { eq } from "drizzle-orm";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));

import { getDb } from "../queries/connection";
import { registerBackupRepository } from "../backup-repositories/base";
import { executeBackup } from "../backup-repositories/execution";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE backup_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      sourcePath TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      filesTotal INTEGER NOT NULL DEFAULT 0,
      filesDone INTEGER NOT NULL DEFAULT 0,
      filesFailed INTEGER NOT NULL DEFAULT 0,
      manifest TEXT,
      config TEXT,
      cron TEXT,
      enabled TEXT DEFAULT 'false',
      nextRunAt INTEGER,
      keepLastN INTEGER DEFAULT 7,
      maxRetries INTEGER DEFAULT 3,
      retryCount INTEGER DEFAULT 0,
      error TEXT,
      startedAt INTEGER,
      completedAt INTEGER,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE backup_job_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId INTEGER NOT NULL,
      relativePath TEXT NOT NULL,
      size INTEGER,
      checksum TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  return drizzle(sqlite, { schema: { ...schema, ...relations } });
}

let srcDir = "";
const uploaded: string[] = [];

function fakeRepo(key: string) {
  registerBackupRepository(key, {
    name: "测试仓库",
    testConnection: async () => ({ success: true, message: "ok" }),
    ensureBasePath: async () => {},
    uploadFile: async (_config, remoteRelPath) => {
      uploaded.push(remoteRelPath);
    },
    readFile: async () => null,
    deleteFile: async () => {},
    listFiles: async () => uploaded,
  });
}

async function seedJob(db: ReturnType<typeof createTestDb>, target: string): Promise<number> {
  const r = db.insert(schema.backupJobs).values({ target, sourcePath: srcDir, status: "pending" }).run() as unknown as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  uploaded.length = 0;
  srcDir = mkdtempSync(path.join(tmpdir(), "xj-cancel-"));
  for (const n of ["a.txt", "b.txt", "c.txt", "d.txt"]) writeFileSync(path.join(srcDir, n), `内容-${n}`);
  vi.mocked(getDb).mockImplementation(() => createTestDb() as never);
});

afterEach(() => {
  if (srcDir) rmSync(srcDir, { recursive: true, force: true });
});

describe("备份取消（P0-4）", () => {
  it("对照：无取消信号时全部文件上传，运行 completed", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    fakeRepo("test-no-cancel");
    const jobId = await seedJob(db, "test-no-cancel");

    await executeBackup(jobId, {});

    expect(uploaded.length).toBe(4);
    const [row] = await db.select().from(schema.backupJobs).where(eq(schema.backupJobs.id, jobId));
    expect(row?.status).toBe("completed");
    expect(row?.progress).toBe(100);
  });

  it("取消请求到达后在文件之间停下，运行标记 cancelled（不是 failed）", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    fakeRepo("test-cancel");
    const jobId = await seedJob(db, "test-cancel");

    // 第 1 个文件上传后置位取消信号
    await executeBackup(jobId, {}, { shouldCancel: () => uploaded.length >= 1 });

    expect(uploaded.length).toBe(1);
    const [row] = await db.select().from(schema.backupJobs).where(eq(schema.backupJobs.id, jobId));
    expect(row?.status).toBe("cancelled");
    // 取消不是故障：不写 error，调用方不该按失败重试
    expect(row?.error).toBeNull();
    const files = await db.select().from(schema.backupJobFiles).where(eq(schema.backupJobFiles.jobId, jobId));
    expect(files.length).toBe(1);
  });
});
