import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { knowledgeNodes, knowledgeEdges, documentChunks } from "@db/schema";
import { clean } from "./lib/clean";
import { vectorEngine } from "./lib/vector";
import { logAudit } from "./lib/audit";

export const knowledgeRouter = createRouter({
  listNodes: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(knowledgeNodes).orderBy(desc(knowledgeNodes.updatedAt));
  }),

  searchNodes: authedQuery
    .input(z.object({ query: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const q = `%${input.query}%`;
      return db.select().from(knowledgeNodes)
        .where(sql`${knowledgeNodes.title} LIKE ${q} OR ${knowledgeNodes.content} LIKE ${q}`)
        .orderBy(desc(knowledgeNodes.updatedAt));
    }),

  getNode: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(knowledgeNodes).where(eq(knowledgeNodes.id, input.id));
      return results[0] ?? null;
    }),

  createNode: adminQuery
    .input(
      z.object({
        title: z.string().min(1).max(500),
        content: z.string().optional(),
        type: z.enum(["concept", "document", "topic", "entity", "note", "tag"]).default("concept"),
        posX: z.number().default(0),
        posY: z.number().default(0),
        style: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(knowledgeNodes).values(clean({
        title: input.title,
        content: input.content,
        type: input.type,
        posX: input.posX,
        posY: input.posY,
        style: input.style as Record<string, unknown>,
        metadata: input.metadata as Record<string, unknown>,
        createdBy: ctx.user?.id ?? null,
      }));
      const id = Number(result[0].insertId);
      await logAudit(ctx, "knowledge_node", "create", id, input as Record<string, unknown>);
      return { id };
    }),

  updateNode: adminQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).max(500).optional(),
        content: z.string().optional(),
        type: z.enum(["concept", "document", "topic", "entity", "note", "tag"]).optional(),
        posX: z.number().optional(),
        posY: z.number().optional(),
        style: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(knowledgeNodes).set(clean(data as Record<string, unknown>)).where(eq(knowledgeNodes.id, id));
      await logAudit(ctx, "knowledge_node", "update", id, input as Record<string, unknown>);
      return { success: true };
    }),

  deleteNode: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [node] = await db.select().from(knowledgeNodes).where(eq(knowledgeNodes.id, input.id));
      const linkedDocId = node?.metadata && typeof node.metadata === "object"
        ? (node.metadata as Record<string, unknown>).documentId
        : undefined;
      if (typeof linkedDocId === "number") {
        const [doc] = await db.select({ id: knowledgeNodes.id }).from(knowledgeNodes)
          .where(eq(knowledgeNodes.id, linkedDocId));
        if (doc) {
          await db.delete(documentChunks).where(eq(documentChunks.documentId, linkedDocId));
          await vectorEngine.deleteByDocumentId(linkedDocId);
        }
      }
      await db.delete(knowledgeEdges).where(
        sql`${knowledgeEdges.sourceId} = ${input.id} OR ${knowledgeEdges.targetId} = ${input.id}`
      );
      await db.delete(knowledgeNodes).where(eq(knowledgeNodes.id, input.id));
      await logAudit(ctx, "knowledge_node", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  updateNodePositions: adminQuery
    .input(
      z.array(z.object({
        id: z.number(),
        posX: z.number(),
        posY: z.number(),
      }))
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      for (const node of input) {
        await db.update(knowledgeNodes)
          .set({ posX: node.posX, posY: node.posY })
          .where(eq(knowledgeNodes.id, node.id));
      }
      await logAudit(ctx, "knowledge_node", "update", null, { nodes: input } as Record<string, unknown>);
      return { success: true };
    }),

  listEdges: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(knowledgeEdges).orderBy(desc(knowledgeEdges.createdAt));
  }),

  createEdge: adminQuery
    .input(
      z.object({
        sourceId: z.number(),
        targetId: z.number(),
        label: z.string().optional(),
        type: z.enum(["related", "contains", "references", "extends", "similar", "sequence"]).default("related"),
        weight: z.number().default(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(knowledgeEdges).values(clean({
        sourceId: input.sourceId,
        targetId: input.targetId,
        label: input.label,
        type: input.type,
        weight: input.weight,
        createdBy: ctx.user?.id ?? null,
      }));
      const id = Number(result[0].insertId);
      await logAudit(ctx, "knowledge_edge", "create", id, input as Record<string, unknown>);
      return { id };
    }),

  deleteEdge: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(knowledgeEdges).where(eq(knowledgeEdges.id, input.id));
      await logAudit(ctx, "knowledge_edge", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  getGraph: authedQuery.query(async () => {
    const db = getDb();
    const nodes = await db.select().from(knowledgeNodes);
    const edges = await db.select().from(knowledgeEdges);
    return { nodes, edges };
  }),

  /** 语义搜索 — 使用向量引擎 */
  semanticSearch: authedQuery
    .input(z.object({ query: z.string().min(1), topK: z.number().min(1).max(50).default(10) }))
    .query(async ({ input }) => {
      const results = await vectorEngine.searchByText(input.query, input.topK);

      // 回退：向量库为空时回退到 LIKE 搜索
      if (results.length === 0) {
        const db = getDb();
        const q = `%${input.query}%`;
        const dbResults = await db.select().from(knowledgeNodes)
          .where(sql`${knowledgeNodes.title} LIKE ${q} OR ${knowledgeNodes.content} LIKE ${q}`)
          .orderBy(desc(knowledgeNodes.updatedAt))
          .limit(input.topK);
        return {
          mode: "fallback" as const,
          engine: "mysql-like",
          results: dbResults.map((n) => ({
            id: String(n.id),
            score: 1,
            title: n.title,
            snippet: (n.content ?? "").slice(0, 200),
            type: n.type,
          })),
        };
      }

      return {
        mode: "semantic" as const,
        engine: "cosine",
        results: results.map((r) => ({
          id: r.id,
          score: Math.round(r.score * 100) / 100,
          title: (r.metadata.title as string) ?? r.id,
          snippet: (r.metadata.content as string)?.slice(0, 200) ?? "",
          type: r.metadata.type as string ?? "note",
        })),
      };
    }),

  /** 向量健康检查 */
  vectorHealth: authedQuery.query(async () => {
    const engine = await vectorEngine.healthCheck();
    return {
      ...engine,
      mode: engine.mode === 'indexed' ? 'semantic' : 'fallback',
    };
  }),
});
