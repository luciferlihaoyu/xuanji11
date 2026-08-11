/**
 * 历史 target（115/aliyundrive）的旧连接器备份执行路径。
 * 新仓库（alist/nas/local）不走这里；此模块仅为保留既有 cron 任务可用。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { backupJobs, backupJobFiles } from "@db/schema";
import type { BackupJob } from "@db/schema";
import { getConnector } from "../connectors/base";
import type { CloudConnector } from "../connectors/base";
import * as fs from "fs";
import * as path from "path";
import { promises as fsp } from "fs";
import { env } from "../lib/env";
import { hasPathTraversal, sanitizeRelativePath } from "../lib/backup-path";
import { sha256, walkDir } from "./shared";

type Db = ReturnType<typeof getDb>;

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
      console.log(`[Backup] No accessToken, trying to refresh with refreshToken...`);
      const newTokens = await connector.refreshToken(config);
      if (newTokens) {
        result.accessToken = newTokens.accessToken;
        result.refreshToken = newTokens.refreshToken;
        refreshed = true;
        console.log(`[Backup] Token refreshed successfully`);
      } else {
        console.error(`[Backup] Token refresh failed`);
      }
    }
  }

  return { config: result, refreshed };
}

export async function executeBackupLegacyConnector(
  db: Db,
  job: BackupJob,
  connectorConfig: Record<string, unknown>
): Promise<void> {
  const connector = getConnector(job.target) as CloudConnector | undefined;
  if (!connector) {
    await db
      .update(backupJobs)
      .set({ status: "failed", error: `未找到连接器: ${job.target}`, completedAt: new Date() })
      .where(eq(backupJobs.id, job.id));
    return;
  }

  const storedConfig = job.config ?? {};
  const mergedConfig = { ...storedConfig, ...connectorConfig };
  const { config: effectiveConfig, refreshed } = await getEffectiveConnectorConfig(connector, mergedConfig);

  if (refreshed) {
    await db.update(backupJobs).set({ config: effectiveConfig }).where(eq(backupJobs.id, job.id));
    console.log(`[Backup] Updated stored config with refreshed tokens for job ${job.id}`);
  }

  if (hasPathTraversal(job.sourcePath)) {
    throw new Error(`Invalid backup source path: ${job.sourcePath}`);
  }

  const files: { relativePath: string; fullPath: string; size: number }[] = [];
  if (fs.existsSync(job.sourcePath)) {
    for await (const f of walkDir(job.sourcePath)) {
      files.push(f);
    }
  }

  await db.update(backupJobs).set({ filesTotal: files.length }).where(eq(backupJobs.id, job.id));

  let done = 0;
  let failed = 0;
  const manifestFiles: Array<{ path: string; size: number; checksum: string; status: string }> = [];

  for (const file of files) {
    try {
      const safeRelativePath = sanitizeRelativePath(file.relativePath);
      const content = await fsp.readFile(file.fullPath);
      const checksum = sha256(content);
      const destName = path.basename(safeRelativePath);
      const destDir = path.dirname(safeRelativePath);

      if (connector.uploadFile) {
        const result = await connector.uploadFile(effectiveConfig, `${destDir}/${destName}`, content);
        if (!result.success) throw new Error("upload failed");
      } else if (connector.syncFiles) {
        const tempDir = path.join(env.backupTempDir, `backup-${job.id}`);
        await fsp.mkdir(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, destName);
        await fsp.writeFile(tempPath, content);
        await connector.syncFiles(effectiveConfig, tempDir);
        await fsp.rm(tempDir, { recursive: true, force: true });
      } else {
        throw new Error("连接器不支持上传或同步");
      }

      await db.insert(backupJobFiles).values({
        jobId: job.id,
        relativePath: safeRelativePath,
        size: file.size,
        checksum,
        status: "uploaded",
      });
      manifestFiles.push({ path: safeRelativePath, size: file.size, checksum, status: "uploaded" });
      done++;
    } catch (err) {
      failed++;
      const safeRelativePath = sanitizeRelativePath(file.relativePath);
      console.error(`[Backup] Failed ${safeRelativePath}:`, err);
      await db.insert(backupJobFiles).values({
        jobId: job.id,
        relativePath: safeRelativePath,
        size: file.size,
        status: "failed",
        error: "Internal error",
      });
      manifestFiles.push({ path: safeRelativePath, size: file.size, checksum: "", status: "failed" });
    }
    await db
      .update(backupJobs)
      .set({
        filesDone: done,
        filesFailed: failed,
        progress: files.length > 0 ? Math.round(((done + failed) / files.length) * 100) : 100,
      })
      .where(eq(backupJobs.id, job.id));
  }

  const status = failed > 0 ? (done > 0 ? "partial" : "failed") : "completed";
  await db
    .update(backupJobs)
    .set({
      status,
      progress: 100,
      manifest: { files: manifestFiles, total: files.length, done, failed },
      error: failed > 0 ? `${failed} 个文件备份失败` : null,
      completedAt: new Date(),
      retryCount: 0,
    })
    .where(eq(backupJobs.id, job.id));
}
