/**
 * Local admin authentication module
 * Replaces Kimi OAuth with env-based admin login
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

export async function authenticateLocalRequest(
  headers: Headers,
): Promise<User | undefined> {
  const cookies = cookie.parse(headers.get("cookie") || "");
  const token = cookies[Session.cookieName];
  if (!token) return undefined;

  const claim = await verifyLocalToken(token);
  if (!claim) return undefined;

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

export function createLocalLoginHandler() {
  return async (c: Context) => {
    try {
      const body = await c.req.json();
      const { username, password } = body;

      if (!username || !password) {
        return c.json({ error: "Login required" }, 400);
      }

      const valid = await verifyAdminCredentials(username, password);
      if (!valid) {
        return c.json({ error: "Invalid credentials" }, 401);
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
      return c.json({ error: "Login failed" }, 500);
    }
  };
}

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
