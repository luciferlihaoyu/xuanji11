/**
 * 天宫 SSO 联邦认证 —— 接收端（P1-3）
 *
 * 协议 v1（固定契约，不得更改）：
 * - 路由：GET /sso/launch?token=<jwt>
 * - 密钥：环境变量 TIANGONG_SSO_SECRET（未配置 → 501）
 * - JWT：HS256，claims { typ:"sso-launch", sub, username?, role, app:"xuanji", iat, exp=iat+120, jti }
 * - 校验顺序：SSO 配置 → token 存在 → 验签+exp（401）→ typ/app（401）→ jti 一次性（401）
 * - 通过 → 按璇玑本地登录机制建登录态 → 302 跳转 "/"
 * - 任何失败不建登录态
 *
 * 与璇玑现状的衔接：
 * - 本地登录态 = xuanji_session cookie（HS256 JWT，jose 签发，365 天），与本地管理员登录同机制
 *   （signLocalToken + getSessionCookieOptions），因此 SSO 进入的用户同样获得 admin 角色。
 * - 本路由挂在 /api/* 之外，天然绕过 CSRF 与 JWT 认证中间件（匿名入口）。
 * - jti 一次性账本为模块级内存 Map（v1 单实例足够），每次使用时顺手清理过期项。
 */
import { Hono } from "hono";
import * as jose from "jose";
import { setCookie } from "hono/cookie";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { signLocalToken } from "./local-auth";
import { env } from "./lib/env";

const SSO_JWT_ALG = "HS256";
const SSO_TOKEN_TYP = "sso-launch";
const SSO_TOKEN_APP = "xuanji";
/** 验签时钟容差（秒）：与本地 verifyLocalToken 的 60s 容差保持一致。 */
const SSO_CLOCK_TOLERANCE_SECONDS = 60;
/** 容差窗口毫秒：jti 一次性账本须保留到 exp + 容差窗口结束，封堵容差窗口内的重放。 */
const SSO_CLOCK_TOLERANCE_MS = SSO_CLOCK_TOLERANCE_SECONDS * 1000;

/** 已消费 jti 的一次性账本：jti -> 过期时间戳（ms）。协议 v1 单实例内存 Map。 */
const usedSsoJtis = new Map<string, number>();

/** 惰性清理已过期的 jti（协议要求“顺手清理过期项”）。 */
function pruneExpiredJtis(now: number): void {
  if (usedSsoJtis.size === 0) return;
  for (const [jti, expiresAt] of usedSsoJtis) {
    if (expiresAt <= now) usedSsoJtis.delete(jti);
  }
}

function getSsoSecret(): Uint8Array | null {
  if (!env.tiangongSsoSecret) return null;
  return new TextEncoder().encode(env.tiangongSsoSecret);
}

export const ssoRouter = new Hono();

// GET /sso/launch?token=<jwt>
ssoRouter.get("/launch", async (c) => {
  // 1. SSO 配置检查：未配置 TIANGONG_SSO_SECRET → 501
  const secret = getSsoSecret();
  if (!secret) {
    return c.json({ error: "SSO 未配置" }, 501);
  }

  // 2. token 存在性
  const token = c.req.query("token") ?? "";
  if (!token) {
    return c.json({ error: "凭证无效或已过期" }, 401);
  }

  // 3. 验签 + exp
  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, secret, {
      algorithms: [SSO_JWT_ALG],
      // 与本地 verifyLocalToken 的 60s 时钟容差保持一致，避免签发/校验两端时钟微小偏差误杀
      clockTolerance: SSO_CLOCK_TOLERANCE_SECONDS,
    });
    payload = result.payload;
  } catch {
    return c.json({ error: "凭证无效或已过期" }, 401);
  }

  // 4. 类型 / 应用校验；jose 默认不拒绝缺失 exp 的 token，显式要求 exp 为有效数字（否则 401）
  if (
    payload.typ !== SSO_TOKEN_TYP ||
    payload.app !== SSO_TOKEN_APP ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp)
  ) {
    return c.json({ error: "凭证无效或已过期" }, 401);
  }

  // 5. 必要声明完整性：sub / role 必填；username 可选，缺省回落 sub
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const role = typeof payload.role === "string" ? payload.role : "";
  const username = typeof payload.username === "string" && payload.username ? payload.username : sub;
  if (!sub || !role) {
    return c.json({ error: "凭证无效或已过期" }, 401);
  }
  // 注：role 仅按契约校验存在性；本地登录态角色由璇玑机制决定（一律 admin），
  // 协议未要求把 SSO role 透传进本地会话载荷。

  // 6. jti 一次性：命中（或缺失）→ 401；顺手清理过期项
  const now = Date.now();
  pruneExpiredJtis(now);
  const jti = typeof payload.jti === "string" && payload.jti ? payload.jti : "";
  if (!jti || usedSsoJtis.has(jti)) {
    return c.json({ error: "凭证无效或已过期" }, 401);
  }
  // 账本保留到 exp 后 60s 容差窗口结束（exp 已在第 4 步校验为有效数字），封堵窗口内重放
  const expiresAt = payload.exp * 1000 + SSO_CLOCK_TOLERANCE_MS;
  usedSsoJtis.set(jti, expiresAt);

  // 7. 建本地登录态：与本地管理员登录同一机制（signLocalToken → xuanji_session cookie）
  const localToken = await signLocalToken(username);
  const cookieOpts = getSessionCookieOptions(c.req.raw.headers);
  setCookie(c, Session.cookieName, localToken, {
    ...cookieOpts,
    maxAge: Session.maxAgeMs / 1000,
  });

  // 8. 302 跳转首页
  return c.redirect("/");
});
