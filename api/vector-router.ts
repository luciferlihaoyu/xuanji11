import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { vectorCollections } from "@db/schema";
import { clean } from "./lib/clean";

export const vectorRouter = createRouter({
  list: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(vectorCollections).orderBy(desc(vectorCollections.updatedAt));
  }),

  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(vectorCollections).where(eq(vectorCollections.id, input.id));
      return results[0] ?? null;
    }),

  create: publicQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        model: z.string().max(255).default("text-embedding-3-small"),
        dimension: z.number().int().default(1536),
        status: z.enum(["ready", "building", "error"]).default("ready"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(vectorCollections).values(clean({
        name: input.name,
        description: input.description,
        model: input.model,
        dimension: input.dimension,
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
        description: z.string().optional(),
        model: z.string().max(255).optional(),
        dimension: z.number().int().optional(),
        status: z.enum(["ready", "building", "error"]).optional(),
        documentCount: z.number().int().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(vectorCollections).set(clean(data as Record<string, unknown>)).where(eq(vectorCollections.id, id));
      return { success: true };
    }),

  delete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(vectorCollections).where(eq(vectorCollections.id, input.id));
      return { success: true };
    }),

  updateDocCount: publicQuery
    .input(
      z.object({
        id: z.number(),
        count: z.number().int(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(vectorCollections)
        .set({ documentCount: input.count })
        .where(eq(vectorCollections.id, input.id));
      return { success: true };
    }),
});
