/**
 * 备份执行（backup-router 中抽取出来的执行/序列化逻辑）
 *
 * - executeBackup：新仓库（alist/nas/local）走备份仓库抽象层；
 *   历史 target（115/aliyundrive）保留原连接器路径（legacy-connector.ts）。
 * - serializeBackupJob：API 输出时剥离 config 中的凭据。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { backupJobs, backupJobFiles } from "@db/schema";
import type { BackupJob } from "@db/schema";
import * as fs from "fs";
import * as path from "path";
import { promises as fsp } from "fs";
import { env } from "../lib/env";
import { hasPathTraversal, sanitizeRelativePath } from "../lib/backup-path";
import { getBackupRepository, type BackupRepository } from "./base";
import { encryptBuffer } from "./crypto";
import { buildBackupBundle, type BackupManifest } from "./bundle";
import { sha256, walkDir } from "./shared";
import { executeBackupLegacyConnector } from "./legacy-connector";
import "./index"; // 注册 local/nas/alist 仓库

export { executeRestore } from "./restore";
export { sha256 } from "./shared";

type Db = ReturnType<typeof getDb>;

/** API 输出用：去掉 config（可能含凭据），仅保留 hasConfig 标记。 */
export function serializeBackupJob(job: BackupJob): Omit<BackupJob, "config"> & { hasConfig: boolean } {
  const { config, ...rest } = job;
  return {
    ...rest,
    hasConfig: config !== null && config !== undefined && Object.keys(config).length > 0,
  };
}

/** 合并存储的 config 与调用方传入的 config；local 缺省 basePath 落在 backupTempDir 下。 */
export function effectiveRepoConfig(target: string, jobId: number, storedConfig: Record<string, unknown>): Record<string, unknown> {
  const config = { ...storedConfig };
  if (target === "local" && typeof config.basePath !== "string") {
    config.basePath = path.join(env.backupTempDir, `local-${jobId}`);
  }
  return config;
}

interface RepositoryUploadContext {
  readonly repo: BackupRepository;
  readonly config: Record<string, unknown>;
  readonly files: readonly { relPath: string; fullPath: string; size: number }[];
  readonly encrypt: boolean;
}

async function uploadFilesToRepository(
  db: Db,
  job: BackupJob,
  ctx: RepositoryUploadContext
): Promise<Array<{ path: string; size: number; checksum: string; status: string }>> {
  const dbRows: Array<{ path: string; size: number; checksum: string; status: string }> = [];
  let done = 0;
  let failed = 0;

  for (const file of ctx.files) {
    try {
      const safeRelativePath = sanitizeRelativePath(file.relPath);
      const content = await fsp.readFile(file.fullPath);
      const checksum = sha256(content);
      const uploadContent = ctx.encrypt ? encryptBuffer(content, env.backupEncryptionKey) : content;
      await ctx.repo.uploadFile(ctx.config, safeRelativePath, uploadContent);
      await db.insert(backupJobFiles).values({
        jobId: job.id,
        relativePath: safeRelativePath,
        size: file.size,
        checksum,
        status: "uploaded",
      });
      dbRows.push({ path: safeRelativePath, size: file.size, checksum, status: "uploaded" });
      done++;
    } catch (err) {
      failed++;
      console.error(`[Backup] Failed ${file.relPath}:`, err);
      await db.insert(backupJobFiles).values({
        jobId: job.id,
        relativePath: sanitizeRelativePath(file.relPath),
        size: file.size,
        status: "failed",
        error: "Internal error",
      });
      dbRows.push({ path: file.relPath, size: file.size, checksum: "", status: "failed" });
    }
    await db
      .update(backupJobs)
      .set({
        filesDone: done,
        filesFailed: failed,
        progress: ctx.files.length > 0 ? Math.round(((done + failed) / ctx.files.length) * 100) : 100,
      })
      .where(eq(backupJobs.id, job.id));
  }
  return dbRows;
}

async function executeBackupToRepository(
  db: Db,
  job: BackupJob,
  repo: BackupRepository,
  connectorConfig: Record<string, unknown>
): Promise<void> {
  const config = effectiveRepoConfig(job.target, job.id, job.config ?? {});
  Object.assign(config, connectorConfig);
  const encrypt = job.target === "alist";
  if (encrypt && env.backupEncryptionKey.length === 0) {
    throw new Error("BACKUP_ENCRYPTION_KEY 未配置，拒绝执行 AList 备份（加密策略要求）");
  }

  if (hasPathTraversal(job.sourcePath)) {
    throw new Error(`Invalid backup source path: ${job.sourcePath}`);
  }

  let stagingDir: string | null = null;
  let manifest: BackupManifest | null = null;
  const files: { relPath: string; fullPath: string; size: number }[] = [];

  if (job.target === "alist" || job.sourcePath === "bundle") {
    const bundle = await buildBackupBundle(job.id, job.sourcePath, { target: job.target, encrypted: encrypt });
    stagingDir = bundle.stagingDir;
    manifest = bundle.manifest;
    for (const f of bundle.files) {
      files.push({ relPath: f.path, fullPath: path.join(stagingDir, f.path), size: f.size });
    }
  } else if (fs.existsSync(job.sourcePath)) {
    for await (const f of walkDir(job.sourcePath)) {
      files.push({ relPath: f.relativePath, fullPath: f.fullPath, size: f.size });
    }
  }

  await db.update(backupJobs).set({ filesTotal: files.length }).where(eq(backupJobs.id, job.id));

  try {
    const manifestFiles = await uploadFilesToRepository(db, job, { repo, config, files, encrypt });

    if (manifest) {
      let manifestContent: Buffer = Buffer.from(JSON.stringify(manifest));
      if (encrypt) {
        manifestContent = encryptBuffer(manifestContent, env.backupEncryptionKey);
      }
      await repo.uploadFile(config, "manifest.json", manifestContent);
      manifestFiles.push({ path: "manifest.json", size: manifestContent.length, checksum: "", status: "uploaded" });
    }

    const failedCount = manifestFiles.filter((f) => f.status === "failed").length;
    const doneCount = manifestFiles.length - failedCount;
    const status = failedCount > 0 ? (doneCount > 0 ? "partial" : "failed") : "completed";
    await db
      .update(backupJobs)
      .set({
        status,
        progress: 100,
        manifest: { files: manifestFiles, total: manifestFiles.length, done: doneCount, failed: failedCount },
        error: failedCount > 0 ? `${failedCount} 个文件备份失败` : null,
        completedAt: new Date(),
        retryCount: 0,
      })
      .where(eq(backupJobs.id, job.id));
  } finally {
    if (stagingDir) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function executeBackup(jobId: number, connectorConfig: Record<string, unknown> = {}): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
  if (!job) return;

  await db.update(backupJobs).set({ status: "running", startedAt: new Date() }).where(eq(backupJobs.id, jobId));

  const repo = getBackupRepository(job.target);
  try {
    if (repo) {
      await executeBackupToRepository(db, job, repo, connectorConfig);
    } else {
      await executeBackupLegacyConnector(db, job, connectorConfig);
    }
  } catch (err) {
    console.error(`[Backup] Job ${jobId} failed:`, err);
    await db
      .update(backupJobs)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : "备份执行失败",
        completedAt: new Date(),
      })
      .where(eq(backupJobs.id, jobId));
  }
}
