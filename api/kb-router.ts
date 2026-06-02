import { z } from "zod";
import { eq, desc, isNull, like } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { kbFolders, kbDocuments } from "@db/schema";
import { clean } from "./lib/clean";

export const kbRouter = createRouter({
  listFolders: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(kbFolders).orderBy(kbFolders.sortOrder);
  }),

  listRootFolders: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(kbFolders)
      .where(isNull(kbFolders.parentId))
      .orderBy(kbFolders.sortOrder);
  }),

  listSubFolders: publicQuery
    .input(z.object({ parentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(kbFolders)
        .where(eq(kbFolders.parentId, input.parentId))
        .orderBy(kbFolders.sortOrder);
    }),

  createFolder: publicQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        parentId: z.number().nullable().optional(),
        icon: z.string().max(100).default("folder"),
        sortOrder: z.number().default(0),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(kbFolders).values({
        name: input.name,
        parentId: input.parentId ?? null,
        icon: input.icon,
        sortOrder: input.sortOrder,
        createdBy: ctx.user?.id ?? null,
      });
      return { id: Number(result[0].insertId) };
    }),

  updateFolder: publicQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        parentId: z.number().nullable().optional(),
        icon: z.string().max(100).optional(),
        sortOrder: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(kbFolders).set(clean(data as Record<string, unknown>)).where(eq(kbFolders.id, id));
      return { success: true };
    }),

  deleteFolder: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(kbDocuments).where(eq(kbDocuments.folderId, input.id));
      await db.delete(kbFolders).where(eq(kbFolders.parentId, input.id));
      await db.delete(kbFolders).where(eq(kbFolders.id, input.id));
      return { success: true };
    }),

  listDocuments: publicQuery
    .input(z.object({ folderId: z.number().nullable().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      if (input.folderId) {
        return db.select().from(kbDocuments)
          .where(eq(kbDocuments.folderId, input.folderId))
          .orderBy(desc(kbDocuments.updatedAt));
      }
      return db.select().from(kbDocuments).orderBy(desc(kbDocuments.updatedAt));
    }),

  searchDocuments: publicQuery
    .input(z.object({ query: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(kbDocuments)
        .where(like(kbDocuments.title, `%${input.query}%`))
        .orderBy(desc(kbDocuments.updatedAt));
    }),

  getDocument: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(kbDocuments).where(eq(kbDocuments.id, input.id));
      return results[0] ?? null;
    }),

  createDocument: publicQuery
    .input(
      z.object({
        folderId: z.number().nullable().optional(),
        title: z.string().min(1).max(500),
        content: z.string().optional(),
        format: z.enum(["markdown", "text", "json", "html", "code"]).default("markdown"),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(kbDocuments).values(clean({
        folderId: input.folderId ?? null,
        title: input.title,
        content: input.content,
        format: input.format,
        tags: input.tags,
        metadata: input.metadata as Record<string, unknown>,
        createdBy: ctx.user?.id ?? null,
      }));
      return { id: Number(result[0].insertId) };
    }),

  updateDocument: publicQuery
    .input(
      z.object({
        id: z.number(),
        folderId: z.number().nullable().optional(),
        title: z.string().min(1).max(500).optional(),
        content: z.string().optional(),
        format: z.enum(["markdown", "text", "json", "html", "code"]).optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(kbDocuments).set(clean(data as Record<string, unknown>)).where(eq(kbDocuments.id, id));
      return { success: true };
    }),

  deleteDocument: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(kbDocuments).where(eq(kbDocuments.id, input.id));
      return { success: true };
    }),

  getTree: publicQuery.query(async () => {
    const db = getDb();
    const folders = await db.select().from(kbFolders).orderBy(kbFolders.sortOrder);
    const docs = await db.select().from(kbDocuments).orderBy(desc(kbDocuments.updatedAt));
    return { folders, documents: docs };
  }),
});
