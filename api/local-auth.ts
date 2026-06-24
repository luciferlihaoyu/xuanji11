/**
 * 鏈湴绠＄悊鍛樿璇佹ā鍧? * 鏇夸唬 Kimi OAuth锛岄€氳繃鐜鍙橀噺閰嶇疆鐨勭鐞嗗憳璐﹀彿瀵嗙爜鐧诲綍
 */
import * as jose from "jose";
import * as cookie from "cookie";
import * as crypto from "crypto";
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

let adminPasswordHash: Buffer | null = null;

function getAdminPasswordHash(): Buffer {
  if (!adminPasswordHash) {
    const salt = crypto.scryptSync(env.jwtSecret, "admin-salt", 64);
    adminPasswordHash = crypto.scryptSync(env.adminPassword, salt, 64);
  }
  return adminPasswordHash;
}

/** 楠岃瘉绠＄悊鍛樿处鍙峰瘑鐮?*/
export async function verifyAdminCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  if (username !== env.adminUsername) return false;
  try {
    const salt = crypto.scryptSync(env.jwtSecret, "admin-salt", 64);
    const inputHash = crypto.scryptSync(password, salt, 64);
    const storedHash = getAdminPasswordHash();
    return crypto.timingSafeEqual(inputHash, storedHash);
  } catch {
    return false;
  }
}

/** 绛惧彂鏈湴璁よ瘉 JWT */
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

/** 楠岃瘉鏈湴璁よ瘉 JWT */
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

/** 浠庤姹傚ご/Cookie涓В鏋愭湰鍦拌璇?*/
export async function authenticateLocalRequest(
  headers: Headers,
): Promise<User | undefined> {
  const cookies = cookie.parse(headers.get("cookie") || "");
  const token = cookies[Session.cookieName];
  if (!token) return undefined;

  const claim = await verifyLocalToken(token);
  if (!claim) return undefined;

  // 鏋勫缓涓€涓鍚?User 绫诲瀷鐨勮櫄鎷熺敤鎴?  const user: User = {
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

/** 鍒涘缓鏈湴鐧诲綍澶勭悊鍑芥暟 */
export function createLocalLoginHandler() {
  return async (c: Context) => {
    try {
      const body = await c.req.json();
      const { username, password } = body;

      if (!username || !password) {
        return c.json({ error: "璐﹀彿鍜屽瘑鐮佷笉鑳戒负绌? }, 400);
      }

      const valid = await verifyAdminCredentials(username, password);
      if (!valid) {
        return c.json({ error: "璐﹀彿鎴栧瘑鐮侀敊璇? }, 401);
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
      return c.json({ error: "鐧诲綍澶辫触" }, 500);
    }
  };
}

/** 鍒涘缓鐧诲嚭澶勭悊鍑芥暟 */
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
