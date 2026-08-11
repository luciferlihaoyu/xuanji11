/**
 * 备份包组装（staging 目录）
 *
 * 在 `env.backupTempDir/staging-<jobId>` 下组装备份内容：
 * - sourcePath 为 "bundle"：database/（db-export）+ knowledge/（kb-backup）+ attachments/（uploadDir）
 * - sourcePath 为普通目录：按相对路径复制目录内容
 * 最后写入 manifest.json（含文件清单与 checksum、加密标记）。
 * 上传顺序由执行层负责（manifest.json 最后上传）。
 */
import * as path from "path";
import { promises as fsp } from "fs";
import { createHash } from "crypto";
import { env } from "../lib/env";
import { sanitizeRelativePath } from "../lib/backup-path";
import { exportKnowledgeBase } from "../lib/kb-backup";
import { exportDatabaseTables } from "./db-export";

export interface BackupBundleFile {
  readonly path: string;
  readonly size: number;
  readonly checksum: string;
}

export interface BackupManifest {
  readonly schemaVersion: number;
  readonly jobId: number;
  readonly target: string;
  readonly createdAt: string;
  readonly encrypted: boolean;
  readonly encryptionVersion?: number;
  readonly files: readonly BackupBundleFile[];
}

export interface BackupBundle {
  readonly stagingDir: string;
  readonly files: readonly BackupBundleFile[];
  readonly manifest: BackupManifest;
}

export interface BundleOptions {
  readonly stagingRoot?: string;
  readonly uploadDir?: string;
  readonly target?: string;
  readonly encrypted?: boolean;
}

async function walkStagingFiles(dir: string): Promise<BackupBundleFile[]> {
  const files: BackupBundleFile[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(fullPath);
        const content = await fsp.readFile(fullPath);
        files.push({
          path: sanitizeRelativePath(path.relative(dir, fullPath)),
          size: stat.size,
          checksum: createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  }
  await walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function copyTree(srcDir: string, destDir: string): Promise<void> {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

async function assembleContent(stagingDir: string, sourcePath: string, uploadDir: string): Promise<void> {
  if (sourcePath === "bundle") {
    await exportDatabaseTables(path.join(stagingDir, "database"));

    const knowledgeDir = path.join(stagingDir, "knowledge");
    await fsp.mkdir(knowledgeDir, { recursive: true });
    const kb = await exportKnowledgeBase();
    await fsp.writeFile(path.join(knowledgeDir, "knowledge-base.json"), JSON.stringify(kb, null, 2));

    await copyTree(uploadDir, path.join(stagingDir, "attachments"));
    return;
  }
  await copyTree(sourcePath, stagingDir);
}

export async function buildBackupBundle(
  jobId: number,
  sourcePath: string,
  options: BundleOptions = {}
): Promise<BackupBundle> {
  const stagingDir = path.join(options.stagingRoot ?? env.backupTempDir, `staging-${jobId}`);
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });

  await assembleContent(stagingDir, sourcePath, options.uploadDir ?? env.uploadDir);

  const files = await walkStagingFiles(stagingDir);
  const encrypted = options.encrypted ?? false;
  const manifest: BackupManifest = {
    schemaVersion: 1,
    jobId,
    target: options.target ?? "bundle",
    createdAt: new Date().toISOString(),
    encrypted,
    ...(encrypted ? { encryptionVersion: 1 } : {}),
    files,
  };
  await fsp.writeFile(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return { stagingDir, files, manifest };
}
