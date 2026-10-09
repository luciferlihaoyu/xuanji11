/**
 * 备份包组装（staging 目录）
 *
 * 在 `env.backupTempDir/staging-<jobId>` 下按相对路径复制 sourcePath 目录内容，
 * 最后写入 manifest.json（含文件清单与 checksum、加密标记）。
 * 文件 checksum 以流式方式计算（createReadStream 分块喂 hash），大文件不整读入内存。
 * 上传顺序由执行层负责（manifest.json 最后上传）。
 */
import * as path from "path";
import { createReadStream, promises as fsp } from "fs";
import { createHash } from "crypto";
import { env } from "../lib/env";
import { sanitizeRelativePath } from "../lib/backup-path";

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
        // 流式 sha256：分块喂 hash，避免大文件整读入内存（OOM 风险）
        const hash = createHash("sha256");
        const stream = createReadStream(fullPath);
        for await (const chunk of stream) hash.update(chunk);
        files.push({
          path: sanitizeRelativePath(path.relative(dir, fullPath)),
          size: stat.size,
          checksum: hash.digest("hex"),
        });
      }
    }
  }
  await walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function copyTree(
  srcDir: string,
  destDir: string,
  excludeDirs: ReadonlySet<string> = new Set(),
  excludeNames: ReadonlySet<string> = new Set()
): Promise<void> {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      // 排除备份暂存区（默认 /data/app/backups），防止把 staging 目录复制进自身
      if (excludeDirs.has(path.resolve(srcPath))) continue;
      // 排除派生数据目录（如 zvec 向量索引，可由重建索引再生，单份 1.8GB）
      if (excludeNames.has(entry.name)) continue;
      await copyTree(srcPath, destPath, excludeDirs, excludeNames);
    } else if (entry.isFile()) {
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

async function assembleContent(stagingDir: string, sourcePath: string): Promise<void> {
  // 排除所有备份暂存根目录（含历史 staging-N），避免递归自吞
  const excludeDirs = new Set<string>([
    path.resolve(env.backupTempDir),
    path.resolve(stagingDir),
  ]);
  // zvec：旧向量引擎遗留目录，属派生数据（向量已在 SQLite 中），备它等于每份白传 1.8GB
  const excludeNames = new Set<string>(["zvec"]);
  await copyTree(sourcePath, stagingDir, excludeDirs, excludeNames);
}

export async function buildBackupBundle(
  jobId: number,
  sourcePath: string,
  options: BundleOptions = {}
): Promise<BackupBundle> {
  const stagingDir = path.join(options.stagingRoot ?? env.backupTempDir, `staging-${jobId}`);
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });

  await assembleContent(stagingDir, sourcePath);

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
