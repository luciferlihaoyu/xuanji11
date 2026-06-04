import { z } from "zod";
import { eq, desc, like, or } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { uploadedFiles } from "@db/schema";
import { clean } from "./lib/clean";

export const fileRouter = createRouter({
  list: publicQuery
    .input(
      z.object({
        search: z.string().optional(),
        mimeType: z.string().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [];

      if (input?.search) {
        conditions.push(or(
          like(uploadedFiles.originalName, `%${input.search}%`),
          like(uploadedFiles.filename, `%${input.search}%`)
        ));
      }
      if (input?.mimeType) {
        conditions.push(like(uploadedFiles.mimeType, `%${input.mimeType}%`));
      }

      return db.select().from(uploadedFiles)
        .where(conditions.length > 0 ? conditions[0] : undefined)
        .orderBy(desc(uploadedFiles.createdAt));
    }),

  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, input.id));
      return results[0] ?? null;
    }),

  register: publicQuery
    .input(
      z.object({
        filename: z.string().min(1).max(500),
        originalName: z.string().min(1).max(500),
        mimeType: z.string().max(255).optional(),
        size: z.number().int().min(0).optional(),
        storagePath: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(uploadedFiles).values(clean({
        filename: input.filename,
        originalName: input.originalName,
        mimeType: input.mimeType,
        size: input.size,
        storagePath: input.storagePath,
        metadata: input.metadata as Record<string, unknown>,
        uploadedBy: ctx.user?.id ?? null,
      }));
      return { id: Number(result[0].insertId) };
    }),

  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        originalName: z.string().min(1).max(500).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(uploadedFiles).set(clean(data as Record<string, unknown>)).where(eq(uploadedFiles.id, id));
      return { success: true };
    }),

  delete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(uploadedFiles).where(eq(uploadedFiles.id, input.id));
      return { success: true };
    }),
});
