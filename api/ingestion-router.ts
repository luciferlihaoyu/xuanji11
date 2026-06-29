import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { ingestionJobs, ingestionItems } from "@db/schema";

export const ingestionRouter = createRouter({
  listJobs: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(ingestionJobs).orderBy(desc(ingestionJobs.createdAt));
  }),

  getJobById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, input.id));
      return results[0] ?? null;
    }),

  getItemsByJobId: authedQuery
    .input(z.object({ jobId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(ingestionItems).where(eq(ingestionItems.jobId, input.jobId));
    }),

  getItemsBySource: authedQuery
    .input(
      z.object({
        sourceType: z.enum(["upload", "datasource", "backup", "manual"]),
        sourceId: z.string(),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(ingestionItems)
        .where(eq(ingestionItems.jobId, Number(input.sourceId)))
        .orderBy(desc(ingestionItems.createdAt));
    }),
  getItemsByUploadedFileId: authedQuery
    .input(z.object({ uploadedFileId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(ingestionItems)
        .where(sql`${ingestionItems.metadata}->>'$.uploadedFileId' = ${String(input.uploadedFileId)}`)
        .orderBy(desc(ingestionItems.createdAt));
    }),
});
