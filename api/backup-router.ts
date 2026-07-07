import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { backupJobs, backupJobFiles, restoreJobs } from "@db/schema";
import { getConnector } from "./connectors/base";
import type { CloudConnector } from "./connectors/base";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { promises as fsp } from "fs";
import { logAudit } from "./lib/audit";
import { clean } from "./lib/clean";
import { env } from "./lib/env";
import { hasPathTraversal, sanitizeRelativePath, resolveRestoreDestPath } from "./lib/backup-path";

const BACKUP_TARGETS = ["aliyundrive", "115", "nas", "local"] as const;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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

  // 如果 connector 支持 refreshToken 且没有 accessToken 但有 refreshToken
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

async function executeBackup(jobId: number, connectorConfig: Record<string, unknown> = {}): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
  if (!job) return;

  await db.update(backupJobs).set({ status: "running", startedAt: new Date() }).where(eq(backupJobs.id, jobId));

  const connector = getConnector(job.target) as CloudConnector | undefined;
  if (!connector) {
    await db.update(backupJobs).set({ status: "failed", error: `未找到连接器: ${job.target}`, completedAt: new Date() }).where(eq(backupJobs.id, jobId));
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
    console.log(`[Backup] Updated stored config with refreshed tokens for job ${jobId}`);
  }

  try {
    if (hasPathTraversal(job.sourcePath)) {
      throw new Error(`Invalid backup source path: ${job.sourcePath}`);
    }

    const files: { relativePath: string; fullPath: string; size: number }[] = [];
    if (fs.existsSync(job.sourcePath)) {
      for await (const f of walkDir(job.sourcePath)) {
        files.push(f);
      }
    }

    await db.update(backupJobs).set({ filesTotal: files.length }).where(eq(backupJobs.id, jobId));

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
          jobId,
          relativePath: safeRelativePath,
          size: file.size,
          status: "failed",
          error: "Internal error",
        });
        manifestFiles.push({ path: safeRelativePath, size: file.size, checksum: "", status: "failed" });
      }
      await db.update(backupJobs).set({ filesDone: done, filesFailed: failed, progress: Math.round(((done + failed) / files.length) * 100) }).where(eq(backupJobs.id, jobId));
    }

    const status = failed > 0 ? (done > 0 ? "partial" : "failed") : "completed";
    await db.update(backupJobs).set({
      status,
      progress: 100,
      manifest: { files: manifestFiles, total: files.length, done, failed },
      error: failed > 0 ? `${failed} 个文件备份失败` : null,
      completedAt: new Date(),
    }).where(eq(backupJobs.id, jobId));
  } catch (err) {
    console.error(`[Backup] Job ${jobId} failed:`, err);
    await db.update(backupJobs).set({
      status: "failed",
      error: "Internal error",
      completedAt: new Date(),
    }).where(eq(backupJobs.id, jobId));
  }
}

async function executeRestore(restoreJobId: number): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, restoreJobId));
  if (!job) return;

  await db.update(restoreJobs).set({ status: "running", startedAt: new Date() }).where(eq(restoreJobs.id, restoreJobId));

  try {
    if (hasPathTraversal(job.targetPath)) {
      throw new Error(`Invalid restore target path: ${job.targetPath}`);
    }

    const files = await db.select().from(backupJobFiles).where(eq(backupJobFiles.jobId, job.backupJobId));
    await db.update(restoreJobs).set({ filesTotal: files.length }).where(eq(restoreJobs.id, restoreJobId));

    let done = 0;
    let failed = 0;
    let manifestPassed = 0;
    let manifestFailed = 0;

    for (const file of files) {
      try {
        if (file.status !== "uploaded" || !file.relativePath) {
          failed++;
          continue;
        }

        const safeRelativePath = sanitizeRelativePath(file.relativePath);
        const destPath = resolveRestoreDestPath(job.targetPath, safeRelativePath);
        await fsp.mkdir(path.dirname(destPath), { recursive: true });

        const connector = getConnector(job.targetPath.startsWith("/") ? "nas" : "local") as CloudConnector | undefined;
        let content: Buffer | null = null;

        if (connector?.getDownloadUrl) {
          const url = await connector.getDownloadUrl({ path: "/" }, safeRelativePath);
          if (url) {
            const res = await fetch(url);
            content = Buffer.from(await res.arrayBuffer());
          }
        }

        if (!content) {
          throw new Error("无法获取备份文件内容");
        }

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
      await db.update(restoreJobs).set({ filesDone: done, filesFailed: failed, progress: Math.round(((done + failed) / files.length) * 100) }).where(eq(restoreJobs.id, restoreJobId));
    }

    const manifestVerified = manifestFailed > 0 ? "failed" : manifestPassed > 0 ? "passed" : "pending";
    const status = failed > 0 ? (done > 0 ? "partial" : "failed") : "completed";
    await db.update(restoreJobs).set({
      status,
      progress: 100,
      manifestVerified,
      error: failed > 0 ? `${failed} 个文件恢复失败` : null,
      completedAt: new Date(),
    }).where(eq(restoreJobs.id, restoreJobId));
  } catch (err) {
    console.error(`[Restore] Job ${restoreJobId} failed:`, err);
    await db.update(restoreJobs).set({
      status: "failed",
      error: "Internal error",
      completedAt: new Date(),
    }).where(eq(restoreJobs.id, restoreJobId));
  }
}

export const backupRouter = createRouter({
  targets: authedQuery.query(async () => {
    return BACKUP_TARGETS.map((key) => {
      const c = getConnector(key);
      return { key, name: c?.name ?? key, available: !!c };
    });
  }),

  list: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(backupJobs).orderBy(desc(backupJobs.createdAt));
  }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, input.id));
      if (!job) return null;
      const files = await db.select().from(backupJobFiles).where(eq(backupJobFiles.jobId, input.id));
      return { ...job, files };
    }),

  create: adminQuery
    .input(
      z.object({
        target: z.enum(["aliyundrive", "115", "nas", "local"]),
        sourcePath: z.string().min(1).max(500).refine((p) => !hasPathTraversal(p), {
          message: "sourcePath contains path traversal",
        }),
        config: z.record(z.string(), z.unknown()).optional(),
        cron: z.string().max(100).optional(),
        enabled: z.boolean().default(false),
        keepLastN: z.number().int().min(1).default(7),
        maxRetries: z.number().int().min(0).default(3),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const connector = getConnector(input.target);
      if (!connector) {
        throw new Error(`备份目标不可用: ${input.target}`);
      }

      const connConfig = input.config ?? {};

      // 云盘备份需要 accessToken 或 refreshToken
      if (input.target === "115" || input.target === "aliyundrive") {
        const accessToken = connConfig.accessToken as string | undefined;
        const refreshToken = connConfig.refreshToken as string | undefined;
        if (!accessToken && !refreshToken) {
          throw new Error(`创建 ${input.target} 备份需要提供 accessToken 或 refreshToken`);
        }
      }

      // 尝试获取有效 token（包含刷新逻辑）
      const { config: effectiveConfig, refreshed } = await getEffectiveConnectorConfig(connector, connConfig);

      const testResult = await connector.testConnection({ ...effectiveConfig, path: input.sourcePath });
      if (!testResult.success) {
        throw new Error(`连接测试失败: ${testResult.message}`);
      }

      // 如果 token 被刷新过，使用刷新后的 token 保存
      const finalConfig = refreshed ? effectiveConfig : connConfig;

      const isScheduled = Boolean(input.cron);
      const values: typeof backupJobs.$inferInsert = {
        target: input.target,
        sourcePath: input.sourcePath,
        status: "pending",
        progress: 0,
        filesTotal: 0,
        filesDone: 0,
        filesFailed: 0,
        config: finalConfig,
        createdBy: ctx.user?.id ?? null,
      };

      if (isScheduled) {
        values.cron = input.cron;
        values.enabled = input.enabled ? "true" : "false";
        values.keepLastN = input.keepLastN;
        values.maxRetries = input.maxRetries;
        values.retryCount = 0;
      }

      const result = await db.insert(backupJobs).values(values);
      const jobId = Number(result[0].insertId);

      if (!isScheduled) {
        executeBackup(jobId, finalConfig).catch(console.error);
      }

      const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
      await logAudit(ctx, "backup_job", isScheduled ? "create" : "run", jobId, input as Record<string, unknown>);
      return job;
    }),

  updateSchedule: adminQuery
    .input(
      z.object({
        id: z.number(),
        cron: z.string().max(100).optional(),
        enabled: z.boolean().optional(),
        keepLastN: z.number().int().min(1).optional(),
        maxRetries: z.number().int().min(0).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      const setData: Record<string, unknown> = {};
      if (data.cron !== undefined) setData.cron = data.cron;
      if (data.enabled !== undefined) setData.enabled = data.enabled ? "true" : "false";
      if (data.keepLastN !== undefined) setData.keepLastN = data.keepLastN;
      if (data.maxRetries !== undefined) setData.maxRetries = data.maxRetries;
      if (data.config !== undefined) setData.config = data.config;
      await db.update(backupJobs).set(clean(setData)).where(eq(backupJobs.id, id));
      await logAudit(ctx, "backup_job", "update", id, input as Record<string, unknown>);
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(backupJobFiles).where(eq(backupJobFiles.jobId, input.id));
      await db.delete(backupJobs).where(eq(backupJobs.id, input.id));
      await logAudit(ctx, "backup_job", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  status: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, input.id));
      if (!job) return null;
      const files = await db.select().from(backupJobFiles).where(eq(backupJobFiles.jobId, input.id));
      return { ...job, files };
    }),

  listRestores: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(restoreJobs).orderBy(desc(restoreJobs.createdAt));
  }),

  createRestore: adminQuery
    .input(
      z.object({
        backupJobId: z.number(),
        targetPath: z.string().min(1).max(500).refine((p) => !hasPathTraversal(p), {
          message: "targetPath contains path traversal",
        }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [backupJob] = await db.select().from(backupJobs).where(eq(backupJobs.id, input.backupJobId));
      if (!backupJob) throw new Error("备份任务不存在");

      const result = await db.insert(restoreJobs).values({
        backupJobId: input.backupJobId,
        targetPath: input.targetPath,
        status: "pending",
        progress: 0,
        filesTotal: 0,
        filesDone: 0,
        filesFailed: 0,
        manifestVerified: "pending",
        createdBy: ctx.user?.id ?? null,
      });
      const restoreJobId = Number(result[0].insertId);

      executeRestore(restoreJobId).catch(console.error);

      const [job] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, restoreJobId));
      await logAudit(ctx, "restore_job", "create", restoreJobId, input as Record<string, unknown>);
      return job;
    }),

  getRestoreById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [job] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, input.id));
      return job ?? null;
    }),
});
