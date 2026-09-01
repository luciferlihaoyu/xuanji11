/**
 * 天宫 SSO 联邦认证 —— 接收端（P1-3）
 *
 * 协议 v2（EdDSA 主路径 + HS256 兼容回退）：
 * - 路由：GET /sso/launch?token=<jwt>（与 v1 相同）
 * - v2：天宫用 Ed25519 私钥签票（EdDSA，header 带 kid），公钥经 JWKS 端点发布。
 *   本端读 token header 的 alg/kid → 从 TIANGONG_JWKS_URL 拉取 JWKS
 *   （模块级缓存 10 分钟，AbortSignal 5s 超时；遇到未知 kid 强制刷新一次再找，
 *   防轮换窗口 401 误杀；强刷带 30s 全局节流 + 单飞合并，防缓存击穿与出站放大；
 *   content-length > 64KB 视为异常响应）→ jose importJWK + jwtVerify（clockTolerance 60s）
 * - v1 兼容：alg=HS256 时仍用共享密钥 TIANGONG_SSO_SECRET 验签，逻辑不变
 *   ——这是两端部署顺序错位与回滚场景的安全网
 * - 配置语义：无 secret 且无 JWKS URL → 501（"SSO 未配置"，沿用 v1）；
 *   有任一来源后，验签失败一律 401（含 JWKS 拉取失败/公钥未命中）
 * - 校验顺序：SSO 配置 → token 存在 → 验签+exp（401）→ typ/app（401）
 *   → 声明完整性（401）→ jti 一次性（401）；通过 → 建本地登录态 → 302 "/"
 * - 任何失败不建登录态
 *
 * 与璇玑现状的衔接：
 * - 本地登录态 = xuanji_session cookie（HS256 JWT，jose 签发，30 天），与本地管理员登录同机制
 *   （signLocalToken + getSessionCookieOptions），因此 SSO 进入的用户同样获得 admin 角色。
 * - 本路由挂在 /api/* 之外，天然绕过 CSRF 与 JWT 认证中间件（匿名入口）。
 * - jti 一次性账本为模块级内存 Map（单实例足够），每次使用时顺手清理过期项。
 */
import { Hono } from "hono";
import * as jose from "jose";
import { setCookie } from "hono/cookie";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { signLocalToken } from "./local-auth";
import { env } from "./lib/env";

const SSO_TOKEN_TYP = "sso-launch";
const SSO_TOKEN_APP = "xuanji";
/** 验签时钟容差（秒）：与本地 verifyLocalToken 的 60s 容差保持一致。 */
const SSO_CLOCK_TOLERANCE_SECONDS = 60;
/** 容差窗口毫秒：jti 一次性账本须保留到 exp + 容差窗口结束，封堵容差窗口内的重放。 */
const SSO_CLOCK_TOLERANCE_MS = SSO_CLOCK_TOLERANCE_SECONDS * 1000;
/** JWKS 缓存 TTL（毫秒）：轮换场景下最长 10 分钟后必然刷新。 */
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
/** JWKS 拉取超时（毫秒）：验签失败优于无限挂起。 */
const JWKS_FETCH_TIMEOUT_MS = 5000;
/** 未知 kid 强制刷新的全局节流：距上次成功拉取 <30s 不再出站（刚拉到的公钥集合不会立刻变化）。 */
const JWKS_FORCE_REFRESH_THROTTLE_MS = 30_000;
/** JWKS 响应体大小上限（字节）：content-length 超限视为异常响应，直接判失败。 */
const JWKS_MAX_BODY_BYTES = 64 * 1024;

/** 已消费 jti 的一次性账本：jti -> 过期时间戳（ms）。单实例内存 Map。 */
const usedSsoJtis = new Map<string, number>();

/** JWKS 模块级缓存：{keys, fetchedAt}，TTL 10 分钟；kid 未命中可强制刷新。 */
let jwksCache: { keys: jose.JWK[]; fetchedAt: number } | null = null;
/** 上次成功拉取 JWKS 的时间戳（ms）：未知 kid 强刷节流的依据。 */
let lastJwksFetchAt = 0;
/** 全局单飞：进行中的 JWKS 拉取共享同一 Promise，并发请求合并为一次出站。 */
let jwksFetchInFlight: Promise<{ keys: jose.JWK[]; fetchedAt: number }> | null = null;

/** 惰性清理已过期的 jti（协议要求"顺手清理过期项"）。 */
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

/**
 * 拉取天宫 JWKS（带缓存 + 全局单飞 + 响应体大小守卫）。
 * - force=false：TTL 内直接用缓存；
 * - force=true：跳过缓存强制刷新（未知 kid 轮换窗口用；节流判定在调用方 verifyEdDsaToken）。
 * - 单飞：任一时刻至多一次出站拉取，并发调用（含 force）共享同一 in-flight Promise，
 *   防缓存击穿把 TTL 到期瞬间放大成 N 次出站。
 * 网络失败 / 非 2xx / 响应体超限 / 结构不对 → 抛错（调用方转 401，绝不泄露内部细节）；
 * 失败不写缓存、不记成功时间戳，后续调用可重新出站。
 */
async function fetchJwks(force = false): Promise<{ keys: jose.JWK[]; fetchedAt: number }> {
  const url = env.tiangongJwksUrl;
  if (!url) throw new Error("JWKS URL 未配置");
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache;
  }
  if (jwksFetchInFlight) return jwksFetchInFlight;
  const task = (async (): Promise<{ keys: jose.JWK[]; fetchedAt: number }> => {
    const resp = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`JWKS 拉取失败: HTTP ${resp.status}`);
    // m-5 响应体守卫：content-length 超限视为异常（缺失该头时放行，交由解析兜底）
    const contentLength = Number(resp.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > JWKS_MAX_BODY_BYTES) {
      throw new Error(`JWKS 响应体超过 ${JWKS_MAX_BODY_BYTES} 字节上限`);
    }
    const body = (await resp.json()) as { keys?: jose.JWK[] };
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    jwksCache = { keys, fetchedAt: Date.now() };
    lastJwksFetchAt = jwksCache.fetchedAt;
    return jwksCache;
  })();
  jwksFetchInFlight = task;
  try {
    return await task;
  } finally {
    jwksFetchInFlight = null;
  }
}

/** 从 JWKS 里找可用的 Ed25519 公钥（按 kid 精确匹配） */
function findEd25519Jwk(keys: jose.JWK[], kid: string): jose.JWK | null {
  return keys.find((k) => k.kty === "OKP" && k.crv === "Ed25519" && k.kid === kid) ?? null;
}

/**
 * EdDSA 验签：JWKS 取公钥（未知 kid 强制刷新一次，带 30s 全局节流）→ jwtVerify。
 * 任何失败抛错，由调用方统一转 401。
 */
async function verifyEdDsaToken(token: string, kid: string): Promise<jose.JWTPayload> {
  let jwks = await fetchJwks();
  let jwk = findEd25519Jwk(jwks.keys, kid);
  if (!jwk && Date.now() - lastJwksFetchAt >= JWKS_FORCE_REFRESH_THROTTLE_MS) {
    // 未知 kid：可能是天宫刚轮换密钥而本端缓存已旧 → 强制刷新一次再找。
    // 但距上次成功拉取 <30s 时不再出站：刚拉到的集合不含该 kid，立刻重拉也不会含，
    // 直接用现有缓存判定（401），避免攻击者伪造随机 kid 打出站请求。
    jwks = await fetchJwks(true);
    jwk = findEd25519Jwk(jwks.keys, kid);
  }
  if (!jwk) throw new Error("JWKS 中无该 kid 的公钥");
  const key = await jose.importJWK(jwk, "EdDSA");
  const result = await jose.jwtVerify(token, key, {
    algorithms: ["EdDSA"],
    clockTolerance: SSO_CLOCK_TOLERANCE_SECONDS,
  });
  return result.payload;
}

/** HS256 验签（v1 兼容路径）：共享密钥存在才可用，逻辑与 v1 完全一致。 */
async function verifyHs256Token(token: string, secret: Uint8Array): Promise<jose.JWTPayload> {
  const result = await jose.jwtVerify(token, secret, {
    algorithms: ["HS256"],
    clockTolerance: SSO_CLOCK_TOLERANCE_SECONDS,
  });
  return result.payload;
}

export const ssoRouter = new Hono();

/** 测试辅助：重置 JWKS 缓存与节流时间戳（仅测试用，勿在业务代码调用） */
export function _resetSsoJwksCacheForTest(): void {
  jwksCache = null;
  lastJwksFetchAt = 0;
  jwksFetchInFlight = null;
}

/** 测试辅助：把"上次成功拉取"时间戳前移，模拟强刷节流窗口已过（仅测试用） */
export function _ageLastJwksFetchForTest(ms: number): void {
  lastJwksFetchAt -= ms;
}

// GET /sso/launch?token=<jwt>
ssoRouter.get("/launch", async (c) => {
  // 1. SSO 配置检查：无共享密钥且无 JWKS 来源 → 501（沿用 v1 "未配置" 语义）
  const secret = getSsoSecret();
  const jwksUrl = env.tiangongJwksUrl;
  if (!secret && !jwksUrl) {
    return c.json({ error: "SSO 未配置" }, 501);
  }

  // 2. token 存在性
  const token = c.req.query("token") ?? "";
  if (!token) {
    return c.json({ error: "凭证无效或已过期" }, 401);
  }

  // 3. 按 header.alg 分派验签（解析失败 → 401）
  let payload: jose.JWTPayload;
  try {
    const header = jose.decodeProtectedHeader(token);
    if (header.alg === "EdDSA") {
      // v2 主路径：无 kid 不接受（单一 JWKS key 简化下也不盲选）；拉取失败 → 401
      const kid = typeof header.kid === "string" && header.kid ? header.kid : "";
      if (!kid) return c.json({ error: "凭证无效或已过期" }, 401);
      payload = await verifyEdDsaToken(token, kid);
    } else if (header.alg === "HS256") {
      // v1 兼容路径：共享密钥存在才可用
      if (!secret) return c.json({ error: "凭证无效或已过期" }, 401);
      payload = await verifyHs256Token(token, secret);
    } else {
      return c.json({ error: "凭证无效或已过期" }, 401);
    }
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
