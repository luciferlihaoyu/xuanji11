import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { knowledgeNodes, knowledgeEdges } from "@db/schema";
import { clean } from "./lib/clean";

export const knowledgeRouter = createRouter({
  listNodes: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(knowledgeNodes).orderBy(desc(knowledgeNodes.updatedAt));
  }),

  searchNodes: publicQuery
    .input(z.object({ query: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const q = `%${input.query}%`;
      return db.select().from(knowledgeNodes)
        .where(sql`${knowledgeNodes.title} LIKE ${q} OR ${knowledgeNodes.content} LIKE ${q}`)
        .orderBy(desc(knowledgeNodes.updatedAt));
    }),

  getNode: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(knowledgeNodes).where(eq(knowledgeNodes.id, input.id));
      return results[0] ?? null;
    }),

  createNode: publicQuery
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
      return { id: Number(result[0].insertId) };
    }),

  updateNode: publicQuery
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
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(knowledgeNodes).set(clean(data as Record<string, unknown>)).where(eq(knowledgeNodes.id, id));
      return { success: true };
    }),

  deleteNode: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(knowledgeEdges).where(
        sql`${knowledgeEdges.sourceId} = ${input.id} OR ${knowledgeEdges.targetId} = ${input.id}`
      );
      await db.delete(knowledgeNodes).where(eq(knowledgeNodes.id, input.id));
      return { success: true };
    }),

  updateNodePositions: publicQuery
    .input(
      z.array(z.object({
        id: z.number(),
        posX: z.number(),
        posY: z.number(),
      }))
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      for (const node of input) {
        await db.update(knowledgeNodes)
          .set({ posX: node.posX, posY: node.posY })
          .where(eq(knowledgeNodes.id, node.id));
      }
      return { success: true };
    }),

  listEdges: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(knowledgeEdges).orderBy(desc(knowledgeEdges.createdAt));
  }),

  createEdge: publicQuery
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
      return { id: Number(result[0].insertId) };
    }),

  deleteEdge: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(knowledgeEdges).where(eq(knowledgeEdges.id, input.id));
      return { success: true };
    }),

  getGraph: publicQuery.query(async () => {
    const db = getDb();
    const nodes = await db.select().from(knowledgeNodes);
    const edges = await db.select().from(knowledgeEdges);
    return { nodes, edges };
  }),
});
