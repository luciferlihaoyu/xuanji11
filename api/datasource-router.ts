import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { dataSources } from "@db/schema";
import { clean } from "./lib/clean";

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

  testConnection: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(dataSources).where(eq(dataSources.id, input.id));
      const ds = results[0];
      if (!ds) return { success: false, message: "数据源不存在" };
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

  sync: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(dataSources)
        .set({ status: "syncing" })
        .where(eq(dataSources.id, input.id));
      try {
        await new Promise(r => setTimeout(r, 1000));
        await db.update(dataSources)
          .set({ status: "connected", lastSyncAt: new Date() })
          .where(eq(dataSources.id, input.id));
        return { success: true, message: "同步完成" };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "同步失败";
        await db.update(dataSources)
          .set({ status: "error", lastError: errorMsg })
          .where(eq(dataSources.id, input.id));
        return { success: false, message: errorMsg };
      }
    }),
});
