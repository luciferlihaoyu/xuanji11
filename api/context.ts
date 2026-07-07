import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { authenticateRequest as authenticateOAuthRequest } from "./kimi/auth";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  user?: User;
  auth?: AuthInfo;
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
      ctx.auth = sessionAuth(localUser);
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
      ctx.auth = sessionAuth(oauthUser);
      return ctx;
    }
  } catch {
    // OAuth 失败，继续尝试 Bearer API Key
  }

  // 3. Bearer token (API key) for external agents
  try {
    const bearerIdentity = await authenticateApiKey(opts.req.headers);
    if (bearerIdentity) {
      ctx.user = bearerIdentity.user;
      ctx.auth = bearerIdentity.auth;
      return ctx;
    }
  } catch {
    // Bearer auth failed, continue
  }

  return ctx;
}
