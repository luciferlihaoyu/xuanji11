/**
 * P0-4：长任务统一句柄（task_get / task_cancel + backup_trigger 返回 taskId）
 *
 * 真实 SQLite 内存库 + 真实调度器，只把「备份执行器」换成 no-op（不真的上传），
 * 这样测的是任务句柄与业务表状态的联动，而不是 mock。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 导入期就会读 env（api/lib/env.ts 缺失即 process.exit(1)），必须在模块加载前打桩
vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";
import { vectorEngine } from "./lib/vector";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import { eq } from "drizzle-orm";
import { executeBackup } from "./backup-repositories/execution";
import { createTask, getTask, isCancelRequested, listTasks, resetTaskRegistryForTest } from "./lib/task-registry";
import { getActiveReindexTaskId, getReindexProgress } from "./lib/document-indexer";

vi.mock("./lib/auth", async () => {
  const actual = await vi.importActual<typeof import("./lib/auth")>("./lib/auth");
  return { ...actual, authenticateApiKey: vi.fn() };
});
vi.mock("./local-auth", () => ({ authenticateLocalRequest: vi.fn() }));
vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));
vi.mock("./lib/vector", () => ({
  vectorEngine: { size: 42, countByDocumentId: vi.fn(), deleteByDocumentId: vi.fn(), deleteCollection: vi.fn() },
  initializeZvec: vi.fn(),
}));
vi.mock("./lib/document-indexer", () => ({
  tryIndexDocumentById: vi.fn(),
  startReindexAll: vi.fn(() => ({ running: true, total: 4, done: 0, failed: 0, chunksTotal: 0 })),
  getReindexProgress: vi.fn(() => ({ running: true, total: 4, done: 1, failed: 0, chunksTotal: 0 })),
  // 默认「没有正在跑的回填」；需要模拟「已在跑」时用 vi.mocked(...).mockReturnValue(id)
  getActiveReindexTaskId: vi.fn(() => undefined),
}));
// 备份执行器换成替身：**默认挂起**（保持「运行中」语义），
// 各用例用 completeRun() / vi.mocked(executeBackup).mockImplementation 自行决定何时收尾
vi.mock("./backup-repositories/execution", () => ({ executeBackup: vi.fn(() => new Promise<void>(() => {})) }));

const fullAuth = (): AuthInfo => ({
  type: "apiKey",
  userId: 1,
  scopes: ["documents:read", "documents:write", "knowledge:read", "knowledge:write", "backups:read", "backups:write", "workflows:read", "workflows:write"],
});
const fakeUser = (): User => ({ id: 1, name: "审查员", role: "admin" } as User);
const authHeaders = () => new Headers({ Authorization: "Bearer test-key" });

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
    CREATE TABLE workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  return drizzle(sqlite, { schema: { ...schema, ...relations } });
}

function seedSchedule(db: ReturnType<typeof createTestDb>): number {
  const r = db.insert(schema.backupJobs).values({
    target: "alist", sourcePath: "/x", status: "pending", cron: "0 3 * * *", enabled: "false",
  }).run() as unknown as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

/** JSON-RPC 响应联合类型里 result 不一定存在，测试里统一用这个取结果对象 */
function resultObj(res: unknown): { isError?: boolean; content: Array<{ text: string }> } {
  return (res as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
}

function resultText(res: unknown): string {
  return (res as { result: { content: Array<{ text: string }> } }).result.content[0].text;
}

async function callTool(name: string, args: Record<string, unknown>, id = 99) {
  const { handleMcpRequest } = await import("./mcp-server");
  return handleMcpRequest(
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    authHeaders(),
  );
}

/** 让下一次备份执行立刻按「成功完成」收尾（模拟一次正常结束的运行） */
async function completeRun(): Promise<void> {
  const { executeBackup } = await import("./backup-repositories/execution");
  vi.mocked(executeBackup).mockImplementation(async (jobId: number) => {
    await getDb()
      .update(schema.backupJobs)
      .set({ status: "completed", progress: 100, completedAt: new Date() })
      .where(eq(schema.backupJobs.id, jobId));
  });
}

beforeEach(() => {
  // 不能 resetModules：那会让测试持有的 task-registry 与工具内部用的不是同一个实例
  vi.mocked(executeBackup).mockImplementation(() => new Promise<void>(() => {}));
  resetTaskRegistryForTest();
  vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: fullAuth() });
  vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
});

describe("P0-4 长任务句柄", () => {
  it("tools/list 暴露 task_get / task_cancel，注解与语义一致", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const { handleMcpRequest } = await import("./mcp-server");
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, authHeaders());
    const tools = (res as { result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> } }).result.tools;
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.has("task_get")).toBe(true);
    expect(byName.has("task_cancel")).toBe(true);
    expect(byName.get("task_get")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("task_cancel")).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it("backup_trigger 立即返回任务句柄，句柄能查到 run 与状态", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const scheduleId = seedSchedule(db);
    await completeRun();

    const res = await callTool("backup_trigger", { jobId: scheduleId });
    const payload = JSON.parse(resultText(res)) as { taskId: string; runJobId: number; scheduleId: number; status: string };
    expect(payload.taskId).toMatch(/^tsk_backup_/);
    expect(payload.scheduleId).toBe(scheduleId);
    expect(payload.runJobId).toBeGreaterThan(scheduleId);
    expect(payload.status).toBe("running");

    const got = JSON.parse(resultText(await callTool("task_get", { taskId: payload.taskId }, 100)));
    expect(got).toMatchObject({ taskId: payload.taskId, kind: "backup", refId: payload.runJobId, status: "completed" });
    expect(got.progress).toBe(100);
  });

  it("task_get 以业务表为真相：run 行变了，句柄状态跟着变", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const scheduleId = seedSchedule(db);
    const { taskId, runJobId } = JSON.parse(resultText(await callTool("backup_trigger", { jobId: scheduleId }))) as { taskId: string; runJobId: number };

    // 模拟运行中：进度 40/100
    await db.update(schema.backupJobs).set({ status: "running", progress: 40, filesTotal: 10, filesDone: 4 }).where(eq(schema.backupJobs.id, runJobId));
    const running = JSON.parse(resultText(await callTool("task_get", { taskId }, 101)));
    expect(running).toMatchObject({ status: "running", progress: 40 });
    expect(running.meta).toMatchObject({ filesTotal: 10, filesDone: 4 });

    // 模拟失败
    await db.update(schema.backupJobs).set({ status: "failed", error: "磁盘满" }).where(eq(schema.backupJobs.id, runJobId));
    const failed = JSON.parse(resultText(await callTool("task_get", { taskId }, 102)));
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("磁盘满");
  });

  it("task_get 未知句柄 → isError（不假装有任务）", async () => {
    vi.mocked(getDb).mockReturnValue(createTestDb());
    const res = await callTool("task_get", { taskId: "tsk_backup_nope" });
    expect((res as { result: { isError?: boolean } }).result.isError).toBe(true);
    expect(resultText(res)).toContain("Task not found");
  });

  it("task_cancel 对未知/已终结任务不谎报成功", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const unknown = await callTool("task_cancel", { taskId: "tsk_backup_nope" }, 110);
    expect((unknown as { result: { isError?: boolean } }).result.isError).toBe(true);

    const scheduleId = seedSchedule(db);
    await completeRun();
    const { taskId } = JSON.parse(resultText(await callTool("backup_trigger", { jobId: scheduleId }, 111))) as { taskId: string };
    // 该 run 已被 mock 执行器标成 completed → 取消必须被拒并说明原因
    const done = JSON.parse(resultText(await callTool("task_cancel", { taskId }, 112))) as { accepted: boolean; reason?: string; status: string };
    expect(done.accepted).toBe(false);
    expect(done.reason).toContain("completed");
    expect(done.status).toBe("completed");
  });

  it("task_cancel 接受运行中任务的取消请求，并把信号留在句柄上供执行方收手", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const scheduleId = seedSchedule(db);
    const { taskId, runJobId } = JSON.parse(resultText(await callTool("backup_trigger", { jobId: scheduleId }, 120))) as { taskId: string; runJobId: number };

    // 让它回到运行中，再请求取消
    await db.update(schema.backupJobs).set({ status: "running", progress: 30 }).where(eq(schema.backupJobs.id, runJobId));
    const cancelled = JSON.parse(resultText(await callTool("task_cancel", { taskId }, 121))) as { accepted: boolean; status: string };
    expect(cancelled.accepted).toBe(true);
    expect(cancelled.status).toBe("running");
    expect(getTask(taskId)).toBeDefined();
  });

  it("backup_trigger 对不存在的调度返回 isError，不返回假句柄", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const res = await callTool("backup_trigger", { jobId: 999999 });
    expect((res as { result: { isError?: boolean } }).result.isError).toBe(true);
  });

  it("重建索引同样走统一句柄：kb.reindex_all 返回 taskId，task_get 反映进度", async () => {
    vi.mocked(getDb).mockReturnValue(createTestDb());
    const r = JSON.parse(resultText(await callTool("kb.reindex_all", {}, 130))) as { taskId: string; running: boolean };
    expect(r.taskId).toMatch(/^tsk_reindex_/);
    expect(r.running).toBe(true);

    const got = JSON.parse(resultText(await callTool("task_get", { taskId: r.taskId }, 131))) as { kind: string; status: string; progress: number };
    expect(got.kind).toBe("reindex");
    expect(got.status).toBe("running");
    // 进度来自 getReindexProgress（mock：done=1/total=4 → 25）
    expect(got.progress).toBe(25);
  });

  it("task_cancel 对重建索引：接受取消请求并留下信号，状态仍 running 等执行方确认", async () => {
    vi.mocked(getDb).mockReturnValue(createTestDb());
    const r = JSON.parse(resultText(await callTool("kb.reindex_all", {}, 140))) as { taskId: string };
    const c = JSON.parse(resultText(await callTool("task_cancel", { taskId: r.taskId }, 141))) as { accepted: boolean; status: string };
    expect(c.accepted).toBe(true);
    expect(c.status).toBe("running");
  });

  it("回填已在跑时再调 kb.reindex_all：复用同一句柄，绝不新造无人轮询的孤儿句柄", async () => {
    vi.mocked(getDb).mockReturnValue(createTestDb());
    // 场景：索引器报告「已有句柄在跑」（真实实现在 startReindexAll 幂等分支里认领句柄）
    const running = createTask({ kind: "reindex" });
    vi.mocked(getActiveReindexTaskId).mockReturnValue(running.taskId);

    const r = JSON.parse(resultText(await callTool("kb.reindex_all", {}, 150))) as { taskId: string; reused: boolean; adopted: boolean };

    expect(r.taskId).toBe(running.taskId);
    expect(r.reused).toBe(true); // 已有运行在跑，本次没有新起
    expect(r.adopted).toBe(false); // 句柄本来就有，无需认领
    // 关键：没有产生第二个回填句柄（修复前这里会是 2 个 → 那个新句柄没人轮询，取消它也是空转）
    expect(listTasks({ kind: "reindex" })).toHaveLength(1);
    // 复用句柄的取消依然是有效信号
    const c = JSON.parse(resultText(await callTool("task_cancel", { taskId: r.taskId }, 151))) as { accepted: boolean };
    expect(c.accepted).toBe(true);
    expect(isCancelRequested(running.taskId)).toBe(true);
  });

  it("backup_trigger 不再把调度行的 enabled 改成 true（force 直取，避免把行弄成 due）", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    const scheduleId = seedSchedule(db);
    await completeRun();

    const res = await callTool("backup_trigger", { jobId: scheduleId });
    expect(resultObj(res).isError).toBeUndefined();

    const [row] = await db.select().from(schema.backupJobs).where(eq(schema.backupJobs.id, scheduleId));
    // 原来无条件写 enabled="true" + nextRunAt=now，运行行一旦被传进来就会被 tick 当成调度再跑一遍
    expect(row?.enabled).toBe("false");
    // 但本次运行确实发生了（nextRunAt 由调度器按 cron 重算）
    expect(row?.nextRunAt).toBeInstanceOf(Date);
  });

  it("backup_trigger 对运行行（无 cron）拒绝，不派生第二份备份", async () => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    // 运行行：同表的每次运行记录，cron 为空 —— 它不能被当成调度再触发
    const r = db.insert(schema.backupJobs).values({
      target: "local", sourcePath: "/__probe__", status: "completed", progress: 100,
    }).run() as unknown as { lastInsertRowid: number | bigint };
    const runRowId = Number(r.lastInsertRowid);

    const res = await callTool("backup_trigger", { jobId: runRowId });
    expect(resultObj(res).isError).toBe(true);
    expect(resultText(res)).toContain("不是定时调度");
    // 且没有派生出新的运行行
    const rows = await db.select().from(schema.backupJobs);
    expect(rows).toHaveLength(1);
  });

  it("无在跑回填时，kb.reindex_all 真的启动一次：reused=false / adopted=false", async () => {
    vi.mocked(getDb).mockReturnValue(createTestDb());
    vi.mocked(getActiveReindexTaskId).mockReturnValue(undefined);
    vi.mocked(getReindexProgress).mockReturnValue({ running: false, total: 0, done: 0, failed: 0, chunksTotal: 0 });

    const r = JSON.parse(resultText(await callTool("kb.reindex_all", {}, 160))) as { taskId: string; reused: boolean; adopted: boolean };

    expect(r.taskId).toMatch(/^tsk_reindex_/);
    expect(r.reused).toBe(false);
    expect(r.adopted).toBe(false);
    expect(listTasks({ kind: "reindex" })).toHaveLength(1);
  });

  it("控制台直接发起的回填（无句柄）被认领：adopted=true，且此后可取消", async () => {
    vi.mocked(getDb).mockReturnValue(createTestDb());
    // 运行在跑但没有句柄（UI 走 kb.reindexAll 直接 startReindexAll()）
    vi.mocked(getActiveReindexTaskId).mockReturnValue(undefined);
    vi.mocked(getReindexProgress).mockReturnValue({ running: true, total: 4, done: 2, failed: 0, chunksTotal: 0 });

    const r = JSON.parse(resultText(await callTool("kb.reindex_all", {}, 170))) as { taskId: string; reused: boolean; adopted: boolean };

    expect(r.taskId).toMatch(/^tsk_reindex_/);
    expect(r.reused).toBe(true); // 没新起运行
    expect(r.adopted).toBe(true); // 认领了原本没有句柄的那次运行
    expect(listTasks({ kind: "reindex" })).toHaveLength(1);
  });
});
