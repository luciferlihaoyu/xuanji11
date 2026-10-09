import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

import { buildBackupBundle, type BackupBundle } from "./bundle";

describe("buildBackupBundle", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
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
    // 流式 checksum 与一次性计算结果一致
    expect(bundle.files.find((f) => f.path === "one.txt")?.checksum).toBe(
      createHash("sha256").update("111").digest("hex")
    );
    expect(bundle.files.find((f) => f.path === "sub/two.txt")?.checksum).toBe(
      createHash("sha256").update("2222").digest("hex")
    );
  });

  it("computes large-file checksums in streaming mode without loading the file into memory", async () => {
    const source = path.join(root, "big-src");
    fs.mkdirSync(source, { recursive: true });
    const bigFile = path.join(source, "big.bin");
    // 50MB：写入固定模式的块，期望 checksum 可独立复算
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const expected = createHash("sha256");
    const fd = fs.openSync(bigFile, "w");
    try {
      for (let i = 0; i < 50; i++) {
        fs.writeSync(fd, chunk);
        expected.update(chunk);
      }
    } finally {
      fs.closeSync(fd);
    }

    const before = process.memoryUsage().heapUsed;
    const bundle = await buildBackupBundle(21, source, { stagingRoot: root });
    const after = process.memoryUsage().heapUsed;

    const big = bundle.files.find((f) => f.path === "big.bin");
    expect(big?.size).toBe(50 * 1024 * 1024);
    expect(big?.checksum).toBe(expected.digest("hex"));
    // 若实现退化为 readFile 整读，heap 增量至少 50MB；流式分块远小于该值
    expect(after - before).toBeLessThan(32 * 1024 * 1024);
  }, 60_000);

  it("no longer special-cases the legacy bundle alias — it fails like any missing directory", async () => {
    // db-export（MySQL 遗物）删除后，sourcePath 必须是真实目录；
    // 遗留 DB 行中的 "bundle" 会以 readdir ENOENT 明确失败，而不是静默产空备份
    await expect(buildBackupBundle(23, "bundle", { stagingRoot: root })).rejects.toThrow();
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
