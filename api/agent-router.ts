import { z } from "zod";
import { eq, desc, like, or } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents } from "@db/schema";
import { clean } from "./lib/clean";

export const agentRouter = createRouter({
  list: adminQuery
    .input(
      z.object({
        search: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [];

      if (input?.search) {
        conditions.push(or(
          like(agents.name, `%${input.search}%`),
          like(agents.description, `%${input.search}%`)
        ));
      }
      if (input?.type) {
        conditions.push(eq(agents.type, input.type as "assistant" | "analyst" | "curator" | "connector" | "custom"));
      }
      if (input?.status) {
        conditions.push(eq(agents.status, input.status as "active" | "inactive" | "error" | "training"));
      }

      return db.select().from(agents)
        .where(conditions.length > 0 ? conditions[0] : undefined)
        .orderBy(desc(agents.updatedAt));
    }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(agents).where(eq(agents.id, input.id));
      return results[0] ?? null;
    }),

  create: adminQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        type: z.enum(["assistant", "analyst", "curator", "connector", "custom"]).default("assistant"),
        avatarUrl: z.string().optional(),
        status: z.enum(["active", "inactive", "error", "training"]).default("active"),
        config: z.record(z.string(), z.unknown()).optional(),
        permissions: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(agents).values(clean({
        name: input.name,
        description: input.description,
        type: input.type,
        avatarUrl: input.avatarUrl,
        status: input.status,
        config: input.config as Record<string, unknown>,
        permissions: input.permissions as Record<string, unknown>,
        createdBy: ctx.user?.id ?? null,
      }));
      return { id: Number(result[0].insertId) };
    }),

  update: adminQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        type: z.enum(["assistant", "analyst", "curator", "connector", "custom"]).optional(),
        avatarUrl: z.string().optional(),
        status: z.enum(["active", "inactive", "error", "training"]).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        permissions: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(agents).set(clean(data as Record<string, unknown>)).where(eq(agents.id, id));
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(agents).where(eq(agents.id, input.id));
      return { success: true };
    }),

  updatePermissions: adminQuery
    .input(
      z.object({
        id: z.number(),
        permissions: z.record(z.string(), z.unknown()),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(agents)
        .set({ permissions: input.permissions as Record<string, unknown> })
        .where(eq(agents.id, input.id));
      return { success: true };
    }),
});
