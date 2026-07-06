import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, apiKeys } from "@db/schema";
import type { User } from "@db/schema";
import { authenticateLocalRequest } from "./local-auth";
import { authenticateRequest as authenticateOAuthRequest } from "./kimi/auth";
import { getDb } from "./queries/connection";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  user?: User;
};

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<TrpcContext> {
  const ctx: TrpcContext = { req: opts.req, resHeaders: opts.resHeaders };

  // 1. 先尝试本地管理员认证
  try {
    const localUser = await authenticateLocalRequest(opts.req.headers);
    if (localUser) {
      ctx.user = localUser;
      return ctx;
    }
  } catch {
    // 本地认证失败，继续尝试 OAuth
  }

  // 2. 再尝试 Kimi OAuth 认证（可选）
  try {
    const oauthUser = await authenticateOAuthRequest(opts.req.headers);
    if (oauthUser) {
      ctx.user = oauthUser;
      return ctx;
    }
  } catch {
    // OAuth 失败，继续尝试 Bearer API Key
  }

  // 3. Bearer token (API key) for external agents
  try {
    const bearerUser = await authenticateBearerRequest(opts.req.headers);
    if (bearerUser) {
      ctx.user = bearerUser;
      return ctx;
    }
  } catch {
    // Bearer auth failed, continue
  }

  return ctx;
}

async function authenticateBearerRequest(headers: Headers): Promise<User | undefined> {
  const authHeader = headers.get("Authorization") || headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return undefined;

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey) return undefined;

  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const db = getDb();
  const results = await db.select().from(apiKeys).where(and(
    eq(apiKeys.keyHash, keyHash),
    eq(apiKeys.isActive, "true"),
  ));

  const keyRecord = results[0];
  if (!keyRecord) return undefined;

  if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
    return undefined;
  }

  void db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, keyRecord.id))
    .catch(() => undefined);

  const agentResults = await db.select().from(agents).where(eq(agents.id, keyRecord.agentId));
  const agent = agentResults[0];

  const user: User = {
    id: keyRecord.agentId,
    unionId: `api_key:${keyRecord.id}`,
    name: agent?.name ?? `API Key: ${keyRecord.name}`,
    email: null,
    avatar: null,
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignInAt: new Date(),
  };

  return user;
}
