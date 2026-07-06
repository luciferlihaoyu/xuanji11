import * as crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SettingRow = {
  readonly value: string;
};

type UpdateValues = {
  readonly value: string;
};

const dbState = vi.hoisted(() => ({
  persistedHash: null as string | null,
  storedHash: null as string | null,
}));

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    insert: () => ({
      values: async (values: UpdateValues): Promise<void> => {
        dbState.persistedHash = values.value;
        dbState.storedHash = values.value;
      },
    }),
    select: () => ({
      from: () => ({
        where: async (): Promise<readonly SettingRow[]> =>
          dbState.storedHash ? [{ value: dbState.storedHash }] : [],
      }),
    }),
    update: () => ({
      set: (values: UpdateValues) => ({
        where: async (): Promise<void> => {
          dbState.persistedHash = values.value;
          dbState.storedHash = values.value;
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
  eq: () => true,
}));

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "correct-password";
process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
process.env.JWT_SECRET = "fixed-test-jwt-secret";

function createLegacyScryptHash(password: string): string {
  const salt = crypto.scryptSync(process.env.JWT_SECRET ?? "", "admin-salt", 64);
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

describe("local admin auth", () => {
  beforeEach(() => {
    dbState.persistedHash = null;
    dbState.storedHash = null;
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
});
