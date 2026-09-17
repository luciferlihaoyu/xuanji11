import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import type { BackupJob, RestoreJob, User } from "@db/schema";
import { backupJobs, backupJobFiles, restoreJobs } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";
import { env } from "./lib/env";

vi.hoisted(() => {
  const tmp = `/tmp/xuanji-backup-router-test-${process.pid}`;
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
  process.env.BACKUP_ENCRYPTION_KEY = "";
  process.env.BACKUP_TEMP_DIR = tmp;
  process.env.UPLOAD_DIR = tmp;
});

vi.mock("./lib/auth", async () => {
  const actual = await vi.importActual<typeof import("./lib/auth")>("./lib/auth");
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
  };
});

vi.mock("./local-auth", () => ({
  authenticateLocalRequest: vi.fn(),
}));

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  createPool: vi.fn(),
}));

import { backupRouter } from "./backup-router";
import { nextCronTime } from "./lib/backup-scheduler";
import { executeRestore } from "./backup-repositories/restore";
import { registerBackupRepository, type BackupRepository } from "./backup-repositories/base";
import { encryptBuffer } from "./backup-repositories/crypto";
import { createPool } from "mysql2/promise";

const mockedCreatePool = vi.mocked(createPool);
const tmpRoot = path.join(os.tmpdir(), `xuanji-backup-router-test-${process.pid}`);

function fakeUser(): User {
  return {
    id: 1,
    unionId: "local_admin",
    name: "admin",
    email: null,
    avatar: null,
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignInAt: new Date(),
  };
}

function adminContext() {
  return {
    req: new Request("http://localhost:3000/"),
    resHeaders: new Headers(),
    user: fakeUser(),
    auth: { type: "session", userId: 1 } as AuthInfo,
  };
}

function caller(): ReturnType<typeof backupRouter.createCaller> {
  return backupRouter.createCaller(adminContext() as never);
}

function sampleBackupJob(overrides: Partial<BackupJob> = {}): BackupJob {
  return {
    id: 1,
    target: "alist",
    sourcePath: "bundle",
    status: "pending",
    progress: 0,
    filesTotal: 0,
    filesDone: 0,
    filesFailed: 0,
    manifest: null,
    config: { url: "https://alist.example.com/dav", username: "user", password: "pw" },
    cron: null,
    enabled: "false",
    nextRunAt: null,
    keepLastN: 7,
    maxRetries: 3,
    retryCount: 0,
    error: null,
    startedAt: null,
    completedAt: null,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

function sampleRestoreJob(overrides: Partial<RestoreJob> = {}): RestoreJob {
  return {
    id: 5,
    backupJobId: 3,
    targetPath: path.join(tmpRoot, "restore-out"),
    status: "pending",
    progress: 0,
    filesTotal: 0,
    filesDone: 0,
    filesFailed: 0,
    manifestVerified: "pending",
    error: null,
    startedAt: null,
    completedAt: null,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

interface FakeDbOptions {
  backupJobRows?: BackupJob[];
  backupJobFileRows?: unknown[];
  restoreJobRows?: RestoreJob[];
  insertId?: number;
}

function createFakeDb(options: FakeDbOptions = {}) {
  const restoreUpdates: Record<string, unknown>[] = [];
  const backupUpdates: Record<string, unknown>[] = [];
  const insertedBackupValues: Record<string, unknown>[] = [];
  const rowsFor = (table: unknown): unknown[] => {
    if (table === backupJobs) return options.backupJobRows ?? [];
    if (table === backupJobFiles) return options.backupJobFileRows ?? [];
    if (table === restoreJobs) return options.restoreJobRows ?? [];
    return [];
  };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const rows = rowsFor(table);
        return {
          where: vi.fn(() => Promise.resolve(rows)),
          orderBy: vi.fn(() => Promise.resolve(rows)),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((data: Record<string, unknown>) => {
        if (table === backupJobs) insertedBackupValues.push(data);
        return Promise.resolve([{ insertId: options.insertId ?? 42 }]);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: Record<string, unknown>) => {
        if (table === restoreJobs) restoreUpdates.push(data);
        if (table === backupJobs) backupUpdates.push(data);
        return {
          where: vi.fn(() => Promise.resolve([{ affectedRows: 1 }])),
        };
      }),
    })),
    delete: vi.fn((_table: unknown) => ({
      where: vi.fn(() => Promise.resolve([{ affectedRows: 1 }])),
    })),
  };
  return { ...db, restoreUpdates, backupUpdates, insertedBackupValues };
}

/** 最后一次针对 restoreJobs 的 update 数据（含最终 status/manifestVerified）。 */
function lastRestoreUpdate(fakeDb: ReturnType<typeof createFakeDb>): Record<string, unknown> {
  return fakeDb.restoreUpdates.at(-1) ?? {};
}

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

function fakeDbPool() {
  const conn = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("START TRANSACTION") || sql === "COMMIT" || sql === "ROLLBACK") return [[], []];
      if (sql.includes("information_schema.tables")) return [[], []];
      if (sql.includes("information_schema.columns")) return [[], []];
      if (sql.startsWith("SELECT * FROM")) return [[], []];
      return [[], []];
    }),
    release: vi.fn(),
  };
  return {
    getConnection: vi.fn().mockResolvedValue(conn),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("backup router target registry", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: adminContext().auth });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);
    mockedCreatePool.mockReturnValue(fakeDbPool() as never);
  });

  it("lists alist/nas/local as available and legacy 115/aliyundrive as unavailable", async () => {
    const targets = (await caller().targets()) as Array<{ key: string; available: boolean; deprecated?: boolean }>;
    const byKey = new Map(targets.map((t) => [t.key, t]));
    expect(byKey.get("alist")?.available).toBe(true);
    expect(byKey.get("nas")?.available).toBe(true);
    expect(byKey.get("local")?.available).toBe(true);
    expect(byKey.get("115")).toMatchObject({ available: false, deprecated: true });
    expect(byKey.get("aliyundrive")).toMatchObject({ available: false, deprecated: true });
  });

  it("rejects creating a legacy 115 target", async () => {
    await expect(
      caller().create({ target: "115" as "alist", sourcePath: "/tmp/x", config: {} })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects creating an alist target when BACKUP_ENCRYPTION_KEY is empty", async () => {
    await expect(
      caller().create({
        target: "alist",
        sourcePath: "bundle",
        config: { url: "https://alist.example.com/dav", username: "user", password: "pw" },
      })
    ).rejects.toThrow(/BACKUP_ENCRYPTION_KEY/);
  });

  it("creates an alist job when the encryption key is set and never returns credentials", async () => {
    env.backupEncryptionKey = "test-encryption-key";
    const repo = fakeRepo();
    registerBackupRepository("alist", repo);
    const jobRow = sampleBackupJob({ target: "alist", config: { url: "https://alist.example.com/dav", username: "user", password: "pw" } });
    const fakeDb = createFakeDb({ backupJobRows: [jobRow], insertId: 1 });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    const result = (await caller().create({
      target: "alist",
      sourcePath: "bundle",
      config: { url: "https://alist.example.com/dav", username: "user", password: "pw" },
    })) as Record<string, unknown>;

    expect(fakeDb.insert).toHaveBeenCalled();
    const inserted = fakeDb.insert.mock.calls[0][0];
    expect(inserted).toBe(backupJobs);
    expect(result.hasConfig).toBe(true);
    expect(JSON.stringify(result)).not.toContain("pw");
    expect(JSON.stringify(result)).not.toContain("password");

    const uploadMock = vi.mocked(repo.uploadFile);
    // the async executeBackup should push files through the repo
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    // manifest.json is uploaded last
    const uploadedPaths = uploadMock.mock.calls.map((c) => c[1] as string);
    expect(uploadedPaths[uploadedPaths.length - 1]).toBe("manifest.json");
  });

  afterEach(() => {
    env.backupEncryptionKey = "";
    fs.rmSync(path.join(tmpRoot, "staging-1"), { recursive: true, force: true });
    fs.rmSync(path.join(tmpRoot, "staging-42"), { recursive: true, force: true });
  });
});

describe("定时计划的 nextRunAt 维护", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: adminContext().auth });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    env.backupEncryptionKey = "test-encryption-key";
    registerBackupRepository("alist", fakeRepo());
    mockedCreatePool.mockReturnValue(fakeDbPool() as never);
  });

  afterEach(() => {
    env.backupEncryptionKey = "";
  });

  it("nextCronTime 返回严格晚于当前时刻的下一次匹配时间", () => {
    const now = new Date("2026-09-17T10:37:12Z");
    const next = nextCronTime("0 2 * * *", now)!;
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getMinutes()).toBe(0);
    // 与本地时区无关：下一次 02:00 必然落在未来 24 小时内
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    // 对齐到分钟边界：10:37:12 → 10:38:00（48 秒后），而不是整 60 秒
    const everyMinute = nextCronTime("* * * * *", now)!;
    expect(everyMinute.getSeconds()).toBe(0);
    expect(everyMinute.getMilliseconds()).toBe(0);
    expect(everyMinute.getTime()).toBeGreaterThan(now.getTime());
    expect(everyMinute.getTime() - now.getTime()).toBeLessThanOrEqual(60_000);
  });

  it("创建已启用的定时计划时写入 nextRunAt（否则调度器永远选不中）", async () => {
    const fakeDb = createFakeDb({ backupJobRows: [sampleBackupJob({ id: 7 })], insertId: 7 });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await caller().create({
      target: "alist",
      sourcePath: "bundle",
      config: { url: "https://alist.example.com/dav", username: "user", password: "pw" },
      cron: "0 2 * * *",
      enabled: true,
    });

    const inserted = fakeDb.insertedBackupValues.at(-1)!;
    expect(inserted.cron).toBe("0 2 * * *");
    expect(inserted.enabled).toBe("true");
    const next = inserted.nextRunAt as Date;
    expect(next).toBeInstanceOf(Date);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getMinutes()).toBe(0);
  });

  it("创建但未启用时 nextRunAt 为 null", async () => {
    const fakeDb = createFakeDb({ backupJobRows: [sampleBackupJob({ id: 8 })], insertId: 8 });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await caller().create({
      target: "alist",
      sourcePath: "bundle",
      config: { url: "https://alist.example.com/dav", username: "user", password: "pw" },
      cron: "0 2 * * *",
      enabled: false,
    });

    expect(fakeDb.insertedBackupValues.at(-1)!.nextRunAt).toBeNull();
  });

  it("改 cron 后 nextRunAt 重算到新时间点", async () => {
    const row = sampleBackupJob({ id: 5, cron: "0 2 * * *", enabled: "true", nextRunAt: new Date() });
    const fakeDb = createFakeDb({ backupJobRows: [row] });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await caller().updateSchedule({ id: 5, cron: "30 3 * * *" });

    const updated = fakeDb.backupUpdates.at(-1)!;
    expect(updated.cron).toBe("30 3 * * *");
    const next = updated.nextRunAt as Date;
    expect(next).toBeInstanceOf(Date);
    expect(next.getMinutes()).toBe(30);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it("禁用计划时 nextRunAt 置空（不再参与调度）", async () => {
    const row = sampleBackupJob({ id: 5, cron: "0 2 * * *", enabled: "true", nextRunAt: new Date() });
    const fakeDb = createFakeDb({ backupJobRows: [row] });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await caller().updateSchedule({ id: 5, enabled: false });

    const updated = fakeDb.backupUpdates.at(-1)!;
    expect(updated.enabled).toBe("false");
    expect(updated.nextRunAt).toBeNull();
  });
});

describe("backup job serialization", () => {
  beforeEach(() => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: adminContext().auth });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    mockedCreatePool.mockReturnValue(fakeDbPool() as never);
  });

  it("list output never contains credentials and marks hasConfig", async () => {
    const row = sampleBackupJob({
      config: { url: "u", username: "n", password: "p", accessToken: "at", refreshToken: "rt", token: "t" },
    });
    const fakeDb = createFakeDb({ backupJobRows: [row] });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    const result = await caller().list();
    const serialized = result[0] as Record<string, unknown>;
    expect(serialized.hasConfig).toBe(true);
    const json = JSON.stringify(result);
    expect(json).not.toContain("password");
    expect(json).not.toContain("accessToken");
    expect(json).not.toContain("refreshToken");
    expect(json).not.toContain("token");
  });

  it("getById and status strip credentials but keep files", async () => {
    const row = sampleBackupJob({ config: { password: "p", accessToken: "at" } });
    const fakeDb = createFakeDb({ backupJobRows: [row], backupJobFileRows: [{ id: 9, relativePath: "a.txt" }] });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    const byId = (await caller().getById({ id: 1 })) as Record<string, unknown>;
    expect(byId.files).toBeDefined();
    expect(JSON.stringify(byId)).not.toContain("password");
    expect(JSON.stringify(byId)).not.toContain("accessToken");

    const status = (await caller().status({ id: 1 })) as Record<string, unknown>;
    expect(JSON.stringify(status)).not.toContain("password");
    expect((status.files as unknown[]).length).toBe(1);
  });
});

describe("executeRestore uses the backup job's original target repository", () => {
  const restoreOut = path.join(tmpRoot, "restore-out");

  beforeEach(() => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: adminContext().auth });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    mockedCreatePool.mockReturnValue(fakeDbPool() as never);
    fs.rmSync(restoreOut, { recursive: true, force: true });
  });

  it("restores an unencrypted manifest-driven backup from the original repo", async () => {
    const backupJob = sampleBackupJob({
      id: 3,
      target: "alist",
      config: { url: "https://alist.example.com/dav", username: "u", password: "p" },
    });
    const manifest = {
      schemaVersion: 1,
      jobId: 3,
      target: "alist",
      createdAt: "2024-01-01T00:00:00Z",
      encrypted: false,
      files: [{ path: "data.txt", size: 5, checksum: "checksum-placeholder" }],
    };
    const content = Buffer.from("hello");
    manifest.files[0].checksum = createHash("sha256").update(content).digest("hex");

    const repo = fakeRepo({
      readFile: vi.fn(async (_c, rel: string) => {
        if (rel === "manifest.json") return Buffer.from(JSON.stringify(manifest));
        if (rel === "data.txt") return content;
        return null;
      }),
    });
    registerBackupRepository("alist", repo);

    const fakeDb = createFakeDb({
      restoreJobRows: [sampleRestoreJob()],
      backupJobRows: [backupJob],
    });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await executeRestore(5);

    expect(vi.mocked(repo.readFile)).toHaveBeenCalledWith(expect.anything(), "manifest.json");
    expect(fs.readFileSync(path.join(restoreOut, "data.txt"), "utf8")).toBe("hello");
    const updateCalls = fakeDb.update.mock.calls.map((c) => c[0]);
    expect(updateCalls).toContain(restoreJobs);
    const lastSet = lastRestoreUpdate(fakeDb);
    expect(lastSet.status).toBe("completed");
    expect(lastSet.manifestVerified).toBe("passed");
  });

  it("decrypts an encrypted manifest and files before checksum verification", async () => {
    env.backupEncryptionKey = "restore-test-key";
    const key = "restore-test-key";
    const backupJob = sampleBackupJob({
      id: 3,
      target: "alist",
      config: { url: "https://alist.example.com/dav", username: "u", password: "p" },
    });
    const content = Buffer.from("secret data");
    const checksum = createHash("sha256").update(content).digest("hex");
    const manifest = {
      schemaVersion: 1,
      jobId: 3,
      target: "alist",
      createdAt: "2024-01-01T00:00:00Z",
      encrypted: true,
      encryptionVersion: 1,
      files: [{ path: "secret.txt", size: content.length, checksum }],
    };
    const repo = fakeRepo({
      readFile: vi.fn(async (_c, rel: string) => {
        if (rel === "manifest.json") return encryptBuffer(Buffer.from(JSON.stringify(manifest)), key);
        if (rel === "secret.txt") return encryptBuffer(content, key);
        return null;
      }),
    });
    registerBackupRepository("alist", repo);

    const fakeDb = createFakeDb({
      restoreJobRows: [sampleRestoreJob()],
      backupJobRows: [backupJob],
    });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await executeRestore(5);

    expect(fs.readFileSync(path.join(restoreOut, "secret.txt"), "utf8")).toBe("secret data");
    const lastSet = lastRestoreUpdate(fakeDb);
    expect(lastSet.status).toBe("completed");
    expect(lastSet.manifestVerified).toBe("passed");
  });

  it("falls back to backup_job_files rows when the repo has no manifest", async () => {
    const backupJob = sampleBackupJob({
      id: 3,
      target: "nas",
      sourcePath: "/data/source",
      config: { path: path.join(tmpRoot, "nas-root") },
    });
    const content = Buffer.from("nas file");
    const checksum = createHash("sha256").update(content).digest("hex");
    fs.mkdirSync(path.join(tmpRoot, "nas-root"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "nas-root", "legacy.txt"), content);

    const repo = fakeRepo({
      readFile: vi.fn(async (_c, rel: string) => {
        if (rel === "manifest.json") return null;
        if (rel === "legacy.txt") return fs.readFileSync(path.join(tmpRoot, "nas-root", "legacy.txt"));
        return null;
      }),
    });
    registerBackupRepository("nas", repo);

    const fakeDb = createFakeDb({
      restoreJobRows: [sampleRestoreJob()],
      backupJobRows: [backupJob],
      backupJobFileRows: [{ id: 1, jobId: 3, relativePath: "legacy.txt", size: 8, checksum, status: "uploaded" }],
    });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await executeRestore(5);

    expect(fs.readFileSync(path.join(restoreOut, "legacy.txt"), "utf8")).toBe("nas file");
    const lastSet = lastRestoreUpdate(fakeDb);
    expect(lastSet.status).toBe("completed");
  });

  it("marks restore failed when a checksum does not match", async () => {
    const backupJob = sampleBackupJob({
      id: 3,
      target: "alist",
      config: { url: "https://alist.example.com/dav", username: "u", password: "p" },
    });
    const manifest = {
      schemaVersion: 1,
      jobId: 3,
      target: "alist",
      createdAt: "2024-01-01T00:00:00Z",
      encrypted: false,
      files: [{ path: "data.txt", size: 5, checksum: "0".repeat(64) }],
    };
    const repo = fakeRepo({
      readFile: vi.fn(async (_c, rel: string) => {
        if (rel === "manifest.json") return Buffer.from(JSON.stringify(manifest));
        if (rel === "data.txt") return Buffer.from("hello");
        return null;
      }),
    });
    registerBackupRepository("alist", repo);

    const fakeDb = createFakeDb({
      restoreJobRows: [sampleRestoreJob()],
      backupJobRows: [backupJob],
    });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await executeRestore(5);

    expect(lastRestoreUpdate(fakeDb).manifestVerified).toBe("failed");
  });

  afterEach(() => {
    env.backupEncryptionKey = "";
  });
});

describe("版本化快照目录（runDir）", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: adminContext().auth });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    env.backupEncryptionKey = "test-encryption-key";
    mockedCreatePool.mockReturnValue(fakeDbPool() as never);
  });

  afterEach(() => {
    env.backupEncryptionKey = "";
    fs.rmSync(path.join(tmpRoot, "staging-1"), { recursive: true, force: true });
  });

  it("支持快照目录的仓库：同一次运行共用一个 runDir，并把 remoteDir 记入 manifest", async () => {
    const repo = fakeRepo({ supportsRunDirs: true });
    registerBackupRepository("alist", repo);
    const jobRow = sampleBackupJob({ target: "alist" });
    const fakeDb = createFakeDb({ backupJobRows: [jobRow], insertId: 1 });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await caller().create({
      target: "alist",
      sourcePath: "bundle",
      config: { url: "https://alist.example.com/dav", username: "user", password: "pw" },
    });

    const uploadMock = vi.mocked(repo.uploadFile);
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));

    const runDirs = new Set(uploadMock.mock.calls.map((c) => (c[0] as Record<string, unknown>).runDir));
    expect(runDirs.size).toBe(1);
    const runDir = [...runDirs][0];
    expect(String(runDir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);

    const manifestUpdate = fakeDb.backupUpdates.find(
      (u) => Boolean((u.manifest as { files?: unknown[] } | undefined)?.files?.length)
    );
    expect((manifestUpdate?.manifest as Record<string, unknown>).remoteDir).toBe(runDir);
  });

  it("不支持快照目录的仓库：不注入 runDir（旧行为不变）", async () => {
    const repo = fakeRepo();
    registerBackupRepository("alist", repo);
    const jobRow = sampleBackupJob({ target: "alist" });
    const fakeDb = createFakeDb({ backupJobRows: [jobRow], insertId: 1 });
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await caller().create({
      target: "alist",
      sourcePath: "bundle",
      config: { url: "https://alist.example.com/dav", username: "user", password: "pw" },
    });

    const uploadMock = vi.mocked(repo.uploadFile);
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect((uploadMock.mock.calls[0][0] as Record<string, unknown>).runDir).toBeUndefined();
  });
});
