import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { backupJobs, backupJobFiles, restoreJobs } from "@db/schema";
import { logAudit, logAction } from "./lib/audit";
import { clean } from "./lib/clean";
import { env } from "./lib/env";
import { hasPathTraversal } from "./lib/backup-path";
import { getBackupRepository } from "./backup-repositories/base";
import { executeBackup, executeRestore, serializeBackupJob } from "./backup-repositories/execution";

const BACKUP_TARGETS = ["alist", "nas", "local"] as const;

const TARGET_META: readonly { key: string; name: string; deprecated?: boolean }[] = [
  { key: "alist", name: "AList 网盘" },
  { key: "nas", name: "NAS / 本地存储" },
  { key: "local", name: "本地目录" },
  { key: "115", name: "115 网盘", deprecated: true },
  { key: "aliyundrive", name: "阿里云盘", deprecated: true },
];

/** 审计入参：只记录 key，不含 config 中的任何凭据。 */
function auditDetails(input: {
  target: string;
  sourcePath: string;
  cron?: string;
  enabled?: boolean;
  keepLastN?: number;
  maxRetries?: number;
}): Record<string, unknown> {
  return {
    target: input.target,
    sourcePath: input.sourcePath,
    cron: input.cron ?? null,
    enabled: input.enabled ?? null,
    keepLastN: input.keepLastN ?? null,
    maxRetries: input.maxRetries ?? null,
  };
}

export const backupRouter = createRouter({
  targets: authedQuery.query(async () => {
    return TARGET_META.map((meta) => ({
      key: meta.key,
      name: meta.name,
      available: !meta.deprecated && Boolean(getBackupRepository(meta.key)),
      ...(meta.deprecated ? { deprecated: true } : {}),
    }));
  }),

  list: authedQuery.query(async () => {
    const db = getDb();
    const jobs = await db.select().from(backupJobs).orderBy(desc(backupJobs.createdAt));
    return jobs.map(serializeBackupJob);
  }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, input.id));
      if (!job) return null;
      const files = await db.select().from(backupJobFiles).where(eq(backupJobFiles.jobId, input.id));
      return { ...serializeBackupJob(job), files };
    }),

  create: adminQuery
    .input(
      z.object({
        target: z.enum(BACKUP_TARGETS),
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

      // 加密策略：AList 备份必须配置 BACKUP_ENCRYPTION_KEY
      if (input.target === "alist" && !env.backupEncryptionKey) {
        throw new Error("请先配置 BACKUP_ENCRYPTION_KEY 环境变量，再创建 AList 备份目标");
      }

      const repo = getBackupRepository(input.target);
      if (!repo) {
        throw new Error(`备份目标不可用: ${input.target}`);
      }

      const connConfig = input.config ?? {};

      const testResult = await repo.testConnection(connConfig);
      if (!testResult.success) {
        throw new Error(`连接测试失败: ${testResult.message}`);
      }

      const isScheduled = Boolean(input.cron);
      const values: typeof backupJobs.$inferInsert = {
        target: input.target,
        sourcePath: input.sourcePath,
        status: "pending",
        progress: 0,
        filesTotal: 0,
        filesDone: 0,
        filesFailed: 0,
        config: connConfig,
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
      const jobId = Number(result.lastInsertRowid);

      if (!isScheduled) {
        executeBackup(jobId, connConfig).catch(console.error);
      }

      const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
      await logAction(ctx.user?.id ?? null, isScheduled ? "create" : "run", {
        entityType: "backup_job",
        entityId: jobId,
        ...auditDetails(input),
      });
      return job ? serializeBackupJob(job) : null;
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
      // 审计只记录 key，config（可能含凭据）不落 audit
      await logAudit(ctx, "backup_job", "update", id, {
        id,
        cron: data.cron ?? null,
        enabled: data.enabled ?? null,
        keepLastN: data.keepLastN ?? null,
        maxRetries: data.maxRetries ?? null,
      });
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(backupJobFiles).where(eq(backupJobFiles.jobId, input.id));
      await db.delete(backupJobs).where(eq(backupJobs.id, input.id));
      await logAudit(ctx, "backup_job", "delete", input.id, { id: input.id });
      return { success: true };
    }),

  status: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, input.id));
      if (!job) return null;
      const files = await db.select().from(backupJobFiles).where(eq(backupJobFiles.jobId, input.id));
      return { ...serializeBackupJob(job), files };
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
      const restoreJobId = Number(result.lastInsertRowid);

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
