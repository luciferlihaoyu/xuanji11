import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { systemSettings } from "@db/schema";
import { clean } from "./lib/clean";

export const settingRouter = createRouter({
  list: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(systemSettings);
  }),

  listByCategory: authedQuery
    .input(z.object({ category: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(systemSettings)
        .where(eq(systemSettings.category, input.category));
    }),

  getByKey: authedQuery
    .input(z.object({ key: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(systemSettings)
        .where(eq(systemSettings.key, input.key));
      return results[0] ?? null;
    }),

  set: adminQuery
    .input(
      z.object({
        key: z.string().min(1).max(255),
        value: z.string(),
        category: z.string().max(100).default("general"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const existing = await db.select().from(systemSettings)
        .where(eq(systemSettings.key, input.key));

      if (existing.length > 0) {
        await db.update(systemSettings)
          .set(clean({
            value: input.value,
            category: input.category,
            updatedBy: ctx.user?.id ?? null,
          }))
          .where(eq(systemSettings.key, input.key));
      } else {
        await db.insert(systemSettings).values({
          key: input.key,
          value: input.value,
          category: input.category,
          updatedBy: ctx.user?.id ?? null,
        });
      }
      return { success: true };
    }),

  setMany: adminQuery
    .input(
      z.array(z.object({
        key: z.string().min(1).max(255),
        value: z.string(),
        category: z.string().max(100).default("general"),
      }))
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      for (const item of input) {
        const existing = await db.select().from(systemSettings)
          .where(eq(systemSettings.key, item.key));

        if (existing.length > 0) {
          await db.update(systemSettings)
            .set(clean({
              value: item.value,
              category: item.category,
              updatedBy: ctx.user?.id ?? null,
            }))
            .where(eq(systemSettings.key, item.key));
        } else {
          await db.insert(systemSettings).values({
            key: item.key,
            value: item.value,
            category: item.category,
            updatedBy: ctx.user?.id ?? null,
          });
        }
      }
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ key: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(systemSettings).where(eq(systemSettings.key, input.key));
      return { success: true };
    }),
});
