import * as crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SettingRow = {
  readonly value: string;
};

type UpdateValues = {
  readonly key?: string;
  readonly value: string;
  readonly category?: string;
  readonly updatedAt?: Date;
};

const dbState = vi.hoisted(() => ({
  persistedHash: null as string | null,
  storedHash: null as string | null,
  settings: {} as Record<string, string>,
}));

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    insert: () => ({
      values: async (values: UpdateValues): Promise<void> => {
        if (values.key) {
          dbState.settings[values.key] = values.value;
        }
        if (values.key === "admin_password_hash" || !values.key) {
          dbState.persistedHash = values.value;
          dbState.storedHash = values.value;
        }
      },
    }),
    select: () => ({
      from: () => ({
        where: async (key: string): Promise<readonly SettingRow[]> => {
          const value = dbState.settings[key] ?? null;
          return value ? [{ value }] : [];
        },
      }),
    }),
    update: () => ({
      set: (values: UpdateValues) => ({
        where: async (key: string): Promise<void> => {
          dbState.settings[key] = values.value;
          if (key === "admin_password_hash") {
            dbState.persistedHash = values.value;
            dbState.storedHash = values.value;
          }
        },
      }),
    }),
  }),
}));

vi.mock("@db/schema", () => ({
  systemSettings: {
    key: "key",
  },
}));

vi.mock("@contracts/constants", () => ({
  Session: {
    cookieName: "xuanji.sid",
    maxAgeMs: 86_400_000,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_column: unknown, value: string) => value,
}));

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "correct-password";
process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";

function createLegacyScryptHash(password: string): string {
  const salt = crypto.scryptSync(process.env.JWT_SECRET ?? "", "admin-salt", 64);
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

describe("local admin auth", () => {
  beforeEach(() => {
    dbState.persistedHash = null;
    dbState.storedHash = null;
    dbState.settings = {};
  });

  it("returns a bcrypt-style hash when hashing passwords", async () => {
    // Given: a fixed password string.
    const { hashPassword } = await import("./local-auth");

    // When: the password is hashed.
    const hash = await hashPassword("correct-password");

    // Then: the stored value uses the bcrypt prefix family.
    expect(hash.startsWith("$2")).toBe(true);
  });

  it("accepts a bcrypt stored hash and rejects a wrong password", async () => {
    // Given: the database stores a bcrypt hash for the admin password.
    const { hashPassword, verifyAdminCredentials } = await import("./local-auth");
    dbState.storedHash = await hashPassword("correct-password");

    // When: the correct and wrong passwords are checked.
    const correctResult = await verifyAdminCredentials("admin", "correct-password");
    const wrongResult = await verifyAdminCredentials("admin", "wrong-password");

    // Then: only the correct password is accepted.
    expect(correctResult).toBe(true);
    expect(wrongResult).toBe(false);
  });

  it("accepts a legacy scrypt hash and migrates it to bcrypt", async () => {
    // Given: the database stores the legacy 128-hex-character scrypt hash.
    const { verifyAdminCredentials } = await import("./local-auth");
    dbState.storedHash = createLegacyScryptHash("correct-password");

    // When: the matching password is verified.
    const result = await verifyAdminCredentials("admin", "correct-password");

    // Then: login succeeds and the stored hash is replaced with bcrypt.
    expect(result).toBe(true);
    expect(dbState.persistedHash?.startsWith("$2")).toBe(true);
    expect(dbState.persistedHash).not.toBe(createLegacyScryptHash("correct-password"));
  });

  it("rejects login attempts after five failures for the same IP and username", async () => {
    // Given: the database stores the correct bcrypt password for the admin user.
    const { hashPassword, verifyAdminCredentials } = await import("./local-auth");
    dbState.settings.admin_password_hash = await hashPassword("correct-password");

    // When: five wrong passwords are submitted from the same IP for the same username.
    for (const _attempt of [1, 2, 3, 4, 5]) {
      await verifyAdminCredentials("admin", "wrong-password", "203.0.113.10");
    }
    const lockedResult = await verifyAdminCredentials(
      "admin",
      "correct-password",
      "203.0.113.10",
    );
    const otherIpResult = await verifyAdminCredentials(
      "admin",
      "correct-password",
      "203.0.113.11",
    );

    // Then: the locked key is rejected generically, while another IP is unaffected.
    expect(lockedResult).toBe(false);
    expect(otherIpResult).toBe(true);
  });

  it("rejects local tokens issued before the admin password changed", async () => {
    // Given: an existing local token was issued before the stored password change timestamp.
    const { signLocalToken, verifyLocalToken } = await import("./local-auth");
    const token = await signLocalToken("admin");
    dbState.settings.admin_password_changed_at = new Date(Date.now() + 5_000).toISOString();

    // When: the old token is verified.
    const result = await verifyLocalToken(token);

    // Then: verification fails so old sessions are globally revoked.
    expect(result).toBeNull();
  });
});

describe("JWT secret environment policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("ADMIN_USERNAME", "admin");
    vi.stubEnv("ADMIN_PASSWORD", "correct-password");
    vi.stubEnv("DATABASE_URL", "mysql://user:password@example.test:3306/xuanji");
  });

  it("exits in production when JWT_SECRET is missing even if APP_SECRET is set", async () => {
    // Given: production starts without JWT_SECRET but with APP_SECRET.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_SECRET", "app-secret-must-not-be-used-as-jwt-secret");
    vi.stubEnv("JWT_SECRET", "");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as typeof process.exit);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // When: the env module is loaded.
    await expect(import("./lib/env")).rejects.toThrow("process.exit called");

    // Then: startup is stopped with a server-side error.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("JWT_SECRET"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("allows development to generate a random JWT secret with a warning", async () => {
    // Given: development starts without JWT_SECRET.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("JWT_SECRET", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // When: the env module is loaded.
    const { env } = await import("./lib/env");

    // Then: a strong transient secret is generated and the operator is warned.
    expect(env.jwtSecret).toHaveLength(64);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("JWT_SECRET"));
  });
});
