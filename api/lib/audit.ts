import { getDb } from "../queries/connection";
import { auditLogs } from "@db/schema";

export type AuditAction = "create" | "update" | "delete" | "run";

export interface AuditContext {
  user?: { id?: number | null } | null;
}

export async function logAudit(
  ctx: AuditContext,
  entityType: string,
  action: AuditAction,
  entityId: number | null,
  input?: Record<string, unknown>
): Promise<void> {
  await logAction(ctx.user?.id ?? null, action, {
    entityType,
    entityId: entityId ?? null,
    input: input ?? {},
  });
}

export async function logAction(
  userId: number | null,
  action: AuditAction,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLogs).values({
      entityType: "action",
      entityId: 0,
      action,
      actorId: userId,
      details: details ?? {},
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("[Audit] Failed to write audit log:", err);
  }
}
