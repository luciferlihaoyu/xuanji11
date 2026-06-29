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
  try {
    const db = getDb();
    await db.insert(auditLogs).values({
      entityType,
      entityId: entityId ?? 0,
      action,
      actorId: ctx.user?.id ?? null,
      details: input ? { input } : {},
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("[Audit] Failed to write audit log:", err);
  }
}
