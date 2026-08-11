import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("mysql2/promise", () => ({
  createPool: vi.fn(),
}));

import { createPool } from "mysql2/promise";
import { exportDatabaseTables } from "./db-export";

const mockedCreatePool = vi.mocked(createPool);

interface FakeConn {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeFakePool(conn: FakeConn) {
  return {
    getConnection: vi.fn().mockResolvedValue(conn),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeConnection(rowsByTable: Record<string, unknown[]>) {
  const conn: FakeConn = { query: vi.fn(), release: vi.fn() };
  conn.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith("START TRANSACTION")) return [[], []];
    if (sql.includes("information_schema.tables")) {
      return [[{ TABLE_NAME: "users" }, { TABLE_NAME: "not_a_schema_table" }], []];
    }
    if (sql.includes("information_schema.columns")) return [[], []];
    if (sql.startsWith("SELECT * FROM `users`")) return [rowsByTable.users ?? [], []];
    if (sql === "COMMIT") return [[], []];
    if (sql === "ROLLBACK") return [[], []];
    return [[], []];
  });
  return conn;
}

describe("db-export", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-export-test-"));
  });

  it("builds a mysql2 pool from DATABASE_URL and exports whitelisted tables as schema JSON + NDJSON", async () => {
    const createdAt = new Date("2024-01-02T03:04:05.000Z");
    const conn = fakeConnection({ users: [{ id: 1, name: "alice", createdAt }] });
    mockedCreatePool.mockReturnValue(makeFakePool(conn) as never);

    const result = await exportDatabaseTables(outDir);

    expect(mockedCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "example.test",
        port: 3306,
        user: "user",
        password: "password",
        database: "xuanji",
      })
    );
    const queries = conn.query.mock.calls.map((c) => String(c[0]));
    expect(queries).toContain("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    expect(queries).toContain("COMMIT");
    expect(queries).not.toContain("ROLLBACK");
    // only schema tables survive the whitelist intersection
    expect(result.tables).toEqual(["users"]);
    expect(result.rows).toBe(1);

    const schemaFile = path.join(outDir, "users.schema.json");
    const ndjsonFile = path.join(outDir, "users.ndjson");
    expect(fs.existsSync(schemaFile)).toBe(true);
    expect(fs.existsSync(ndjsonFile)).toBe(true);

    const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8")) as { table: string };
    expect(schema.table).toBe("users");
    const lines = fs.readFileSync(ndjsonFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({ id: 1, name: "alice", createdAt: createdAt.toISOString() });
  });

  it("rolls back and rethrows when a table query fails", async () => {
    const conn: FakeConn = { query: vi.fn(), release: vi.fn() };
    conn.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("START TRANSACTION")) return [[], []];
      if (sql.includes("information_schema.tables")) return [[{ TABLE_NAME: "users" }], []];
      if (sql.includes("information_schema.columns")) return [[], []];
      if (sql.startsWith("SELECT * FROM")) throw new Error("table read failed");
      return [[], []];
    });
    mockedCreatePool.mockReturnValue(makeFakePool(conn) as never);

    await expect(exportDatabaseTables(outDir)).rejects.toThrow("table read failed");
    expect(conn.query.mock.calls.map((c) => String(c[0]))).toContain("ROLLBACK");
  });
});
