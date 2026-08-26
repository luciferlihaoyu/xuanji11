/**
 * CSRF 中间件工厂（从 boot.ts 抽出以便测试）。
 * 应用到 Hono app：拦截非 GET 写操作的内部 REST 路径与默认路径。
 */
import type { Context, MiddlewareHandler } from "hono";
import {
  csrfProtectedMethods,
  isFullyExemptPath,
  isInternalRestPath,
  isTrustedMutationRequest,
} from "./csrf";

export function createCsrfMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!csrfProtectedMethods.has(c.req.method)) return next();
    const path = c.req.path;

    if (isFullyExemptPath(path)) return next();

    if (isInternalRestPath(path)) {
      if (isTrustedMutationRequest(c.req.raw)) return next();
      return c.json({ success: false, error: "Invalid request" }, 403);
    }

    if (!isTrustedMutationRequest(c.req.raw)) {
      return c.json({ success: false, error: "Invalid request" }, 403);
    }
    return next();
  };
}

/** 工具：响应是否由 csrfMiddleware 拒绝（用于测试断言）。 */
export function isCsrfRejection(_c: Context, response: Response): boolean {
  return response.status === 403;
}
