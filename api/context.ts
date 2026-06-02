import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { User } from "@db/schema";
import { authenticateLocalRequest } from "./local-auth";
import { authenticateRequest as authenticateOAuthRequest } from "./kimi/auth";

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
    ctx.user = await authenticateOAuthRequest(opts.req.headers);
  } catch {
    // OAuth 也失败，用户未登录
  }

  return ctx;
}
