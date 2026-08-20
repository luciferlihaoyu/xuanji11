/**
 * AList 备份仓库（REST API 版）
 *
 * 通过 AList REST API 接入：/api/auth/login 取 token，/api/fs/list、/api/fs/get、
 * /api/fs/put、/api/fs/mkdir、/api/fs/remove 完成读写。
 * （旧版走 WebDAV /dav 端点，部分网关/路径配置下 PROPFIND 会 405，故弃用。）
 *
 * 配置：{ url, username, password }
 *   url 为 AList 站点地址，可带子目录作为备份落点：
 *     https://alist.example.com            → 备份到账号根目录
 *     https://alist.example.com/115/璇玑   → 备份到 /115/璇玑
 *   兼容旧的 WebDAV 写法：https://alist.example.com/dav/115/璇玑（自动剥掉 /dav）
 * 凭据绝不写入日志、错误消息或 API 响应。
 */
import { z } from "zod";
import { sanitizeRelativePath } from "../lib/backup-path";
import type { BackupRepository } from "./base";

const TIMEOUT_MS = 30_000;

const alistConfigSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "url 必须是 http:// 或 https://（示例 https://alist.example.com/115/璇玑）"),
  username: z.string().min(1),
  password: z.string().min(1),
});

interface AlistConfig {
  /** 站点根（协议 + 主机，如 https://alist.example.com） */
  baseUrl: string;
  /** 备份落点目录（如 /115/璇玑；"/" 表示账号根目录） */
  basePath: string;
  username: string;
  password: string;
}

/** 带状态码的错误；消息不含任何凭据。 */
export class AlistError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, method: string, relPath: string) {
    super(`AList ${method} ${relPath} 失败: HTTP ${statusCode}`);
    this.name = "AlistError";
    this.statusCode = statusCode;
  }
}

function parseConfig(config: Record<string, unknown>): AlistConfig | null {
  const result = alistConfigSchema.safeParse(config);
  if (!result.success) return null;
  const { username, password } = result.data;
  const u = new URL(result.data.url);
  let pathname = decodeURIComponent(u.pathname).replace(/\/+$/, "");
  // 兼容旧的 WebDAV 写法：剥掉 /dav 前缀，剩余部分作为备份目录
  if (pathname === "/dav") pathname = "";
  else if (pathname.startsWith("/dav/")) pathname = pathname.slice("/dav".length);
  return {
    baseUrl: u.origin,
    basePath: pathname || "/",
    username,
    password,
  };
}

function requireConfig(config: Record<string, unknown>): AlistConfig {
  const parsed = parseConfig(config);
  if (!parsed) {
    throw new Error("AList 配置无效：需要 url(http/https)、username、password");
  }
  return parsed;
}

function joinFsPath(dir: string, name: string): string {
  const d = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${d}/${name}`;
}

// token 缓存：key = baseUrl+username；AList token 有效期 48h，提前一天续期
const tokenCache = new Map<string, { token: string; obtainedAt: number }>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

async function login(cfg: AlistConfig): Promise<string> {
  const cacheKey = `${cfg.baseUrl}::${cfg.username}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.obtainedAt < TOKEN_TTL_MS) return cached.token;

  const res = await fetch(`${cfg.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new AlistError(res.status, "POST", "/api/auth/login");
  const payload = (await res.json()) as { code?: number; message?: string; data?: { token?: string } };
  const token = payload.data?.token;
  if (!token) throw new Error(`AList 登录失败${payload.message ? `: ${payload.message}` : "：未返回 token"}`);
  tokenCache.set(cacheKey, { token, obtainedAt: Date.now() });
  return token;
}

interface FsItem {
  name?: string;
  is_dir?: boolean;
}

/** 列目录；dirNotFound=true 时抛带 notFound 标记的错误 */
async function fsList(cfg: AlistConfig, token: string, path: string): Promise<FsItem[]> {
  const res = await fetch(`${cfg.baseUrl}/api/fs/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ path, page: 1, per_page: 1000, refresh: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new AlistError(res.status, "LIST", path);
  const payload = (await res.json()) as { code?: number; message?: string; data?: { content?: FsItem[] | null } };
  if (payload.code !== 200) {
    const err = new Error(`AList 列目录失败 (${path})${payload.message ? `: ${payload.message}` : ""}`);
    if (/not found|不存在/i.test(payload.message ?? "")) (err as Error & { notFound?: boolean }).notFound = true;
    throw err;
  }
  return payload.data?.content ?? [];
}

async function fsMkdir(cfg: AlistConfig, token: string, path: string): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/api/fs/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new AlistError(res.status, "MKDIR", path);
  const payload = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
  if (payload && payload.code !== 200 && !/exist/i.test(payload.message ?? "")) {
    throw new Error(`AList 建目录失败 (${path})${payload.message ? `: ${payload.message}` : ""}`);
  }
}

/** 递归确保目录存在 */
async function ensureDir(cfg: AlistConfig, token: string, dir: string): Promise<void> {
  if (dir === "/") return;
  try {
    await fsList(cfg, token, dir);
    return; // 已存在
  } catch {
    // 不存在（或无权限列），尝试创建
  }
  const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
  if (parent !== dir) await ensureDir(cfg, token, parent);
  await fsMkdir(cfg, token, dir);
}

export const alistRepository: BackupRepository = {
  name: "AList 网盘",

  async testConnection(config: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
    const cfg = parseConfig(config);
    if (!cfg) {
      return { success: false, message: "AList 配置无效：需要 url(http/https)、username、password" };
    }
    try {
      const token = await login(cfg);
      const items = await fsList(cfg, token, cfg.basePath);
      return { success: true, message: `AList 连接成功，备份目录 ${cfg.basePath} 下 ${items.length} 个条目` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "AList 连接失败" };
    }
  },

  async ensureBasePath(config: Record<string, unknown>): Promise<void> {
    const cfg = requireConfig(config);
    const token = await login(cfg);
    await ensureDir(cfg, token, cfg.basePath);
  },

  async uploadFile(config: Record<string, unknown>, remoteRelPath: string, content: Buffer): Promise<void> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);
    const target = joinFsPath(cfg.basePath, safePath);
    const token = await login(cfg);
    const res = await fetch(`${cfg.baseUrl}/api/fs/put`, {
      method: "PUT",
      headers: {
        Authorization: token,
        "File-Path": encodeURIComponent(target),
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(content),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new AlistError(res.status, "PUT", safePath);
    const payload = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
    if (payload && payload.code !== 200) {
      throw new Error(`AList 上传失败 (${safePath})${payload.message ? `: ${payload.message}` : ""}`);
    }
  },

  async readFile(config: Record<string, unknown>, remoteRelPath: string): Promise<Buffer | null> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);
    const target = joinFsPath(cfg.basePath, safePath);
    const token = await login(cfg);
    const res = await fetch(`${cfg.baseUrl}/api/fs/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ path: target }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new AlistError(res.status, "GET", safePath);
    const payload = (await res.json()) as { code?: number; message?: string; data?: { raw_url?: string } };
    if (payload.code !== 200) {
      if (/not found|不存在/i.test(payload.message ?? "")) return null;
      throw new Error(`AList 读取失败 (${safePath})${payload.message ? `: ${payload.message}` : ""}`);
    }
    const rawUrl = payload.data?.raw_url;
    if (!rawUrl) return null;
    const fileRes = await fetch(rawUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!fileRes.ok) {
      if (fileRes.status === 404) return null;
      throw new AlistError(fileRes.status, "GET", safePath);
    }
    return Buffer.from(await fileRes.arrayBuffer());
  },

  async deleteFile(config: Record<string, unknown>, remoteRelPath: string): Promise<void> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);
    const target = joinFsPath(cfg.basePath, safePath);
    const dir = target.slice(0, target.lastIndexOf("/")) || "/";
    const name = target.slice(target.lastIndexOf("/") + 1);
    const token = await login(cfg);
    const res = await fetch(`${cfg.baseUrl}/api/fs/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ dir, names: [name] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new AlistError(res.status, "REMOVE", safePath);
    const payload = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
    // 不存在时视为成功（幂等删除）
    if (payload && payload.code !== 200 && !/not found|不存在/i.test(payload.message ?? "")) {
      throw new Error(`AList 删除失败 (${safePath})${payload.message ? `: ${payload.message}` : ""}`);
    }
  },

  async listFiles(config: Record<string, unknown>, remoteRelPath?: string): Promise<string[]> {
    const cfg = requireConfig(config);
    const safePath = remoteRelPath ? sanitizeRelativePath(remoteRelPath) : "";
    const dir = safePath ? joinFsPath(cfg.basePath, safePath) : cfg.basePath;
    const token = await login(cfg);
    const items = await fsList(cfg, token, dir);
    const prefix = safePath ? `${safePath}/` : "";
    return items.filter((item) => !item.is_dir).map((item) => `${prefix}${item.name ?? ""}`);
  },
};
