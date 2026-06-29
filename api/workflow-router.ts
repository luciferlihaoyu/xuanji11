import { z } from "zod";
import { eq, desc, and, notInArray } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { workflows, workflowNodes, workflowRuns, workflowRunNodes } from "@db/schema";
import { clean } from "./lib/clean";
import { executeWorkflow } from "./lib/workflow-runtime";

export const workflowRouter = createRouter({
  list: authedQuery.query(async () => {
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
          clientId: z.string().min(1),
          type: z.string().min(1),
          label: z.string().optional(),
          positionX: z.number(),
          positionY: z.number(),
          config: z.record(z.string(), z.unknown()).optional(),
        })),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { workflow, nodes } = input;
      const { id, ...wfData } = workflow;

      await db.update(workflows).set(clean(wfData as Record<string, unknown>)).where(eq(workflows.id, id));

      const canvas = (workflow.canvas ?? {}) as Record<string, unknown>;
      const edges = (canvas.edges as Array<{ sourceClientId: string; targetClientId: string }> | undefined) ?? [];

      const existingIds = nodes.map((n) => n.id).filter((n): n is number => n !== undefined);
      if (existingIds.length > 0) {
        await db.delete(workflowNodes)
          .where(and(eq(workflowNodes.workflowId, id), notInArray(workflowNodes.id, existingIds)));
      } else {
        await db.delete(workflowNodes).where(eq(workflowNodes.workflowId, id));
      }

      const clientIdToDbId = new Map<string, number>();

      for (const node of nodes) {
        const baseValues = {
          workflowId: id,
          type: node.type,
          label: node.label,
          positionX: node.positionX,
          positionY: node.positionY,
          config: node.config as Record<string, unknown>,
          connections: [] as unknown[],
        };
        if (node.id) {
          await db.update(workflowNodes).set(clean(baseValues as Record<string, unknown>)).where(eq(workflowNodes.id, node.id));
          clientIdToDbId.set(node.clientId, node.id);
        } else {
          const result = await db.insert(workflowNodes).values(baseValues as typeof workflowNodes.$inferInsert);
          const newId = Number(result[0].insertId);
          clientIdToDbId.set(node.clientId, newId);
        }
      }

      for (const node of nodes) {
        const dbId = clientIdToDbId.get(node.clientId);
        if (!dbId) continue;
        const outgoing = edges
          .filter((e) => e.sourceClientId === node.clientId)
          .map((e) => ({ targetId: clientIdToDbId.get(e.targetClientId) }))
          .filter((e): e is { targetId: number } => e.targetId !== undefined);
        await db.update(workflowNodes)
          .set({ connections: outgoing as unknown[] })
          .where(eq(workflowNodes.id, dbId));
      }

      const updatedNodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, id));
      return { success: true, nodes: updatedNodes };
    }),

  run: adminQuery
    .input(z.object({ id: z.number(), input: z.record(z.string(), z.unknown()).optional() }))
    .mutation(async ({ input, ctx }) => {
      const runId = await executeWorkflow(input.id, input.input ?? {}, ctx.user?.id ?? null);
      return { runId };
    }),

  listRuns: authedQuery
    .input(z.object({ workflowId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, input.workflowId)).orderBy(desc(workflowRuns.createdAt));
    }),

  getRun: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, input.id));
      if (!run) return null;
      const nodes = await db.select().from(workflowRunNodes).where(eq(workflowRunNodes.runId, input.id));
      return { ...run, nodes };
    }),
});
