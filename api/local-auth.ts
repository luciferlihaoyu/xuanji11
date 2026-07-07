/**
 * Local admin authentication module
 * Replaces Kimi OAuth with env-based admin login
 */
import * as jose from "jose";
import * as cookie from "cookie";
import * as crypto from "crypto";
import bcrypt from "bcryptjs";
import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { systemSettings } from "@db/schema";
import { eq } from "drizzle-orm";
import { env } from "./lib/env";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import type { User } from "@db/schema";
import {
  clearLoginFailures,
  createLoginAttempt,
  isLoginLocked,
  recordLoginFailure,
} from "./login-rate-limit";

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

async function getAdminPasswordChangedAt(): Promise<Date | null> {
  const db = getDb();
  const results = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "admin_password_changed_at"));
  if (results.length === 0 || !results[0].value) return null;

  const changedAt = new Date(results[0].value);
  return Number.isNaN(changedAt.getTime()) ? null : changedAt;
}

async function persistSystemSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, key));

  if (existing.length > 0) {
    await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, key));
    return;
  }

  await db.insert(systemSettings).values({ key, value, category: "security" });
}

async function persistAdminPasswordHash(hash: string): Promise<void> {
  await persistSystemSetting("admin_password_hash", hash);
}

export async function persistAdminPasswordChangedAt(changedAt: Date): Promise<void> {
  await persistSystemSetting("admin_password_changed_at", changedAt.toISOString());
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
  clientIp = "unknown",
): Promise<boolean> {
  const loginAttempt = createLoginAttempt(username, clientIp);
  const now = Date.now();
  if (isLoginLocked(loginAttempt, now)) {
    console.warn(`[Local Auth] Rejected locked login for ${clientIp}::${username}`);
    return false;
  }

  if (username !== env.adminUsername) {
    recordLoginFailure(loginAttempt, now);
    return false;
  }
  try {
    // 优先检查 system_settings 表中的密码
    const storedHash = await getStoredAdminPasswordHash();
    if (storedHash) {
      if (storedHash.startsWith("$2")) {
        const valid = await bcrypt.compare(password, storedHash);
        if (valid) clearLoginFailures(loginAttempt);
        else recordLoginFailure(loginAttempt, now);
        return valid;
      }

      const legacyValid = verifyLegacyScryptPassword(password, storedHash);
      if (!legacyValid) {
        recordLoginFailure(loginAttempt, now);
        return false;
      }

      await persistAdminPasswordHash(await hashPassword(password));
      clearLoginFailures(loginAttempt);
      return true;
    }

    // 回退到环境变量密码
    const envHash = getEnvAdminPasswordHash();
    const legacyValid = verifyLegacyScryptPassword(password, envHash);
    if (!legacyValid) {
      recordLoginFailure(loginAttempt, now);
      return false;
    }

    await persistAdminPasswordHash(await hashPassword(password));
    clearLoginFailures(loginAttempt);
    return true;
  } catch {
    recordLoginFailure(loginAttempt, now);
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
    .setJti(crypto.randomUUID())
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
    if (payload.type !== "local" || typeof payload.username !== "string" || typeof payload.iat !== "number") {
      return null;
    }

    const passwordChangedAt = await getAdminPasswordChangedAt();
    if (passwordChangedAt && payload.iat * 1000 + 999 < passwordChangedAt.getTime()) {
      return null;
    }

    return { username: payload.username };
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
      if (!isTrustedMutationRequest(c.req.raw)) {
        return c.json({ error: "Invalid request" }, 403);
      }

      const body = await c.req.json();
      const { username, password } = body;

      if (!username || !password) {
        return c.json({ error: "Login required" }, 400);
      }

      const valid = await verifyAdminCredentials(username, password, getClientIp(c.req.raw.headers));
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

export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || headers.get("x-real-ip") || "unknown";
}

export function isTrustedMutationRequest(req: Request): boolean {
  if (req.headers.get("x-requested-with") === "XMLHttpRequest") return true;

  const origin = req.headers.get("origin");
  return Boolean(origin && origin === new URL(req.url).origin);
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
