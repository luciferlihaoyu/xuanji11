import { z } from "zod";
import { eq, desc, count } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { auditLogs, users } from "@db/schema";

export const auditRouter = createRouter({
  listLogs: adminQuery
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;

      const [totalRow] = await db.select({ value: count() }).from(auditLogs);
      const total = totalRow?.value ?? 0;

      const rows = await db
        .select({
          id: auditLogs.id,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          details: auditLogs.details,
          actorId: auditLogs.actorId,
          userName: users.name,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.actorId, users.id))
        .orderBy(desc(auditLogs.createdAt))
        .limit(input.pageSize)
        .offset(offset);

      return {
        logs: rows.map((r) => ({
          id: r.id,
          entityType: r.entityType,
          entityId: r.entityId,
          action: r.action,
          details: r.details,
          actorId: r.actorId,
          userName: r.userName,
          createdAt: r.createdAt,
        })),
        total,
        page: input.page,
        pageSize: input.pageSize,
        totalPages: Math.ceil(total / input.pageSize),
      };
    }),

  getLogEntry: adminQuery
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [row] = await db
        .select({
          id: auditLogs.id,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          details: auditLogs.details,
          actorId: auditLogs.actorId,
          userName: users.name,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.actorId, users.id))
        .where(eq(auditLogs.id, input.id));

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "记录不存在",
        });
      }

      return row;
    }),
});
