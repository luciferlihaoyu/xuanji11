import { eq, and, inArray, lte, desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { backupJobs, backupJobFiles, restoreJobs } from "@db/schema";
import { executeBackup, effectiveRepoConfig } from "../backup-repositories/execution";
import { getBackupRepository } from "../backup-repositories/base";
import type { BackupJob } from "@db/schema";
import { createTask, finishTask, isCancelRequested } from "./task-registry";
import { decideBackupOutcome } from "./task-sync";

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const vals: number[] = [];
    for (let i = min; i <= max; i++) vals.push(i);
    return vals;
  }
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return [];
    const vals: number[] = [];
    for (let i = min; i <= max; i += step) vals.push(i);
    return vals;
  }
  if (field.includes(",")) {
    return field.split(",").map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
  }
  const val = parseInt(field, 10);
  return isNaN(val) ? [] : [val];
}

function matchCron(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minuteStr, hourStr, dayStr, monthStr, weekdayStr] = parts;

  const minute = parseCronField(minuteStr, 0, 59);
  const hour = parseCronField(hourStr, 0, 23);
  const day = parseCronField(dayStr, 1, 31);
  const month = parseCronField(monthStr, 1, 12);
  const weekday = parseCronField(weekdayStr, 0, 6);

  return (
    minute.includes(date.getMinutes()) &&
    hour.includes(date.getHours()) &&
    day.includes(date.getDate()) &&
    month.includes(date.getMonth() + 1) &&
    weekday.includes(date.getDay())
  );
}

export function nextCronTime(schedule: string, after: Date): Date | null {
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matchCron(schedule, candidate)) return new Date(candidate);
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

async function executeBackupJob(
  jobId: number,
  connectorConfig: Record<string, unknown> = {},
  taskId?: string,
): Promise<void> {
  console.log(`[BackupScheduler] Starting backup job ${jobId}`);
  // 执行逻辑统一走备份仓库抽象层（alist/nas/local 新仓库，115/aliyundrive 历史连接器）
  // P0-4：带上任务句柄的取消信号，task_cancel 才能真正让执行方在文件之间收手
  await executeBackup(jobId, connectorConfig, taskId ? { shouldCancel: () => isCancelRequested(taskId) } : {});
}

/** P0-4：一次备份运行的句柄（scheduleId=调度行，runJobId=本次运行行，taskId=统一任务句柄） */
export interface BackupRunHandle {
  readonly scheduleId: number;
  readonly runJobId: number;
  readonly taskId: string;
}

/** 备份运行行 → 任务终态（业务表是真相） */
function finishTaskFromRunRow(
  taskId: string,
  row: { status: string; progress?: number | null; error?: string | null; filesTotal?: number | null; filesDone?: number | null; filesFailed?: number | null } | undefined,
): void {
  if (!row) {
    finishTask(taskId, "failed", { error: "备份运行记录不存在" });
    return;
  }
  // 终态判定单点化（天演审查 Q7/Q2）：与 task_get 的读时收口共用同一函数，
  // settled=true 表示「执行方已收手」——此刻行还停在 pending/running 属异常
  const outcome = decideBackupOutcome(row, { settled: true });
  if (!outcome) {
    finishTask(taskId, "failed", { error: "备份运行记录不存在" });
    return;
  }
  finishTask(taskId, outcome.status, { progress: outcome.progress, error: outcome.error, meta: outcome.meta });
}

/**
 * 远端版本化快照清理：basePath 下每个 runDir 是一份完整快照，只保留最新 keepLastN 份。
 * 删除需要网盘删除权限；任何失败只告警——备份本身已经成功，清理不该把它变成失败。
 */
async function pruneRemoteRuns(schedule: BackupJob, keepLastN: number): Promise<void> {
  const repo = getBackupRepository(schedule.target);
  if (!repo?.pruneRuns) return;
  try {
    const config = effectiveRepoConfig(schedule.target, schedule.id, schedule.config ?? {});
    const result = await repo.pruneRuns(config, keepLastN);
    if (result.deleted.length > 0) {
      console.log(`[BackupScheduler] 远端快照清理：删除 ${result.deleted.length} 份，保留 ${result.kept} 份`);
    }
    if (result.failures.length > 0) {
      console.warn(
        `[BackupScheduler] 远端快照删除失败 ${result.failures.length} 份（通常为网盘账号缺少删除权限）：${result.failures.join("; ")}`
      );
    }
  } catch (err) {
    console.warn(`[BackupScheduler] 远端快照清理异常（不影响备份结果）：${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function applyRetention(scheduleJobId: number): Promise<void> {
  const db = getDb();
  const [schedule] = await db.select().from(backupJobs).where(eq(backupJobs.id, scheduleJobId));
  if (!schedule || !schedule.keepLastN || schedule.keepLastN <= 0) return;

  // 远端快照先清理（与本地记录清理相互独立）
  await pruneRemoteRuns(schedule, schedule.keepLastN);

  const completed = await db.select().from(backupJobs)
    .where(
      and(
        eq(backupJobs.target, schedule.target),
        eq(backupJobs.sourcePath, schedule.sourcePath),
        eq(backupJobs.status, "completed")
      )
    )
    .orderBy(desc(backupJobs.completedAt));

  if (completed.length <= schedule.keepLastN) return;

  const toDelete = completed.slice(schedule.keepLastN);
  const jobIds = toDelete.map((job) => job.id);
  if (jobIds.length === 0) return;

  // P2 根治（碧霄 2026-11-14，run 692 FK 事故）：restore_jobs.backupJobId 的 FK 无级联，
  // 删掉被恢复引用过的老 run 会 FOREIGN KEY constraint failed 整批炸。
  // 被引用 = 这份备份有历史痕迹（真被恢复用过），**保留不删**，只删无引用的。
  let referenced = new Set<number>();
  try {
    const rows = await db
      .select({ backupJobId: restoreJobs.backupJobId })
      .from(restoreJobs)
      .where(inArray(restoreJobs.backupJobId, jobIds));
    referenced = new Set(rows.map((r) => Number(r.backupJobId)));
  } catch (refErr) {
    // lite 库没有 restore_jobs 表：无引用可言，按原计划删（查询失败≠存在引用，保守放行删除）
    console.warn(`[BackupScheduler] restore_jobs 引用查询失败，按无引用处理：${refErr instanceof Error ? refErr.message : String(refErr)}`);
  }
  const deletable = jobIds.filter((id) => !referenced.has(id));
  if (referenced.size > 0) {
    console.log(`[BackupScheduler] retention 跳过 ${referenced.size} 份被恢复作业引用的老备份（保留历史痕迹）`);
  }
  console.log(`[BackupScheduler] Applying retention for schedule ${scheduleJobId}: deleting ${deletable.length} old backups`);
  if (deletable.length === 0) return;
  // N+1 优化：单次 inArray 批量删除关联文件与作业
  await db.delete(backupJobFiles).where(inArray(backupJobFiles.jobId, deletable));
  await db.delete(backupJobs).where(inArray(backupJobs.id, deletable));
}

export async function runDueBackupSchedules(
  options: { readonly scheduleId?: number; readonly force?: boolean } = {},
): Promise<BackupRunHandle[]> {
  const db = getDb();
  const now = new Date();
  console.log(`[BackupScheduler] Checking for due backup schedules at ${now.toISOString()}`);

  // force：按 id 直取该调度（backup_trigger 走这条），不再依赖 enabled/nextRunAt——
  // 否则每次「立即触发」都要把行的 enabled 改成 true 并写 nextRunAt，
  // 一旦传进来的是运行行（cron 为空的同表记录），它就会变成 due 被 tick 当成调度再跑一遍（审查 Q8）
  const dueRows = options.force && options.scheduleId !== undefined
    ? await db.select().from(backupJobs).where(eq(backupJobs.id, options.scheduleId))
    : await db.select().from(backupJobs)
      .where(
        and(
          eq(backupJobs.enabled, "true"),
          lte(backupJobs.nextRunAt, now)
        )
      );
  // 只跑指定的调度（backup_trigger 走这里，保证句柄对得上刚触发的那次运行）
  const due = options.scheduleId === undefined || options.force
    ? dueRows
    : dueRows.filter((r) => r.id === options.scheduleId);
  const handles: BackupRunHandle[] = [];

  console.log(`[BackupScheduler] Found ${due.length} due schedules`);

  for (const schedule of due) {
    const config = (schedule.config as Record<string, unknown>) ?? {};
    console.log(`[BackupScheduler] Processing schedule ${schedule.id} (target: ${schedule.target})`);

    // 创建新的实际备份任务
    const result = await db.insert(backupJobs).values({
      target: schedule.target,
      sourcePath: schedule.sourcePath,
      status: "pending",
      progress: 0,
      filesTotal: 0,
      filesDone: 0,
      filesFailed: 0,
      config,
      createdBy: schedule.createdBy,
    });
    const runJobId = Number(result.lastInsertRowid);
    console.log(`[BackupScheduler] Created backup run job ${runJobId} for schedule ${schedule.id}`);

    // P0-4：注册统一任务句柄，调用方据此 task_get 轮询 / task_cancel 取消
    const task = createTask({
      kind: "backup",
      refId: runJobId,
      meta: { scheduleId: schedule.id, target: schedule.target, sourcePath: schedule.sourcePath },
    });
    handles.push({ scheduleId: schedule.id, runJobId, taskId: task.taskId });

    // 计算下次运行时间。
    // P2 根治（碧霄 2026-11-14）：这里**不清零 retryCount**——旧代码每次拾取都清零，
    // 失败分支读到的永远是 0，于是永远排"retry 1/3"、backoff 永远 1 分钟，
    // maxRetries 形同虚设（生产 runs 687→691 连炸五轮、每轮日志都是 1/3 的实录）。
    // retryCount 是**连续失败计数**，只在运行成功时清零（见 settle 的 completed 分支）。
    const nextRun = schedule.cron ? nextCronTime(schedule.cron, now) : null;
    await db.update(backupJobs).set({
      nextRunAt: nextRun,
    }).where(eq(backupJobs.id, schedule.id));
    console.log(`[BackupScheduler] Schedule ${schedule.id} next run at: ${nextRun?.toISOString() ?? 'none'}`);

    // 异步执行备份
    executeBackupJob(runJobId, config, task.taskId).then(async () => {
      const [finished] = await db.select().from(backupJobs).where(eq(backupJobs.id, runJobId));
      console.log(`[BackupScheduler] Backup run ${runJobId} finished with status: ${finished?.status}`);
      // 任务终态以业务表为准（含 task_cancel 触发的 cancelled）
      finishTaskFromRunRow(task.taskId, finished);
      // cancelled 也进 retention：连续取消会留下部分快照，不纳入 keepLastN 会无声堆积（审查 Q10）
      if (finished?.status === "completed" || finished?.status === "cancelled") {
        // P2 根治（审查 c4）：清零与 retention 整体都是"善后"，任何一步炸了都不许顺链尾
        // .catch 把已 completed 的运行改判 failed（run 692 实录形状）。清零失败下轮成功会再清，无损。
        try {
          // retryCount 是连续失败计数：成功一次才归零（取消不洗白，历史失败仍作数）
          if (finished?.status === "completed") {
            await db.update(backupJobs).set({ retryCount: 0 }).where(eq(backupJobs.id, schedule.id));
          }
          await applyRetention(schedule.id);
        } catch (retErr) {
          console.warn(
            `[BackupScheduler] 保留清理失败（不影响备份结果，下轮巡检会再试）：${retErr instanceof Error ? retErr.message : String(retErr)}`
          );
        }
      } else if (finished?.status === "failed" || finished?.status === "partial") {
        // 审查 c2：partial 也是失败结局（与 task-sync decideBackupOutcome 同款口径）。
        // 旧代码只匹配 "failed"，行状态 partial 两分支都不落——既不累计 retryCount
        // 也不排重试，"连续失败计数"对 partial 静默失效。补进失败分支。
        const [updatedSchedule] = await db.select().from(backupJobs).where(eq(backupJobs.id, schedule.id));
        const retryCount = updatedSchedule?.retryCount ?? 0;
        const maxRetries = updatedSchedule?.maxRetries ?? 3;
        if (updatedSchedule && retryCount < maxRetries) {
          const backoffMinutes = Math.pow(2, retryCount);
          const retryAt = new Date(now.getTime() + backoffMinutes * 60 * 1000);
          await db.update(backupJobs).set({
            nextRunAt: retryAt,
            retryCount: retryCount + 1,
          }).where(eq(backupJobs.id, schedule.id));
          console.log(`[BackupScheduler] Schedule ${schedule.id} retry ${retryCount + 1}/${maxRetries} scheduled at ${retryAt.toISOString()}`);
        }
      }
    }).catch((err) => {
      console.error(`[BackupScheduler] Backup run ${runJobId} error:`, err);
      finishTask(task.taskId, "failed", { error: err instanceof Error ? err.message : "备份执行异常" });
    });
  }
  return handles;
}

export function startBackupScheduler(intervalMs = 60_000): () => void {
  console.log(`[BackupScheduler] Starting backup scheduler with interval ${intervalMs}ms`);
  let running = false;

  async function tick() {
    if (running) {
      console.log("[BackupScheduler] Tick skipped, previous tick still running");
      return;
    }
    running = true;
    try {
      await runDueBackupSchedules();
    } catch (err) {
      console.error("[BackupScheduler] Tick failed:", err);
    } finally {
      running = false;
    }
  }

  // 立即执行一次
  tick();
  const timer = setInterval(tick, intervalMs);
  console.log("[BackupScheduler] Scheduler started successfully");

  return () => {
    console.log("[BackupScheduler] Stopping scheduler");
    clearInterval(timer);
  };
}
