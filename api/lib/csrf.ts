/**
 * CSRF 防护纯函数（供 boot.ts 中间件与 webhook 鉴权使用）。
 * 抽成独立模块以便单测——boot.ts 是带启动副作用的装配层，不可在 vitest 中导入。
 */
import { createHmac } from "crypto";

/** 非 GET/HEAD/OPTIONS 请求需要 CSRF 校验。 */
export const csrfProtectedMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 完全豁免 CSRF 的路径：以独立凭据鉴权或公开端点。
 * - /api/mcp、/api/mcp/sse：Agent Token / MCP 协议自身鉴权；
 * - workflow webhook：改为 ?token= HMAC 签名校验（见 verifyWebhookToken）。
 */
export function isFullyExemptPath(path: string): boolean {
  return (
    path === "/api/mcp" ||
    path === "/api/mcp/sse" ||
    /^\/api\/workflows\/[^/]+\/webhook$/.test(path)
  );
}

/**
 * 内部 REST 前缀：这批路由外层放行匿名、由 router 内部自行鉴权
 * （cookie 会话或 API Key）。其非 GET 请求必须满足可信变更条件，
 * 否则携带管理员会话 cookie 的跨站请求可伪造写操作（审查 P0-1）。
 */
const INTERNAL_REST_PREFIXES = [
  "/api/search",
  "/api/zvec/",
  "/api/kb/",
  "/api/keywords/",
  "/api/relations/",
];

export function isInternalRestPath(path: string): boolean {
  return INTERNAL_REST_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** 可信变更：X-Requested-With 头，或 Origin 与请求同源。 */
export function isTrustedMutationRequest(req: Request): boolean {
  if (req.headers.get("x-requested-with") === "XMLHttpRequest") return true;
  const origin = req.headers.get("origin");
  try {
    return Boolean(origin && origin === new URL(req.url).origin);
  } catch {
    return false;
  }
}

/** 工作流 webhook 签名：HMAC-SHA256(secret, "wf-webhook:<id>") 前 32 位 hex。 */
export function webhookToken(workflowId: number, secret: string): string {
  return createHmac("sha256", secret).update(`wf-webhook:${workflowId}`).digest("hex").slice(0, 32);
}

export function verifyWebhookToken(workflowId: number, token: string, secret: string): boolean {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return false;
  const expected = webhookToken(workflowId, secret);
  if (expected.length !== token.length) return false;
  // 常数时间比较防时序侧信道
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
