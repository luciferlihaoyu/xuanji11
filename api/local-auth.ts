/**
 * Local admin authentication module
 * Replaces Kimi OAuth with env-based admin login
 */
import * as jose from "jose";
import * as cookie from "cookie";
import * as crypto from "crypto";
import bcrypt from "bcrypt";
import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { systemSettings } from "@db/schema";
import { eq } from "drizzle-orm";
import { env } from "./lib/env";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import type { User } from "@db/schema";

const JWT_ALG = "HS256";
const LOCAL_ADMIN_UNION_ID = "local_admin";
const BCRYPT_SALT_ROUNDS = 10;
const LEGACY_SCRYPT_HASH_PATTERN = /^[a-f0-9]{128}$/i;
const LOCAL_TOKEN_EXPIRES_IN = `${Math.floor(Session.maxAgeMs / 1000)}s`;

function getSecret() {
  return new TextEncoder().encode(env.jwtSecret);
}

let adminPasswordHash: string | null = null;

async function getStoredAdminPasswordHash(): Promise<string | null> {
  try {
    const db = getDb();
    const results = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "admin_password_hash"));
    if (results.length > 0 && results[0].value) {
      return results[0].value;
    }
  } catch {
    // 数据库查询失败，回退到环境变量
  }
  return null;
}

async function persistAdminPasswordHash(hash: string): Promise<void> {
  const db = getDb();
  const existing = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "admin_password_hash"));

  if (existing.length > 0) {
    await db
      .update(systemSettings)
      .set({ value: hash, updatedAt: new Date() })
      .where(eq(systemSettings.key, "admin_password_hash"));
    return;
  }

  await db.insert(systemSettings).values({
    key: "admin_password_hash",
    value: hash,
    category: "security",
  });
}

function getEnvAdminPasswordHash(): string {
  if (!adminPasswordHash) {
    const salt = crypto.scryptSync(env.jwtSecret, "admin-salt", 64);
    adminPasswordHash = crypto
      .scryptSync(env.adminPassword, salt, 64)
      .toString("hex");
  }
  return adminPasswordHash;
}

function isLegacyScryptHash(hash: string): boolean {
  return !hash.startsWith("$2") && LEGACY_SCRYPT_HASH_PATTERN.test(hash);
}

function verifyLegacyScryptPassword(password: string, hash: string): boolean {
  if (!isLegacyScryptHash(hash)) return false;

  const salt = crypto.scryptSync(env.jwtSecret, "admin-salt", 64);
  const inputHash = crypto.scryptSync(password, salt, 64);
  const storedHash = Buffer.from(hash, "hex");
  return crypto.timingSafeEqual(inputHash, storedHash);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

export async function verifyAdminCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  if (username !== env.adminUsername) return false;
  try {
    // 优先检查 system_settings 表中的密码
    const storedHash = await getStoredAdminPasswordHash();
    if (storedHash) {
      if (storedHash.startsWith("$2")) {
        return bcrypt.compare(password, storedHash);
      }

      const legacyValid = verifyLegacyScryptPassword(password, storedHash);
      if (!legacyValid) return false;

      await persistAdminPasswordHash(await hashPassword(password));
      return true;
    }

    // 回退到环境变量密码
    const envHash = getEnvAdminPasswordHash();
    const legacyValid = verifyLegacyScryptPassword(password, envHash);
    if (!legacyValid) return false;

    await persistAdminPasswordHash(await hashPassword(password));
    return true;
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
    .setExpirationTime(LOCAL_TOKEN_EXPIRES_IN)
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
