import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { dataSources, ingestionJobs, ingestionItems } from "@db/schema";
import { clean } from "./lib/clean";
import { getConnector } from "./connectors";
import { ingestFile } from "./lib/ingestion";

export const datasourceRouter = createRouter({
  list: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(dataSources).orderBy(desc(dataSources.updatedAt));
  }),

  listByType: authedQuery
    .input(z.object({ type: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(dataSources)
        .where(eq(dataSources.type, input.type as "cloud_drive" | "nas" | "database" | "api" | "webhook" | "rss" | "notion" | "obsidian"))
        .orderBy(desc(dataSources.updatedAt));
    }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(dataSources).where(eq(dataSources.id, input.id));
      return results[0] ?? null;
    }),

  create: adminQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        type: z.enum(["cloud_drive", "nas", "database", "api", "webhook", "rss", "notion", "obsidian"]),
        config: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["connected", "disconnected", "error", "syncing"]).default("disconnected"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(dataSources).values(clean({
        name: input.name,
        type: input.type,
        config: input.config as Record<string, unknown>,
        status: input.status,
        createdBy: ctx.user?.id ?? null,
      }));
      return { id: Number(result[0].insertId) };
    }),

  update: adminQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["connected", "disconnected", "error", "syncing"]).optional(),
        lastError: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(dataSources).set(clean(data as Record<string, unknown>)).where(eq(dataSources.id, id));
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(dataSources).where(eq(dataSources.id, input.id));
      return { success: true };
    }),

  // 测试连接 — 如果配置了平台连接器则使用连接器测试
  testConnection: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(dataSources).where(eq(dataSources.id, input.id));
      const ds = results[0];
      if (!ds) return { success: false, message: "数据源不存在" };

      const config = (ds.config as Record<string, unknown>) || {};
      const platform = config.platform as string | undefined;

      // 如果有平台连接器，优先使用连接器测试
      if (platform) {
        const connector = getConnector(platform);
        if (connector) {
          const result = await connector.testConnection(config);
          await db.update(dataSources)
            .set({
              status: result.success ? "connected" : "error",
              lastError: result.success ? null : result.message,
            })
            .where(eq(dataSources.id, input.id));
          return result;
        }
      }

      // 通用连接测试
      try {
        await db.update(dataSources)
          .set({ status: "connected", lastError: null })
          .where(eq(dataSources.id, input.id));
        return { success: true, message: "连接成功" };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "连接失败";
        await db.update(dataSources)
          .set({ status: "error", lastError: errorMsg })
          .where(eq(dataSources.id, input.id));
        return { success: false, message: errorMsg };
      }
    }),

  // 同步文件 — 使用连接器获取文件列表并进入 ingestion 流水线
  sync: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const results = await db.select().from(dataSources).where(eq(dataSources.id, input.id));
      const ds = results[0];
      if (!ds) return { success: false, message: "数据源不存在" };

      const config = (ds.config as Record<string, unknown>) || {};
      const platform = config.platform as string | undefined;

      await db.update(dataSources)
        .set({ status: "syncing" })
        .where(eq(dataSources.id, input.id));

      try {
        if (!platform) {
          await db.update(dataSources)
            .set({ status: "connected", lastSyncAt: new Date(), lastError: null })
            .where(eq(dataSources.id, input.id));
          return { success: true, message: "同步完成" };
        }

        const connector = getConnector(platform);
        if (!connector) {
          throw new Error(`未找到连接器: ${platform}`);
        }

        const files = await connector.listFiles(config);
        const jobId = (await db.insert(ingestionJobs).values({
          sourceType: "datasource",
          sourceId: String(ds.id),
          status: "running",
          totalItems: files.length,
          processedItems: 0,
          failedItems: 0,
          error: null,
          retryCount: 0,
          metadata: { platform, dataSourceName: ds.name },
          createdBy: ctx.user?.id ?? null,
        }))[0].insertId;

        let processed = 0;
        let failed = 0;
        let skipped = 0;

        for (const file of files) {
          if (file.type !== "file") {
            processed++;
            continue;
          }

          const existing = await db
            .select()
            .from(ingestionItems)
            .where(
              and(
                eq(ingestionItems.jobId, Number(jobId)),
                eq(ingestionItems.externalId, file.id)
              )
            )
            .orderBy(desc(ingestionItems.createdAt))
            .limit(1);

          const existingModifiedAt = (existing[0]?.metadata as Record<string, unknown> | undefined)?.remoteModifiedAt as string | undefined;
          const newModifiedAt = file.modifiedAt?.toISOString();
          if (existingModifiedAt && newModifiedAt && existingModifiedAt >= newModifiedAt) {
            skipped++;
            processed++;
            continue;
          }

          try {
            const downloadUrl = file.downloadUrl ?? (await connector.getDownloadUrl(config, file.id));
            await ingestFile({
              sourceType: "datasource",
              sourceId: String(ds.id),
              fileName: file.name,
              mimeType: file.mimeType || "application/octet-stream",
              size: file.size ?? 0,
              externalId: file.id,
              sourceUrl: file.downloadUrl ?? undefined,
              downloadUrl: downloadUrl ?? undefined,
              metadata: { dataSourceId: ds.id, platform, remoteModifiedAt: newModifiedAt },
              createdBy: ctx.user?.id ?? null,
            });
            processed++;
          } catch (err) {
            failed++;
            console.error(`[DataSource] Ingest failed for ${file.name}:`, err);
          }
        }

        config.documentCount = files.length;

        await db.update(ingestionJobs)
          .set({ processedItems: processed, failedItems: failed, status: failed > 0 && processed === failed ? "failed" : "completed" })
          .where(eq(ingestionJobs.id, Number(jobId)));

        await db.update(dataSources)
          .set({
            status: failed > 0 && processed === failed ? "error" : "connected",
            lastSyncAt: new Date(),
            config,
            lastError: failed > 0 ? `${failed} 个文件入库失败` : null,
          })
          .where(eq(dataSources.id, input.id));

        return { success: failed === 0, message: `同步完成: ${processed} 处理, ${skipped} 跳过, ${failed} 失败` };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "同步失败";
        await db.update(dataSources)
          .set({ status: "error", lastError: errorMsg })
          .where(eq(dataSources.id, input.id));
        return { success: false, message: errorMsg };
      }
    }),
});
