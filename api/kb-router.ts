import { z } from "zod";
import { eq, desc, like, isNull } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { kbFolders, kbDocuments, documentChunks } from "@db/schema";
import { clean } from "./lib/clean";
import { logAudit } from "./lib/audit";
import { vectorEngine } from "./lib/vector";

function chunkText(text: string, maxChars = 800, overlap = 100): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized ? [normalized] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + maxChars, normalized.length);
    let slice = normalized.slice(start, end);
    if (end < normalized.length) {
      const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf(". "));
      if (lastBreak > overlap) {
        slice = slice.slice(0, lastBreak + 1);
      }
    }
    chunks.push(slice.trim());
    start += Math.max(slice.length - overlap, 1);
  }
  return chunks.filter((c) => c.length > 0);
}

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
      // 清理该文件夹及子文件夹下所有文档的向量和分块
      const docs = await db.select({ id: kbDocuments.id }).from(kbDocuments)
        .where(eq(kbDocuments.folderId, input.id));
      for (const doc of docs) {
        await deleteDocumentVectors(doc.id);
      }
      await db.delete(kbDocuments).where(eq(kbDocuments.folderId, input.id));
      const subFolders = await db.select({ id: kbFolders.id }).from(kbFolders)
        .where(eq(kbFolders.parentId, input.id));
      for (const folder of subFolders) {
        const subDocs = await db.select({ id: kbDocuments.id }).from(kbDocuments)
          .where(eq(kbDocuments.folderId, folder.id));
        for (const doc of subDocs) {
          await deleteDocumentVectors(doc.id);
        }
        await db.delete(kbDocuments).where(eq(kbDocuments.folderId, folder.id));
      }
      await db.delete(kbFolders).where(eq(kbFolders.parentId, input.id));
      await db.delete(kbFolders).where(eq(kbFolders.id, input.id));
      await logAudit(ctx, "kb_folder", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  listDocuments: authedQuery
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

  searchDocuments: authedQuery
    .input(z.object({ query: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(kbDocuments)
        .where(like(kbDocuments.title, `%${input.query}%`))
        .orderBy(desc(kbDocuments.updatedAt));
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
      await logAudit(ctx, "kb_document", "create", id, input as Record<string, unknown>);
      return { id };
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
      const db = getDb();
      const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, input.id));
      if (!doc) throw new Error("文档不存在");
      if (!doc.content) return { success: true, chunks: 0 };

      // 删除旧分块和向量
      await deleteDocumentVectors(input.id);

      const chunks = chunkText(doc.content).map((content, index) => ({ content, index }));
      if (chunks.length === 0) return { success: true, chunks: 0 };

      await db.insert(documentChunks).values(chunks.map((chunk) => ({
        documentId: input.id,
        content: chunk.content,
        chunkIndex: chunk.index,
      })));

      await vectorEngine.indexDocumentChunks(
        input.id,
        chunks,
        { title: doc.title, format: doc.format }
      );

      await db.update(kbDocuments)
        .set({ metadata: { ...(doc.metadata ?? {}), vectorized: true } })
        .where(eq(kbDocuments.id, input.id));

      await logAudit(ctx, "kb_document", "update", input.id, { action: "reindex" } as Record<string, unknown>);
      return { success: true, chunks: chunks.length };
    }),

  getTree: authedQuery.query(async () => {
    const db = getDb();
    const folders = await db.select().from(kbFolders).orderBy(kbFolders.sortOrder);
    const docs = await db.select().from(kbDocuments).orderBy(desc(kbDocuments.updatedAt));
    return { folders, documents: docs };
  }),
});
