import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * P2 备份调度根治（碧霄 2026-11-14，生产 runs 687-692 实录驱动）：
 * ① applyRetention 不得删被 restore_jobs 引用的老 run（FK 无级联，现网 FOREIGN KEY
 *    constraint failed 实证）——引用即历史痕迹，保留并跳过；
 * ② retention 任何失败不得把 completed run 污染成 failed（生产 692：completed 之后
 *    链尾 .catch 把任务改成 failed）；
 * ③ retryCount 语义：拾取运行时不许清零（清零后失败分支永远读 0 → 永远"retry 1/3"
 *    无限循环，生产 687→691 每分钟一轮实证），成功才清零，穷举后停手等下一个 cron。
 * 本文件用真实 SQLite（FK 必须真约束才有证据），execution/task-registry 是边界，mock。
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-characters-long!!";
});

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));
vi.mock("./task-registry", () => ({
  createTask: vi.fn(() => ({ taskId: "task-x" })),
  finishTask: vi.fn(),
  isCancelRequested: vi.fn(() => false),
}));
vi.mock("../backup-repositories/execution", () => ({
  executeBackup: vi.fn(async () => {}),
  effectiveRepoConfig: vi.fn(() => ({})),
}));

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { finishTask } from "./task-registry";
import { executeBackup } from "../backup-repositories/execution";
import { applyRetention, runDueBackupSchedules } from "./backup-scheduler";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function createDb() {
  const raw = new Database(":memory:");
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE backup_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL, sourcePath TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', progress INTEGER DEFAULT 0,
      filesTotal INTEGER DEFAULT 0, filesDone INTEGER DEFAULT 0, filesFailed INTEGER DEFAULT 0,
      manifest TEXT, config TEXT, cron TEXT,
      enabled TEXT NOT NULL DEFAULT 'false',
      nextRunAt INTEGER, keepLastN INTEGER DEFAULT 7, maxRetries INTEGER DEFAULT 3,
      retryCount INTEGER DEFAULT 0, error TEXT,
      startedAt INTEGER, completedAt INTEGER, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE backup_job_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId INTEGER NOT NULL, relativePath TEXT NOT NULL,
      size INTEGER, checksum TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (jobId) REFERENCES backup_jobs(id)
    );
    CREATE TABLE restore_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backupJobId INTEGER NOT NULL, targetPath TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', progress INTEGER DEFAULT 0,
      filesTotal INTEGER DEFAULT 0, filesDone INTEGER DEFAULT 0, filesFailed INTEGER DEFAULT 0,
      manifestVerified TEXT NOT NULL DEFAULT 'pending', error TEXT,
      startedAt INTEGER, completedAt INTEGER, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (backupJobId) REFERENCES backup_jobs(id)
    );
  `);
  return { raw, db: drizzle(raw, { schema }) };
}

let raw: Database.Database;
let db: Db;
const TARGET = "fktest";

function seedSchedule(over: Partial<{ keepLastN: number; maxRetries: number; retryCount: number; cron: string | null; nextRunAt: Date; enabled: "true" | "false" }> = {}) {
  const res = db.insert(schema.backupJobs).values({
    target: TARGET, sourcePath: "/srv", status: "pending",
    enabled: over.enabled ?? "true",
    cron: over.cron ?? "0 2 * * *",
    nextRunAt: over.nextRunAt ?? new Date(Date.now() - 10_000),
    keepLastN: over.keepLastN ?? 5,
    maxRetries: over.maxRetries ?? 3,
    retryCount: over.retryCount ?? 0,
    createdAt: new Date(0), updatedAt: new Date(0),
  }).run() as unknown as { lastInsertRowid: number | bigint };
  return Number(res.lastInsertRowid);
}

function seedCompletedRun(id: number, completedAtMs: number) {
  db.insert(schema.backupJobs).values({
    id, target: TARGET, sourcePath: "/srv", status: "completed",
    enabled: "false", completedAt: new Date(completedAtMs),
    createdAt: new Date(completedAtMs), updatedAt: new Date(completedAtMs),
  }).run();
  db.insert(schema.backupJobFiles).values({ jobId: id, relativePath: `f-${id}.bin`, createdAt: new Date(completedAtMs) }).run();
}

function hasJob(id: number): boolean {
  return db.select({ id: schema.backupJobs.id }).from(schema.backupJobs).where(eq(schema.backupJobs.id, id)).all().length > 0;
}
function jobFiles(id: number): number {
  return db.select({ id: schema.backupJobFiles.id }).from(schema.backupJobFiles).where(eq(schema.backupJobFiles.jobId, id)).all().length;
}
function scheduleRow(id: number) {
  return db.select().from(schema.backupJobs).where(eq(schema.backupJobs.id, id)).all()[0];
}
const flush = () => new Promise((r) => setTimeout(r, 40));

beforeEach(() => {
  vi.clearAllMocks();
  const made = createDb();
  raw = made.raw;
  db = made.db;
  vi.mocked(getDb).mockReturnValue(db as never);
  vi.mocked(executeBackup).mockImplementation(async () => {});
});

describe("① retention 对 restore_jobs 引用的 FK 保护（真约束，非 fake 计数）", () => {
  it("被恢复作业引用的老 run 保留不删、不抛错；未引用的照常删", async () => {
    const sid = seedSchedule({ keepLastN: 2 });
    seedCompletedRun(10, 1_000);
    seedCompletedRun(11, 2_000);
    seedCompletedRun(12, 3_000);
    seedCompletedRun(13, 4_000);
    // 老 run 10 曾被用来恢复过一次——它带着历史痕迹，retention 不能把它连引用撕掉
    raw.prepare("INSERT INTO restore_jobs (backupJobId, targetPath, createdAt, updatedAt) VALUES (10, '/tmp/r', 0, 0)").run();

    await expect(applyRetention(sid)).resolves.toBeUndefined();

    expect(hasJob(10)).toBe(true);           // 引用者：保留
    expect(jobFiles(10)).toBe(1);            // 它的文件也在（run 没删）
    expect(hasJob(11)).toBe(false);          // keepLastN=2 → 13,12 留，11 删
    expect(jobFiles(11)).toBe(0);
    expect(hasJob(12)).toBe(true);
    expect(hasJob(13)).toBe(true);
  });

  it("无引用时 retention 正常批量删除（既有语义不回归）", async () => {
    const sid = seedSchedule({ keepLastN: 2 });
    seedCompletedRun(10, 1_000);
    seedCompletedRun(11, 2_000);
    seedCompletedRun(12, 3_000);

    await applyRetention(sid);

    expect(hasJob(10)).toBe(false);
    expect(jobFiles(10)).toBe(0);
    expect(hasJob(11)).toBe(true);
    expect(hasJob(12)).toBe(true);
  });
});

describe("② retention 故障隔离：completed 的运行不许被污染成 failed", () => {
  it("retention 删除抛错（注入触发器）时任务保持 completed，绝不 finishTask failed", async () => {
    const sid = seedSchedule({ keepLastN: 1 });
    seedCompletedRun(10, 1_000);
    seedCompletedRun(11, 2_000);
    raw.exec(`CREATE TRIGGER boom BEFORE DELETE ON backup_job_files
      BEGIN SELECT RAISE(ABORT, 'injected retention failure'); END;`);
    vi.mocked(executeBackup).mockImplementation(async (jobId: number) => {
      raw.prepare("UPDATE backup_jobs SET status='completed', completedAt=? WHERE id=?").run(Date.now(), jobId);
    });

    await runDueBackupSchedules();
    await flush();

    const calls = vi.mocked(finishTask).mock.calls.map((c) => c[1]);
    expect(calls).toContain("completed");
    expect(calls).not.toContain("failed");
  });
});

describe("③ retryCount 语义：拾取不清零、成功才清零、穷举即停", () => {
  it("拾取运行（结果未定）不得重置 retryCount——它是连续失败计数", async () => {
    const sid = seedSchedule({ retryCount: 2 });
    // executeBackup 什么都不做 → run 停在 pending（既不成功也不失败）

    await runDueBackupSchedules();
    await flush();

    expect(scheduleRow(sid).retryCount).toBe(2); // 现行代码=0（拾取清零 → 无限 1/3 循环的根）
  });

  it("运行成功后 retryCount 清零", async () => {
    const sid = seedSchedule({ retryCount: 2 });
    vi.mocked(executeBackup).mockImplementation(async (jobId: number) => {
      raw.prepare("UPDATE backup_jobs SET status='completed', completedAt=? WHERE id=?").run(Date.now(), jobId);
    });

    await runDueBackupSchedules();
    await flush();

    expect(scheduleRow(sid).retryCount).toBe(0);
  });

  it("retryCount 已达 maxRetries 时失败不再排重试，nextRunAt 留在下个 cron", async () => {
    const t0 = Date.now();
    const sid = seedSchedule({ retryCount: 3, maxRetries: 3 });
    vi.mocked(executeBackup).mockImplementation(async (jobId: number) => {
      raw.prepare("UPDATE backup_jobs SET status='failed', error='injected' WHERE id=?").run(jobId);
    });

    await runDueBackupSchedules();
    await flush();

    const row = scheduleRow(sid);
    expect(row.retryCount).toBe(3);                      // 现行：拾取清零后失败分支又写回 1
    const next = (row.nextRunAt as unknown as Date).getTime
      ? (row.nextRunAt as unknown as Date).getTime()
      : (row.nextRunAt as unknown as number);
    expect(next).toBeGreaterThan(t0 + 10 * 60_000);      // 现行：backoff ≈ t0+1min
  });
});
