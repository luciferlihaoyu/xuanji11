/**
 * Backup / restore path safety helpers
 *
 * Goal: prevent path traversal from user-controlled backup sourcePath / targetPath
 * and from relative paths stored in backup manifests.
 */
import * as path from "path";

const MAX_PATH_LEN = 500;

function segments(p: string): string[] {
  // Split on both POSIX and Windows separators so mixed paths are also checked.
  return p.split(/[/\\]/).filter((s) => s.length > 0);
}

/** Return true if the path contains a traversal segment, a NUL byte, or is too long. */
export function hasPathTraversal(p: string): boolean {
  if (!p || p.length > MAX_PATH_LEN) return true;
  if (p.includes("\0")) return true;
  return segments(p).some((segment) => segment === "..");
}

/** Validate a relative path inside a backup archive and normalize it. */
export function sanitizeRelativePath(p: string): string {
  if (hasPathTraversal(p)) {
    throw new Error(`Invalid backup relative path: ${p}`);
  }
  const normalized = path.normalize(p);
  if (path.isAbsolute(normalized)) {
    throw new Error(`Backup relative path must be relative: ${p}`);
  }
  return normalized;
}

/** Resolve a restore destination and confirm it stays inside the target directory. */
export function resolveRestoreDestPath(targetPath: string, relativePath: string): string {
  if (hasPathTraversal(targetPath)) {
    throw new Error(`Invalid restore target path: ${targetPath}`);
  }
  const safeRelative = sanitizeRelativePath(relativePath);
  const resolvedTarget = path.resolve(targetPath);
  const destPath = path.resolve(path.join(resolvedTarget, safeRelative));
  const targetPrefix = `${resolvedTarget}${path.sep}`;
  if (destPath !== resolvedTarget && !destPath.startsWith(targetPrefix)) {
    throw new Error(`Restore destination escapes target directory: ${safeRelative}`);
  }
  return destPath;
}
