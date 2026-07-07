import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, apiKeys, users, type User } from "@db/schema";
import { getDb } from "../queries/connection";

export type AuthInfo = {
  readonly type: "session" | "apiKey";
  readonly userId: number;
  readonly agentId?: number;
  readonly scopes: string[];
  readonly permissions?: Record<string, unknown>;
};

export type AuthenticatedIdentity = {
  readonly user: User;
  readonly auth: AuthInfo;
};

export const MANAGEMENT_SCOPES = [
  "knowledge:read",
  "knowledge:write",
  "knowledge:delete",
  "documents:read",
  "documents:write",
  "documents:delete",
  "workflows:read",
  "workflows:write",
  "workflows:delete",
  "workflows:execute",
  "workflows:design",
  "agents:read",
  "backups:read",
  "backups:write",
  "system:manage",
] as const;

const PERMISSION_SCOPES: Readonly<Record<string, readonly string[]>> = {
  read: ["knowledge:read", "documents:read", "workflows:read", "agents:read", "backups:read"],
  write: ["knowledge:write", "documents:write", "workflows:write", "backups:write"],
  delete: ["knowledge:delete", "documents:delete", "workflows:delete"],
  manage: ["system:manage"],
  triggerWorkflow: ["workflows:execute"],
  executeWorkflow: ["workflows:execute"],
  designWorkflow: ["workflows:design"],
};

export function sessionAuth(user: User): AuthInfo {
  return { type: "session", userId: user.id, scopes: [...MANAGEMENT_SCOPES] };
}

export function scopesFromPermissions(permissions: Record<string, unknown> | null | undefined): string[] {
  const scopes = new Set<string>();
  for (const [permission, enabled] of Object.entries(permissions ?? {})) {
    if (enabled) {
      for (const scope of PERMISSION_SCOPES[permission] ?? []) scopes.add(scope);
    }
  }
  return [...scopes];
}

export function hasScope(auth: AuthInfo | undefined, scope: string): boolean {
  return auth?.scopes.includes(scope) ?? false;
}

export async function authenticateApiKey(headers: Headers): Promise<AuthenticatedIdentity | undefined> {
  const authHeader = headers.get("Authorization") ?? headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return undefined;

  const rawKey = authHeader.slice("Bearer ".length).trim();
  if (!rawKey) return undefined;

  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const db = getDb();
  const [keyRecord] = await db.select().from(apiKeys).where(and(
    eq(apiKeys.keyHash, keyHash),
    eq(apiKeys.isActive, "true"),
  ));
  if (!keyRecord) return undefined;

  if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) return undefined;

  const [agent] = await db.select().from(agents).where(eq(agents.id, keyRecord.agentId));
  const ownerId = keyRecord.createdBy ?? agent?.createdBy;
  if (!ownerId) return undefined;

  const [user] = await db.select().from(users).where(eq(users.id, ownerId));
  if (!user) return undefined;
  if (user.role !== "admin") return undefined;

  void db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, keyRecord.id))
    .catch(() => undefined);

  return {
    user,
    auth: {
      type: "apiKey",
      userId: user.id,
      agentId: keyRecord.agentId,
      scopes: keyRecord.scopes ?? scopesFromPermissions(keyRecord.permissions),
      permissions: keyRecord.permissions ?? undefined,
    },
  };
}
