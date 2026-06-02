/**
 * 本地管理员认证模块
 * 替代 Kimi OAuth，通过环境变量配置的管理员账号密码登录
 */
import * as jose from "jose";
import * as cookie from "cookie";
import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import { env } from "./lib/env";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import type { User } from "@db/schema";

const JWT_ALG = "HS256";
const LOCAL_ADMIN_UNION_ID = "local_admin";

function getSecret() {
  return new TextEncoder().encode(env.jwtSecret);
}

/** 验证管理员账号密码 */
export async function verifyAdminCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  return username === env.adminUsername && password === env.adminPassword;
}

/** 签发本地认证 JWT */
export async function signLocalToken(username: string): Promise<string> {
  return new jose.SignJWT({
    username,
    type: "local",
    unionId: LOCAL_ADMIN_UNION_ID,
  })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
}

/** 验证本地认证 JWT */
export async function verifyLocalToken(
  token: string,
): Promise<{ username: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jose.jwtVerify(token, getSecret(), {
      algorithms: [JWT_ALG],
      clockTolerance: 60,
    });
    if (payload.type !== "local" || !payload.username) return null;
    return { username: payload.username as string };
  } catch {
    return null;
  }
}

/** 从请求头/Cookie中解析本地认证 */
export async function authenticateLocalRequest(
  headers: Headers,
): Promise<User | undefined> {
  const cookies = cookie.parse(headers.get("cookie") || "");
  const token = cookies[Session.cookieName];
  if (!token) return undefined;

  const claim = await verifyLocalToken(token);
  if (!claim) return undefined;

  // 构建一个符合 User 类型的虚拟用户
  const user: User = {
    id: 1,
    unionId: LOCAL_ADMIN_UNION_ID,
    name: claim.username,
    email: null,
    avatar: null,
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignInAt: new Date(),
  };

  return user;
}

/** 创建本地登录处理函数 */
export function createLocalLoginHandler() {
  return async (c: Context) => {
    try {
      const body = await c.req.json();
      const { username, password } = body;

      if (!username || !password) {
        return c.json({ error: "账号和密码不能为空" }, 400);
      }

      const valid = await verifyAdminCredentials(username, password);
      if (!valid) {
        return c.json({ error: "账号或密码错误" }, 401);
      }

      const token = await signLocalToken(username);
      const cookieOpts = getSessionCookieOptions(c.req.raw.headers);
      setCookie(c, Session.cookieName, token, {
        ...cookieOpts,
        maxAge: Session.maxAgeMs / 1000,
      });

      return c.json({ success: true, name: username });
    } catch (err) {
      console.error("[Local Auth] Login failed:", err);
      return c.json({ error: "登录失败" }, 500);
    }
  };
}

/** 创建登出处理函数 */
export function createLocalLogoutHandler() {
  return async (c: Context) => {
    const cookieOpts = getSessionCookieOptions(c.req.raw.headers);
    setCookie(c, Session.cookieName, "", {
      ...cookieOpts,
      maxAge: 0,
    });
    return c.json({ success: true });
  };
}
