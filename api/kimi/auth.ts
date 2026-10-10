import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import * as jose from "jose";
import * as cookie from "cookie";
import { env } from "../lib/env";
import { getSessionCookieOptions } from "../lib/cookies";
import { Session } from "@contracts/constants";
import { Errors } from "@contracts/errors";
import { signSessionToken, verifySessionToken } from "./session";
import { users as kimiUsers } from "./platform";
import { findUserByUnionId, upsertUser } from "../queries/users";
import { consumeOAuthState } from "../lib/oauth-state";
import { Paths } from "@contracts/constants";
import type { TokenResponse } from "./types";

async function exchangeAuthCode(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.appId,
    redirect_uri: redirectUri,
    client_secret: env.appSecret,
  });

  const resp = await fetch(`${env.kimiAuthUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  return resp.json() as Promise<TokenResponse>;
}

const jwks = jose.createRemoteJWKSet(
  new URL(`${env.kimiAuthUrl}/api/.well-known/jwks.json`),
);

async function verifyAccessToken(
  accessToken: string,
): Promise<{ userId: string; clientId: string }> {
  const { payload } = await jose.jwtVerify(accessToken, jwks);
  const userId = payload.user_id as string;
  const clientId = payload.client_id as string;
  if (!userId) {
    throw new Error("user_id missing from access token");
  }
  // t4/H4：access token 必须是签发给本应用（APP_ID）的，拒绝他应用/伪造 client_id
  if (clientId !== env.appId) {
    throw new Error("client_id mismatch");
  }
  return { userId, clientId };
}

export async function authenticateRequest(headers: Headers) {
  const cookies = cookie.parse(headers.get("cookie") || "");
  const token = cookies[Session.cookieName];
  if (!token) {
    console.warn("[auth] No session cookie found in request.");
    throw Errors.forbidden("Invalid authentication token.");
  }
  const claim = await verifySessionToken(token);
  if (!claim) {
    throw Errors.forbidden("Invalid authentication token.");
  }
  const user = await findUserByUnionId(claim.unionId);
  if (!user) {
    throw Errors.forbidden("User not found. Please re-login.");
  }
  return user;
}

import { getTrustedForwardedHost } from "../lib/trusted-host";

/**
 * t4/H4：redirectUri 与 state 解耦，取固定可信来源。
 * 优先级：env.KIMI_REDIRECT_URI（部署显式配置）> TRUSTED_FORWARDED_HOSTS 白名单
 * 命中 XFF > 请求 URL 推算。
 * 历史实现把 redirectUri base64 编码进 state（atob(state)），等于让攻击者任意指定。
 * XFF 不在白名单时 getTrustedForwardedHost 返回 null，落到 URL origin 兜底——
 * "宁失 header 不被伪造劫持"。
 */
function resolveRedirectUri(c: Context): string {
  if (env.kimiRedirectUri) return env.kimiRedirectUri;
  const headers = c.req.raw.headers;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = getTrustedForwardedHost(c.req.raw);
  if (host) return `${proto || "https"}://${host}${Paths.oauthCallback}`;
  try {
    return new URL(c.req.url).origin + Paths.oauthCallback;
  } catch {
    return "";
  }
}

export function createOAuthCallbackHandler() {
  return async (c: Context) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const errorDescription = c.req.query("error_description");

    if (error) {
      if (error === "access_denied") {
        return c.redirect("/", 302);
      }
      return c.json(
        { error, error_description: errorDescription },
        400,
      );
    }

    if (!code || !state) {
      return c.json({ error: "code and state are required" }, 400);
    }

    // t4/H4：state 必须是本服务签发且未消费过的一次性值（防 CSRF/伪造回调/重放）
    if (!consumeOAuthState(state)) {
      return c.json({ error: "invalid state" }, 400);
    }

    try {
      const redirectUri = resolveRedirectUri(c);
      const tokenResp = await exchangeAuthCode(code, redirectUri);
      const { userId } = await verifyAccessToken(tokenResp.access_token);
      const userProfile = await kimiUsers.getProfile(tokenResp.access_token);
      if (!userProfile) {
        throw new Error("Failed to fetch user profile from Kimi Open");
      }

      await upsertUser({
        unionId: userId,
        name: userProfile.name,
        avatar: userProfile.avatar_url,
        lastSignInAt: new Date(),
      });

      const token = await signSessionToken({
        unionId: userId,
        clientId: env.appId,
      });

      const cookieOpts = getSessionCookieOptions(c.req.raw.headers);
      setCookie(c, Session.cookieName, token, {
        ...cookieOpts,
        maxAge: Session.maxAgeMs / 1000,
      });

      return c.redirect("/", 302);
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      return c.json({ error: "OAuth callback failed" }, 500);
    }
  };
}

export { exchangeAuthCode, verifyAccessToken };
