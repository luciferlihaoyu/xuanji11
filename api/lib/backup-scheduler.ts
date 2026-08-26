import { eq, and, inArray, lte, desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { backupJobs, backupJobFiles } from "@db/schema";
import { executeBackup } from "../backup-repositories/execution";

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

function nextCronTime(schedule: string, after: Date): Date | null {
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matchCron(schedule, candidate)) return new Date(candidate);
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

async function executeBackupJob(jobId: number, connectorConfig: Record<string, unknown> = {}): Promise<void> {
  console.log(`[BackupScheduler] Starting backup job ${jobId}`);
  // 执行逻辑统一走备份仓库抽象层（alist/nas/local 新仓库，115/aliyundrive 历史连接器）
  await executeBackup(jobId, connectorConfig);
}

export async function applyRetention(scheduleJobId: number): Promise<void> {
  const db = getDb();
  const [schedule] = await db.select().from(backupJobs).where(eq(backupJobs.id, scheduleJobId));
  if (!schedule || !schedule.keepLastN || schedule.keepLastN <= 0) return;

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
  console.log(`[BackupScheduler] Applying retention for schedule ${scheduleJobId}: deleting ${jobIds.length} old backups`);
  // N+1 优化：单次 inArray 批量删除关联文件与作业
  if (jobIds.length === 0) return;
  await db.delete(backupJobFiles).where(inArray(backupJobFiles.jobId, jobIds));
  await db.delete(backupJobs).where(inArray(backupJobs.id, jobIds));
}

export async function runDueBackupSchedules(): Promise<void> {
  const db = getDb();
  const now = new Date();
  console.log(`[BackupScheduler] Checking for due backup schedules at ${now.toISOString()}`);

  const due = await db.select().from(backupJobs)
    .where(
      and(
        eq(backupJobs.enabled, "true"),
        lte(backupJobs.nextRunAt, now)
      )
    );

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
    const runJobId = Number(result[0].insertId);
    console.log(`[BackupScheduler] Created backup run job ${runJobId} for schedule ${schedule.id}`);

    // 计算下次运行时间
    const nextRun = schedule.cron ? nextCronTime(schedule.cron, now) : null;
    await db.update(backupJobs).set({
      nextRunAt: nextRun,
      retryCount: 0,
    }).where(eq(backupJobs.id, schedule.id));
    console.log(`[BackupScheduler] Schedule ${schedule.id} next run at: ${nextRun?.toISOString() ?? 'none'}`);

    // 异步执行备份
    executeBackupJob(runJobId, config).then(async () => {
      const [finished] = await db.select().from(backupJobs).where(eq(backupJobs.id, runJobId));
      console.log(`[BackupScheduler] Backup run ${runJobId} finished with status: ${finished?.status}`);
      if (finished?.status === "completed") {
        await applyRetention(schedule.id);
      } else if (finished?.status === "failed") {
        // 重试处理
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
    });
  }
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
