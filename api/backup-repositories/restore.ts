/**
 * 备份恢复（backup-router 中抽取的恢复逻辑）
 *
 * - 使用 backup job 的原始 target 查找仓库（不再按 targetPath 前缀猜 nas/local）。
 * - 从仓库读取 manifest.json 校验文件清单与 checksum，再落盘到 targetPath。
 * - restore 只做提取 + 校验，不做数据库 / KB 自动导入。
 * - 历史 target（115/aliyundrive）保留原连接器路径。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { backupJobs, backupJobFiles, restoreJobs } from "@db/schema";
import type { BackupJob, RestoreJob } from "@db/schema";
import { getConnector } from "../connectors/base";
import type { CloudConnector } from "../connectors/base";
import * as path from "path";
import { promises as fsp } from "fs";
import { env } from "../lib/env";
import { hasPathTraversal, sanitizeRelativePath, resolveRestoreDestPath } from "../lib/backup-path";
import { getBackupRepository, type BackupRepository } from "./base";
import { decryptBuffer } from "./crypto";
import { sha256, effectiveRepoConfig } from "./execution";

interface ManifestFileEntry {
  readonly path: string;
  readonly size?: number;
  readonly checksum?: string;
}

interface RestoreManifest {
  readonly schemaVersion?: number;
  readonly encrypted?: boolean;
  readonly files?: readonly ManifestFileEntry[];
}

function parseManifest(buffer: Buffer): RestoreManifest | null {
  try {
    const obj = JSON.parse(buffer.toString("utf8")) as unknown;
    if (typeof obj === "object" && obj !== null && Array.isArray((obj as RestoreManifest).files)) {
      return obj as RestoreManifest;
    }
    return null;
  } catch {
    return null;
  }
}

interface RestoreStats {
  readonly done: number;
  readonly failed: number;
  readonly manifestPassed: number;
  readonly manifestFailed: number;
}

async function trackProgress(
  db: ReturnType<typeof getDb>,
  jobId: number,
  done: number,
  failed: number,
  total: number
): Promise<void> {
  await db
    .update(restoreJobs)
    .set({
      filesDone: done,
      filesFailed: failed,
      progress: total > 0 ? Math.round(((done + failed) / total) * 100) : 100,
    })
    .where(eq(restoreJobs.id, jobId));
}

async function restoreManifestFiles(
  db: ReturnType<typeof getDb>,
  job: RestoreJob,
  repo: BackupRepository,
  config: Record<string, unknown>,
  manifest: RestoreManifest
): Promise<RestoreStats> {
  const encrypted = manifest.encrypted === true;
  const key = env.backupEncryptionKey;
  const entries = manifest.files ?? [];
  await db.update(restoreJobs).set({ filesTotal: entries.length }).where(eq(restoreJobs.id, job.id));

  let done = 0;
  let failed = 0;
  let manifestPassed = 0;
  let manifestFailed = 0;

  for (const entry of entries) {
    try {
      const relPath = sanitizeRelativePath(entry.path);
      let content = await repo.readFile(config, relPath);
      if (!content) throw new Error("无法获取备份文件内容");
      if (encrypted) {
        if (!key) throw new Error("备份已加密但 BACKUP_ENCRYPTION_KEY 未配置");
        content = decryptBuffer(content, key);
      }
      const checksum = sha256(content);
      const verified = entry.checksum === undefined || checksum === entry.checksum;
      if (verified) manifestPassed++;
      else manifestFailed++;

      const destPath = resolveRestoreDestPath(job.targetPath, relPath);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.writeFile(destPath, content);
      done++;
    } catch (err) {
      failed++;
      console.error(`[Restore] Failed ${entry.path}:`, err);
    }
    await trackProgress(db, job.id, done, failed, entries.length);
  }
  return { done, failed, manifestPassed, manifestFailed };
}

async function restoreDbRows(
  db: ReturnType<typeof getDb>,
  job: RestoreJob,
  repo: BackupRepository,
  config: Record<string, unknown>
): Promise<RestoreStats> {
  const rows = await db.select().from(backupJobFiles).where(eq(backupJobFiles.jobId, job.backupJobId));
  await db.update(restoreJobs).set({ filesTotal: rows.length }).where(eq(restoreJobs.id, job.id));

  let done = 0;
  let failed = 0;
  let manifestPassed = 0;
  let manifestFailed = 0;

  for (const file of rows) {
    try {
      if (file.status !== "uploaded" || !file.relativePath) {
        failed++;
        continue;
      }
      const relPath = sanitizeRelativePath(file.relativePath);
      const content = await repo.readFile(config, relPath);
      if (!content) throw new Error("无法获取备份文件内容");

      const destPath = resolveRestoreDestPath(job.targetPath, relPath);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.writeFile(destPath, content);

      const checksum = sha256(content);
      const verified = file.checksum !== null && checksum === file.checksum;
      if (verified) manifestPassed++;
      else manifestFailed++;
      done++;
    } catch (err) {
      failed++;
      console.error(`[Restore] Failed ${file.relativePath}:`, err);
    }
    await trackProgress(db, job.id, done, failed, rows.length);
  }
  return { done, failed, manifestPassed, manifestFailed };
}

async function restoreLegacyConnector(
  db: ReturnType<typeof getDb>,
  job: RestoreJob,
  backupJob: BackupJob
): Promise<RestoreStats> {
  const rows = await db.select().from(backupJobFiles).where(eq(backupJobFiles.jobId, job.backupJobId));
  await db.update(restoreJobs).set({ filesTotal: rows.length }).where(eq(restoreJobs.id, job.id));

  let done = 0;
  let failed = 0;
  let manifestPassed = 0;
  let manifestFailed = 0;

  for (const file of rows) {
    try {
      if (file.status !== "uploaded" || !file.relativePath) {
        failed++;
        continue;
      }
      const safeRelativePath = sanitizeRelativePath(file.relativePath);
      const destPath = resolveRestoreDestPath(job.targetPath, safeRelativePath);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });

      const connector = getConnector(backupJob.target) as CloudConnector | undefined;
      let content: Buffer | null = null;
      if (connector?.getDownloadUrl) {
        const url = await connector.getDownloadUrl({ path: "/" }, safeRelativePath);
        if (url) {
          const res = await fetch(url);
          content = Buffer.from(await res.arrayBuffer());
        }
      }
      if (!content) throw new Error("无法获取备份文件内容");

      await fsp.writeFile(destPath, content);
      const checksum = sha256(content);
      const verified = checksum === file.checksum;
      if (verified) manifestPassed++;
      else manifestFailed++;
      done++;
    } catch (err) {
      failed++;
      console.error(`[Restore] Failed ${file.relativePath}:`, err);
    }
    await trackProgress(db, job.id, done, failed, rows.length);
  }
  return { done, failed, manifestPassed, manifestFailed };
}

export async function executeRestore(restoreJobId: number): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, restoreJobId));
  if (!job) return;

  await db.update(restoreJobs).set({ status: "running", startedAt: new Date() }).where(eq(restoreJobs.id, restoreJobId));

  try {
    if (hasPathTraversal(job.targetPath)) {
      throw new Error(`Invalid restore target path: ${job.targetPath}`);
    }
    const [backupJob] = await db.select().from(backupJobs).where(eq(backupJobs.id, job.backupJobId));
    if (!backupJob) throw new Error("备份任务不存在");

    let stats: RestoreStats;
    const repo = getBackupRepository(backupJob.target);
    if (repo) {
      const config = effectiveRepoConfig(backupJob.target, backupJob.id, backupJob.config ?? {});
      const manifestBuf = await repo.readFile(config, "manifest.json");
      let resolvedManifest: RestoreManifest | null = null;
      if (manifestBuf) {
        resolvedManifest = parseManifest(manifestBuf);
        if (!resolvedManifest && env.backupEncryptionKey) {
          resolvedManifest = parseManifest(decryptBuffer(manifestBuf, env.backupEncryptionKey));
        }
        if (!resolvedManifest) {
          throw new Error("备份 manifest.json 无法解析（可能已损坏或缺少 BACKUP_ENCRYPTION_KEY）");
        }
      }
      stats = resolvedManifest
        ? await restoreManifestFiles(db, job, repo, config, resolvedManifest)
        : await restoreDbRows(db, job, repo, config);
    } else {
      stats = await restoreLegacyConnector(db, job, backupJob);
    }

    const manifestVerified = stats.manifestFailed > 0 ? "failed" : stats.manifestPassed > 0 ? "passed" : "pending";
    const status = stats.failed > 0 ? (stats.done > 0 ? "partial" : "failed") : "completed";
    await db
      .update(restoreJobs)
      .set({
        status,
        progress: 100,
        manifestVerified,
        error: stats.failed > 0 ? `${stats.failed} 个文件恢复失败` : null,
        completedAt: new Date(),
      })
      .where(eq(restoreJobs.id, restoreJobId));
  } catch (err) {
    console.error(`[Restore] Job ${restoreJobId} failed:`, err);
    await db
      .update(restoreJobs)
      .set({
        status: "failed",
        error: "Internal error",
        completedAt: new Date(),
      })
      .where(eq(restoreJobs.id, restoreJobId));
  }
}
