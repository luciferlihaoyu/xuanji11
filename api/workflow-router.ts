import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, publicQuery, authedQuery, adminQuery } from "./middleware";import { getDb } from "./queries/connection";
import { workflows, workflowNodes } from "@db/schema";
import { clean } from "./lib/clean";

export const workflowRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(workflows).orderBy(desc(workflows.updatedAt));
  }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const wfResults = await db.select().from(workflows).where(eq(workflows.id, input.id));
      const workflow = wfResults[0];
      if (!workflow) return null;
      const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, input.id));
      return { ...workflow, nodes };
    }),

  create: adminQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        status: z.enum(["draft", "active", "paused", "error", "archived"]).default("draft"),
        canvas: z.record(z.string(), z.unknown()).optional(),
        triggers: z.array(z.record(z.string(), z.unknown())).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(workflows).values(clean({
        name: input.name,
        description: input.description,
        status: input.status,
        canvas: input.canvas as Record<string, unknown>,
        triggers: input.triggers as unknown[],
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
        status: z.enum(["draft", "active", "paused", "error", "archived"]).optional(),
        canvas: z.record(z.string(), z.unknown()).optional(),
        triggers: z.array(z.record(z.string(), z.unknown())).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(workflows).set(clean(data as Record<string, unknown>)).where(eq(workflows.id, id));
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(workflowNodes).where(eq(workflowNodes.workflowId, input.id));
      await db.delete(workflows).where(eq(workflows.id, input.id));
      return { success: true };
    }),

  setStatus: authedQuery
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["draft", "active", "paused", "error", "archived"]),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(workflows)
        .set({ status: input.status })
        .where(eq(workflows.id, input.id));
      return { success: true };
    }),

  listNodes: authedQuery
    .input(z.object({ workflowId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(workflowNodes)
        .where(eq(workflowNodes.workflowId, input.workflowId))
        .orderBy(workflowNodes.sortOrder);
    }),

  createNode: adminQuery
    .input(
      z.object({
        workflowId: z.number(),
        type: z.string().min(1).max(100),
        label: z.string().optional(),
        positionX: z.number().default(0),
        positionY: z.number().default(0),
        config: z.record(z.string(), z.unknown()).optional(),
        connections: z.array(z.record(z.string(), z.unknown())).optional(),
        sortOrder: z.number().default(0),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const values: Record<string, unknown> = {
        workflowId: input.workflowId,
        type: input.type,
        positionX: input.positionX,
        positionY: input.positionY,
        sortOrder: input.sortOrder,
      };
      if (input.label !== undefined) values.label = input.label;
      if (input.config !== undefined) values.config = input.config;
      if (input.connections !== undefined) values.connections = input.connections;
      const result = await db.insert(workflowNodes).values(values as typeof workflowNodes.$inferInsert);
      return { id: Number(result[0].insertId) };
    }),

  updateNode: adminQuery
    .input(
      z.object({
        id: z.number(),
        type: z.string().max(100).optional(),
        label: z.string().optional(),
        positionX: z.number().optional(),
        positionY: z.number().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        connections: z.array(z.record(z.string(), z.unknown())).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(workflowNodes).set(clean(data as Record<string, unknown>)).where(eq(workflowNodes.id, id));
      return { success: true };
    }),

  deleteNode: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(workflowNodes).where(eq(workflowNodes.id, input.id));
      return { success: true };
    }),

  saveFull: adminQuery
    .input(
      z.object({
        workflow: z.object({
          id: z.number(),
          name: z.string().optional(),
          description: z.string().optional(),
          canvas: z.record(z.string(), z.unknown()).optional(),
        }),
        nodes: z.array(z.object({
          id: z.number().optional(),
          type: z.string(),
          label: z.string().optional(),
          positionX: z.number(),
          positionY: z.number(),
          config: z.record(z.string(), z.unknown()).optional(),
          connections: z.array(z.record(z.string(), z.unknown())).optional(),
        })),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { workflow, nodes } = input;
      const { id, ...wfData } = workflow;

      await db.update(workflows).set(clean(wfData as Record<string, unknown>)).where(eq(workflows.id, id));
      await db.delete(workflowNodes).where(eq(workflowNodes.workflowId, id));

      for (const node of nodes) {
        const nodeValues: Record<string, unknown> = {
          workflowId: id,
          type: node.type,
          positionX: node.positionX,
          positionY: node.positionY,
        };
        if (node.label !== undefined) nodeValues.label = node.label;
        if (node.config !== undefined) nodeValues.config = node.config;
        if (node.connections !== undefined) nodeValues.connections = node.connections;
        await db.insert(workflowNodes).values(nodeValues as typeof workflowNodes.$inferInsert);
      }

      return { success: true };
    }),
});
