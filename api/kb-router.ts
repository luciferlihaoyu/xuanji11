import { z } from "zod";
import { eq, desc, like, isNull, inArray } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { kbFolders, kbDocuments, documentChunks } from "@db/schema";
import { clean } from "./lib/clean";
import { logAudit, logAction } from "./lib/audit";
import { vectorEngine } from "./lib/vector";
import { indexDocumentById, tryIndexDocumentById, startReindexAll, getReindexProgress } from "./lib/document-indexer";
import { collectDescendantFolderIds } from "./lib/kb-tree";

async function deleteDocumentVectors(documentId: number): Promise<void> {
  const db = getDb();
  await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  await vectorEngine.deleteByDocumentId(documentId);
}

export const kbRouter = createRouter({
  listFolders: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(kbFolders).orderBy(kbFolders.sortOrder);
  }),

  listRootFolders: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(kbFolders)
      .where(isNull(kbFolders.parentId))
      .orderBy(kbFolders.sortOrder);
  }),

  listSubFolders: authedQuery
    .input(z.object({ parentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(kbFolders)
        .where(eq(kbFolders.parentId, input.parentId))
        .orderBy(kbFolders.sortOrder);
    }),

  createFolder: adminQuery
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
      const id = Number(result[0].insertId);
      await logAudit(ctx, "kb_folder", "create", id, input as Record<string, unknown>);
      return { id };
    }),

  updateFolder: adminQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        parentId: z.number().nullable().optional(),
        icon: z.string().max(100).optional(),
        sortOrder: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(kbFolders).set(clean(data as Record<string, unknown>)).where(eq(kbFolders.id, id));
      await logAudit(ctx, "kb_folder", "update", id, input as Record<string, unknown>);
      return { success: true };
    }),

  deleteFolder: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // 收集全部层级子孙（修复旧实现只递归一层导致孙级成孤儿的问题），逐层清理文档向量与记录
      const allFolders = await db.select({ id: kbFolders.id, parentId: kbFolders.parentId }).from(kbFolders);
      const descendantIds = collectDescendantFolderIds(allFolders, input.id);
      const targetFolderIds = [input.id, ...descendantIds];

      for (const folderId of targetFolderIds) {
        const docs = await db.select({ id: kbDocuments.id }).from(kbDocuments)
          .where(eq(kbDocuments.folderId, folderId));
        for (const doc of docs) {
          await deleteDocumentVectors(doc.id);
        }
        await db.delete(kbDocuments).where(eq(kbDocuments.folderId, folderId));
      }
      // 先删子孙再删根（id 集合含全部层级，一次 in 条件删除）
      await db.delete(kbFolders).where(inArray(kbFolders.id, targetFolderIds));
      await logAudit(ctx, "kb_folder", "delete", input.id, { ...input, removedFolderCount: targetFolderIds.length } as Record<string, unknown>);
      return { success: true, removedFolderCount: targetFolderIds.length };
    }),

  listDocuments: authedQuery
    .input(z.object({
      folderId: z.number().nullable().optional(),
      limit: z.number().int().min(1).max(1000).default(200),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      if (input.folderId) {
        return db.select().from(kbDocuments)
          .where(eq(kbDocuments.folderId, input.folderId))
          .orderBy(desc(kbDocuments.updatedAt))
          .limit(input.limit)
          .offset(input.offset);
      }
      return db.select().from(kbDocuments).orderBy(desc(kbDocuments.updatedAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  searchDocuments: authedQuery
    .input(z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(1000).default(200),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(kbDocuments)
        .where(like(kbDocuments.title, `%${input.query}%`))
        .orderBy(desc(kbDocuments.updatedAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  getDocument: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(kbDocuments).where(eq(kbDocuments.id, input.id));
      return results[0] ?? null;
    }),

  createDocument: adminQuery
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
      const id = Number(result[0].insertId);
      await logAction(ctx.user?.id ?? null, "create", {
        entityType: "kb_document",
        entityId: id,
        ...input,
      });
      // 自动索引：有内容即入向量库；索引失败不影响文档创建
      const indexed = input.content ? await tryIndexDocumentById(id) : { chunks: 0, skipped: true };
      return { id, chunks: indexed.chunks };
    }),

  updateDocument: adminQuery
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
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(kbDocuments).set(clean(data as Record<string, unknown>)).where(eq(kbDocuments.id, id));
      await logAudit(ctx, "kb_document", "update", id, input as Record<string, unknown>);
      // 内容变更时自动重建索引；索引失败不影响文档更新
      if (input.content !== undefined) {
        await tryIndexDocumentById(id);
      }
      return { success: true };
    }),

  deleteDocument: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await deleteDocumentVectors(input.id);
      const db = getDb();
      await db.delete(kbDocuments).where(eq(kbDocuments.id, input.id));
      await logAudit(ctx, "kb_document", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  moveDocument: adminQuery
    .input(
      z.object({
        id: z.number(),
        folderId: z.number().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.update(kbDocuments)
        .set({ folderId: input.folderId ?? null })
        .where(eq(kbDocuments.id, input.id));
      await logAudit(ctx, "kb_document", "update", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  reindexDocument: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const result = await indexDocumentById(input.id);
      await logAudit(ctx, "kb_document", "update", input.id, { action: "reindex" } as Record<string, unknown>);
      return { success: true, chunks: result.chunks };
    }),

  reindexAll: adminQuery.mutation(async () => {
    return startReindexAll();
  }),

  reindexStatus: authedQuery.query(async () => {
    return { ...getReindexProgress(), vectorSize: vectorEngine.size };
  }),

  getTree: authedQuery.query(async () => {
    const db = getDb();
    const folders = await db.select().from(kbFolders).orderBy(kbFolders.sortOrder);
    const docs = await db.select().from(kbDocuments).orderBy(desc(kbDocuments.updatedAt));
    return { folders, documents: docs };
  }),
});
