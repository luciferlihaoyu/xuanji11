import { eq, and, lte, desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { backupJobs } from "@db/schema";
import { getConnector } from "../connectors/base";
import type { CloudConnector } from "../connectors/base";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { promises as fsp } from "fs";
import { env } from "./env";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

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

async function* walkDir(dir: string): AsyncGenerator<{ relativePath: string; fullPath: string; size: number }> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(dir, fullPath);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(fullPath);
      yield { relativePath, fullPath, size: stat.size };
    }
  }
}

/**
 * 获取有效的连接器配置，包含 token 刷新逻辑
 */
async function getEffectiveConnectorConfig(
  connector: CloudConnector,
  config: Record<string, unknown>
): Promise<{ config: Record<string, unknown>; refreshed: boolean }> {
  const result = { ...config };
  let refreshed = false;

  if (connector.refreshToken) {
    const accessToken = config.accessToken as string | undefined;
    const refreshToken = config.refreshToken as string | undefined;

    if (!accessToken && refreshToken) {
      console.log(`[BackupScheduler] No accessToken, trying to refresh with refreshToken...`);
      const newTokens = await connector.refreshToken(config);
      if (newTokens) {
        result.accessToken = newTokens.accessToken;
        result.refreshToken = newTokens.refreshToken;
        refreshed = true;
        console.log(`[BackupScheduler] Token refreshed successfully`);
      } else {
        console.error(`[BackupScheduler] Token refresh failed`);
      }
    }
  }

  return { config: result, refreshed };
}

async function executeBackupJob(jobId: number, connectorConfig: Record<string, unknown> = {}): Promise<void> {
  console.log(`[BackupScheduler] Starting backup job ${jobId}`);
  const db = getDb();
  const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
  if (!job) {
    console.error(`[BackupScheduler] Job ${jobId} not found`);
    return;
  }

  await db.update(backupJobs).set({ status: "running", startedAt: new Date() }).where(eq(backupJobs.id, jobId));

  const connector = getConnector(job.target) as CloudConnector | undefined;
  if (!connector) {
    const error = `未找到连接器: ${job.target}`;
    console.error(`[BackupScheduler] ${error}`);
    await db.update(backupJobs).set({ status: "failed", error, completedAt: new Date() }).where(eq(backupJobs.id, jobId));
    return;
  }

  // 合并 job 中存储的 config 和传入的 connectorConfig
  const storedConfig = (job.config as Record<string, unknown>) ?? {};
  const mergedConfig = { ...storedConfig, ...connectorConfig };

  // 尝试刷新 token
  const { config: effectiveConfig, refreshed } = await getEffectiveConnectorConfig(connector, mergedConfig);
  
  // 如果 token 被刷新了，更新数据库中的 config
  if (refreshed) {
    await db.update(backupJobs).set({ config: effectiveConfig }).where(eq(backupJobs.id, jobId));
    console.log(`[BackupScheduler] Updated stored config with refreshed tokens for job ${jobId}`);
  }

  try {
    const files: { relativePath: string; fullPath: string; size: number }[] = [];
    if (fs.existsSync(job.sourcePath)) {
      for await (const f of walkDir(job.sourcePath)) {
        files.push(f);
      }
    }

    console.log(`[BackupScheduler] Job ${jobId}: found ${files.length} files to backup`);
    await db.update(backupJobs).set({ filesTotal: files.length }).where(eq(backupJobs.id, jobId));

    let done = 0;
    let failed = 0;
    const manifestFiles: Array<{ path: string; size: number; checksum: string; status: string }> = [];

    for (const file of files) {
      try {
        const content = await fsp.readFile(file.fullPath);
        const checksum = sha256(content);
        const destName = path.basename(file.relativePath);
        const destDir = path.dirname(file.relativePath);

        if (connector.uploadFile) {
          const result = await connector.uploadFile(effectiveConfig, `${destDir}/${destName}`, content);
          if (!result.success) throw new Error("upload failed");
        } else if (connector.syncFiles) {
          const tempDir = path.join(env.backupTempDir, `backup-${jobId}`);
          await fsp.mkdir(tempDir, { recursive: true });
          const tempPath = path.join(tempDir, destName);
          await fsp.writeFile(tempPath, content);
          await connector.syncFiles(effectiveConfig, tempDir);
          await fsp.rm(tempDir, { recursive: true, force: true });
        } else {
          throw new Error("连接器不支持上传或同步");
        }

        await db.insert(backupJobFiles).values({
          jobId,
          relativePath: file.relativePath,
          size: file.size,
          checksum,
          status: "uploaded",
        });
        manifestFiles.push({ path: file.relativePath, size: file.size, checksum, status: "uploaded" });
        done++;
      } catch (err) {
        failed++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[BackupScheduler] Job ${jobId}: failed to upload ${file.relativePath}: ${errorMsg}`);
        await db.insert(backupJobFiles).values({
          jobId,
          relativePath: file.relativePath,
          size: file.size,
          status: "failed",
          error: "Internal backup error",
        });
        manifestFiles.push({ path: file.relativePath, size: file.size, checksum: "", status: "failed" });
      }
      await db.update(backupJobs).set({ filesDone: done, filesFailed: failed, progress: Math.round(((done + failed) / files.length) * 100) }).where(eq(backupJobs.id, jobId));
    }

    const status = failed > 0 ? (done > 0 ? "partial" : "failed") : "completed";
    console.log(`[BackupScheduler] Job ${jobId} completed with status: ${status}, done: ${done}, failed: ${failed}`);
    await db.update(backupJobs).set({
      status,
      progress: 100,
      manifest: { files: manifestFiles, total: files.length, done, failed },
      error: failed > 0 ? `${failed} 个文件备份失败` : null,
      completedAt: new Date(),
      retryCount: 0,
    }).where(eq(backupJobs.id, jobId));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "备份执行失败";
    console.error(`[BackupScheduler] Job ${jobId} failed: ${errorMsg}`);
    await db.update(backupJobs).set({
      status: "failed",
      error: "Internal backup error",
      completedAt: new Date(),
    }).where(eq(backupJobs.id, jobId));
  }
}

import { backupJobFiles } from "@db/schema";

async function applyRetention(scheduleJobId: number): Promise<void> {
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
  console.log(`[BackupScheduler] Applying retention for schedule ${scheduleJobId}: deleting ${toDelete.length} old backups`);
  for (const job of toDelete) {
    await db.delete(backupJobFiles).where(eq(backupJobFiles.jobId, job.id));
    await db.delete(backupJobs).where(eq(backupJobs.id, job.id));
  }
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
