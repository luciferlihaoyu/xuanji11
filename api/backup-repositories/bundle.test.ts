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

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  createPool: vi.fn(),
}));

import { getDb } from "../queries/connection";
import { createPool } from "mysql2/promise";
import { buildBackupBundle, type BackupBundle } from "./bundle";

const mockedCreatePool = vi.mocked(createPool);

function fakeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => Promise.resolve([])),
    })),
  };
}

function fakePoolWithTable(table: string) {
  const conn = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("START TRANSACTION") || sql === "COMMIT" || sql === "ROLLBACK") return [[], []];
      if (sql.includes("information_schema.tables")) return [[{ TABLE_NAME: table }], []];
      if (sql.includes("information_schema.columns")) return [[], []];
      if (sql.startsWith("SELECT * FROM")) return [[], []];
      return [[], []];
    }),
    release: vi.fn(),
  };
  return {
    getConnection: vi.fn().mockResolvedValue(conn),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("buildBackupBundle", () => {
  let root: string;
  let uploadDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
    uploadDir = path.join(root, "uploads");
    fs.mkdirSync(path.join(uploadDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, "a.pdf"), "pdf-bytes");
    fs.writeFileSync(path.join(uploadDir, "nested", "b.png"), "png-bytes");
    vi.mocked(getDb).mockReturnValue(fakeDb() as never);
    mockedCreatePool.mockReturnValue(fakePoolWithTable("users") as never);
  });

  it("copies a plain source directory into staging with checksums", async () => {
    const source = path.join(root, "src");
    fs.mkdirSync(path.join(source, "sub"), { recursive: true });
    fs.writeFileSync(path.join(source, "one.txt"), "111");
    fs.writeFileSync(path.join(source, "sub", "two.txt"), "2222");

    const bundle: BackupBundle = await buildBackupBundle(7, source, { stagingRoot: root });

    expect(bundle.files.map((f) => f.path).sort()).toEqual(["one.txt", "sub/two.txt"]);
    const staging = path.join(root, "staging-7");
    expect(fs.readFileSync(path.join(staging, "one.txt"), "utf8")).toBe("111");
    expect(fs.readFileSync(path.join(staging, "sub", "two.txt"), "utf8")).toBe("2222");
    expect(bundle.files.find((f) => f.path === "one.txt")?.checksum).toHaveLength(64);
  });

  it("assembles database/, knowledge/ and attachments/ for the bundle source", async () => {
    const bundle: BackupBundle = await buildBackupBundle(9, "bundle", {
      stagingRoot: root,
      uploadDir,
    });

    const staging = path.join(root, "staging-9");
    expect(fs.existsSync(path.join(staging, "database", "users.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(staging, "database", "users.schema.json"))).toBe(true);
    expect(fs.existsSync(path.join(staging, "knowledge", "knowledge-base.json"))).toBe(true);
    expect(fs.readFileSync(path.join(staging, "attachments", "a.pdf"), "utf8")).toBe("pdf-bytes");
    expect(fs.readFileSync(path.join(staging, "attachments", "nested", "b.png"), "utf8")).toBe("png-bytes");

    const expectedPaths = [
      "attachments/a.pdf",
      "attachments/nested/b.png",
      "database/users.ndjson",
      "database/users.schema.json",
      "knowledge/knowledge-base.json",
    ];
    expect(bundle.files.map((f) => f.path).sort()).toEqual(expectedPaths);
  });

  it("writes a manifest.json with schema metadata and the file list", async () => {
    const source = path.join(root, "src2");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "f.txt"), "content");

    const bundle: BackupBundle = await buildBackupBundle(11, source, { stagingRoot: root, target: "alist", encrypted: true });

    const manifest = JSON.parse(fs.readFileSync(path.join(root, "staging-11", "manifest.json"), "utf8")) as {
      schemaVersion: number;
      jobId: number;
      target: string;
      createdAt: string;
      encrypted: boolean;
      encryptionVersion?: number;
      files: Array<{ path: string; size: number; checksum: string }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.jobId).toBe(11);
    expect(manifest.target).toBe("alist");
    expect(manifest.encrypted).toBe(true);
    expect(manifest.encryptionVersion).toBe(1);
    expect(new Date(manifest.createdAt).getTime()).toBeGreaterThan(0);
    expect(manifest.files).toEqual([
      { path: "f.txt", size: 7, checksum: bundle.files[0]?.checksum },
    ]);
  });

  it("does not mark the manifest encrypted when encryption is off", async () => {
    const source = path.join(root, "src3");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "f.txt"), "content");

    const bundle: BackupBundle = await buildBackupBundle(13, source, { stagingRoot: root, target: "nas" });

    const manifest = JSON.parse(fs.readFileSync(path.join(root, "staging-13", "manifest.json"), "utf8")) as {
      encrypted: boolean;
      encryptionVersion?: number;
    };
    expect(manifest.encrypted).toBe(false);
    expect(manifest.encryptionVersion).toBeUndefined();
    expect(bundle.manifest.files.length).toBe(1);
  });
});
