/**
 * local / nas 备份仓库
 *
 * - local：备份到 backupTempDir 下的独立目录，目录归属由调用方传 config.basePath
 * - nas：config.path 作为根目录（复用 backup-path 的安全校验）
 * 两者语义从 connectors/nas.ts 迁移，但 connectors/nas.ts 本身保持不变。
 */
import { promises as fsp } from "fs";
import * as path from "path";
import { sanitizeRelativePath } from "../lib/backup-path";
import type { BackupRepository } from "./base";

function resolveRoot(config: Record<string, unknown>): string {
  const base = config.basePath ?? config.path;
  if (typeof base !== "string" || base.length === 0) {
    throw new Error("缺少路径配置 (basePath/path)");
  }
  return path.resolve(base);
}

async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      results.push(path.relative(dir, fullPath));
    }
  }
  return results;
}

function makeLocalLikeRepository(name: string, rootKey: "basePath" | "path"): BackupRepository {
  return {
    name,

    async testConnection(config: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
      const root = rootKey === "basePath" ? (config.basePath as string | undefined) : (config.path as string | undefined);
      if (!root) {
        return { success: false, message: rootKey === "basePath" ? "缺少路径配置 (basePath)" : "缺少路径配置 (path)" };
      }
      try {
        await fsp.access(root);
        return { success: true, message: `路径可访问: ${root}` };
      } catch {
        return { success: false, message: `路径不可访问: ${root}` };
      }
    },

    async ensureBasePath(config: Record<string, unknown>): Promise<void> {
      await fsp.mkdir(resolveRoot(config), { recursive: true });
    },

    async uploadFile(config: Record<string, unknown>, remoteRelPath: string, content: Buffer): Promise<void> {
      const root = resolveRoot(config);
      const safePath = sanitizeRelativePath(remoteRelPath);
      const dest = path.join(root, safePath);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, content);
    },

    async readFile(config: Record<string, unknown>, remoteRelPath: string): Promise<Buffer | null> {
      const root = resolveRoot(config);
      const safePath = sanitizeRelativePath(remoteRelPath);
      const filePath = path.join(root, safePath);
      try {
        return await fsp.readFile(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async deleteFile(config: Record<string, unknown>, remoteRelPath: string): Promise<void> {
      const root = resolveRoot(config);
      const safePath = sanitizeRelativePath(remoteRelPath);
      await fsp.rm(path.join(root, safePath), { force: true });
    },

    async listFiles(config: Record<string, unknown>, remoteRelPath?: string): Promise<string[]> {
      const root = resolveRoot(config);
      const base = remoteRelPath ? path.join(root, sanitizeRelativePath(remoteRelPath)) : root;
      return walkFiles(base);
    },
  };
}

export const localRepository: BackupRepository = makeLocalLikeRepository("本地目录", "basePath");
export const nasRepository: BackupRepository = makeLocalLikeRepository("NAS / 本地存储", "path");
