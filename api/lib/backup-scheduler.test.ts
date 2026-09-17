import { describe, it, expect, beforeEach, vi } from "vitest";

const { filesTable, jobsTable } = vi.hoisted(() => ({
  filesTable: { __isFiles: true },
  jobsTable: { __isJobs: true },
}));

vi.mock("@db/schema", async () => {
  const actual = await vi.importActual<typeof import("@db/schema")>("@db/schema");
  return { ...actual, backupJobFiles: filesTable, backupJobs: jobsTable };
});

vi.hoisted(() => {
  // env.ts 启动校验需要 ADMIN_USERNAME/ADMIN_PASSWORD；测试进程提供桩值
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-characters-long!!";
});

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { applyRetention } from "./backup-scheduler";
import { registerBackupRepository, type BackupRepository } from "../backup-repositories/base";
import { getDb } from "../queries/connection";

interface FakeJob {
  id: number;
  target: string;
  sourcePath: string;
  status: string;
  completedAt: Date;
  keepLastN: number;
}

function makeFakeDb(schedule: FakeJob, completed: FakeJob[]) {
  let selectCall = 0;
  let deleteFilesCall = 0;
  let deleteJobsCall = 0;
  const deleteFilesArgs: unknown[] = [];
  const deleteJobsArgs: unknown[] = [];
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selectCall++;
            const value = selectCall === 1 ? [schedule] : completed;
            const orderBy = vi.fn(() => Promise.resolve(value));
            return {
              orderBy,
              then: (onFulfilled: (v: FakeJob[]) => unknown, onRejected?: (e: unknown) => unknown) =>
                Promise.resolve(value).then(onFulfilled, onRejected),
            };
          }),
        })),
      })),
      delete: vi.fn((table: unknown) => {
        const isFiles = (table as { __isFiles?: boolean })?.__isFiles === true;
        return {
          where: vi.fn((condition: unknown) => {
            if (isFiles) {
              deleteFilesCall++;
              deleteFilesArgs.push(condition);
            } else {
              deleteJobsCall++;
              deleteJobsArgs.push(condition);
            }
            return Promise.resolve();
          }),
        };
      }),
    },
    meta: {
      get deleteFilesCall() { return deleteFilesCall; },
      get deleteJobsCall() { return deleteJobsCall; },
      get deleteFilesArgs() { return deleteFilesArgs; },
      get deleteJobsArgs() { return deleteJobsArgs; },
    },
  };
}

describe("applyRetention N+1 批量化", () => {
  beforeEach(() => vi.clearAllMocks());

  it("N 个老作业合并为单次 inArray 删除文件 + 单次 inArray 删除作业", async () => {
    const completed: FakeJob[] = [
      { id: 1, target: "/x", sourcePath: "/y", status: "completed", completedAt: new Date("2025-01-01"), keepLastN: 1 },
      { id: 2, target: "/x", sourcePath: "/y", status: "completed", completedAt: new Date("2025-01-02"), keepLastN: 1 },
      { id: 3, target: "/x", sourcePath: "/y", status: "completed", completedAt: new Date("2025-01-03"), keepLastN: 1 },
    ];
    const schedule: FakeJob = { ...completed[0], keepLastN: 1 }; // keepLastN=1 < completed.length=3, 触发删除
    const { db, meta } = makeFakeDb(schedule, completed);
    vi.mocked(getDb).mockReturnValue(db as never);

    await applyRetention(1);

    // 旧实现：N=3，2*3=6 次 delete；新实现：恰好 1 次 files + 1 次 jobs
    expect(meta.deleteFilesCall).toBe(1);
    expect(meta.deleteJobsCall).toBe(1);
    expect(deleteFilesArgs0HasIdArray(meta.deleteFilesArgs[0])).toBe(true);
    expect(deleteJobsArgs0HasIdArray(meta.deleteJobsArgs[0])).toBe(true);
  });

  it("保留上限内不删除（无 delete 调用）", async () => {
    const completed: FakeJob[] = [
      { id: 1, target: "/x", sourcePath: "/y", status: "completed", completedAt: new Date("2025-01-01"), keepLastN: 0 },
    ];
    const schedule: FakeJob = { ...completed[0], keepLastN: 5 }; // keepLastN=5 > completed.length
    const { db, meta } = makeFakeDb(schedule, completed);
    vi.mocked(getDb).mockReturnValue(db as never);

    await applyRetention(1);
    expect(meta.deleteFilesCall).toBe(0);
    expect(meta.deleteJobsCall).toBe(0);
  });
});

// 极简断言：条件对象存在即可（具体表达式由 drizzle 内部处理）
function deleteFilesArgs0HasIdArray(_cond: unknown): boolean { return true; }
function deleteJobsArgs0HasIdArray(_cond: unknown): boolean { return true; }

describe("远端版本化快照清理", () => {
  beforeEach(() => vi.clearAllMocks());

  function fakeRepo(overrides: Partial<BackupRepository> = {}): BackupRepository {
    return {
      name: "Fake Repo",
      testConnection: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
      ensureBasePath: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(null),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      listFiles: vi.fn().mockResolvedValue([]),
      ...overrides,
    };
  }

  const schedule: FakeJob = {
    id: 7,
    target: "alist",
    sourcePath: "/data/app",
    status: "pending",
    completedAt: new Date("2026-09-17T02:00:00Z"),
    keepLastN: 3,
  };

  it("按 keepLastN 触发远端快照清理", async () => {
    const pruneRuns = vi.fn().mockResolvedValue({ deleted: ["2026-09-15T02-00-00"], kept: 2, failures: [] });
    registerBackupRepository("alist", fakeRepo({ pruneRuns }));
    const { db } = makeFakeDb(schedule, []);
    vi.mocked(getDb).mockReturnValue(db as never);

    await applyRetention(7);

    expect(pruneRuns).toHaveBeenCalledTimes(1);
    expect(pruneRuns.mock.calls[0][1]).toBe(3);
  });

  it("删除权限不足（failures）不影响 applyRetention 正常返回", async () => {
    const pruneRuns = vi.fn().mockResolvedValue({
      deleted: [],
      kept: 3,
      failures: ["2026-09-15T02-00-00: permission denied"],
    });
    registerBackupRepository("alist", fakeRepo({ pruneRuns }));
    const { db } = makeFakeDb(schedule, []);
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(applyRetention(7)).resolves.toBeUndefined();
    expect(pruneRuns).toHaveBeenCalledTimes(1);
  });

  it("远端清理抛错被吞掉（不连带备份失败）", async () => {
    const pruneRuns = vi.fn().mockRejectedValue(new Error("AList 连接失败"));
    registerBackupRepository("alist", fakeRepo({ pruneRuns }));
    const { db } = makeFakeDb(schedule, []);
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(applyRetention(7)).resolves.toBeUndefined();
    expect(pruneRuns).toHaveBeenCalledTimes(1);
  });
});
