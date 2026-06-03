import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { dataSources } from "@db/schema";
import { clean } from "./lib/clean";
import { getConnector } from "./connectors";

export const datasourceRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(dataSources).orderBy(desc(dataSources.updatedAt));
  }),

  listByType: publicQuery
    .input(z.object({ type: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(dataSources)
        .where(eq(dataSources.type, input.type as "cloud_drive" | "nas" | "database" | "api" | "webhook" | "rss" | "notion" | "obsidian"))
        .orderBy(desc(dataSources.updatedAt));
    }),

  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(dataSources).where(eq(dataSources.id, input.id));
      return results[0] ?? null;
    }),

  create: publicQuery
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

  update: publicQuery
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

  delete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(dataSources).where(eq(dataSources.id, input.id));
      return { success: true };
    }),

  // 测试连接 — 如果配置了平台连接器则使用连接器测试
  testConnection: publicQuery
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

  // 同步文件 — 使用连接器获取文件列表
  sync: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
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
        // 如果有平台连接器，获取文件列表
        let fileCount = 0;
        if (platform) {
          const connector = getConnector(platform);
          if (connector) {
            const files = await connector.listFiles(config);
            fileCount = files.length;
            // 将文件数量保存到配置中
            config.documentCount = fileCount;
          }
        }

        await db.update(dataSources)
          .set({
            status: "connected",
            lastSyncAt: new Date(),
            config,
            lastError: null,
          })
          .where(eq(dataSources.id, input.id));
        return { success: true, message: fileCount > 0 ? `同步完成，获取到 ${fileCount} 个文件` : "同步完成" };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "同步失败";
        await db.update(dataSources)
          .set({ status: "error", lastError: errorMsg })
          .where(eq(dataSources.id, input.id));
        return { success: false, message: errorMsg };
      }
    }),
});
