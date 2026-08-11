/**
 * 备份执行共享工具：checksum 与目录遍历。
 */
import * as path from "path";
import { promises as fsp } from "fs";
import { createHash } from "crypto";

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function* walkDir(dir: string): AsyncGenerator<{ relativePath: string; fullPath: string; size: number }> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(dir, fullPath);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(fullPath);
      yield { relativePath, fullPath, size: stat.size };
    }
  }
}
