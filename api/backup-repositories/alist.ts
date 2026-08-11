/**
 * AList WebDAV 备份仓库
 *
 * 通过 WebDAV（/dav/ 端点）接入 AList：PROPFIND / PUT / GET / DELETE。
 * 使用全局 fetch + Basic Auth，不新增 npm 依赖。
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
    .refine((u) => /^https?:\/\//i.test(u), "url 必须是 http:// 或 https://（示例 https://alist.example.com/dav）"),
  username: z.string().min(1),
  password: z.string().min(1),
});

type AlistConfig = z.infer<typeof alistConfigSchema>;

/** 带状态码的 WebDAV 错误；消息不含任何凭据。 */
export class AlistError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, method: string, relPath: string) {
    super(`AList WebDAV ${method} ${relPath} 失败: HTTP ${statusCode}`);
    this.name = "AlistError";
    this.statusCode = statusCode;
  }
}

function parseConfig(config: Record<string, unknown>): AlistConfig | null {
  const result = alistConfigSchema.safeParse(config);
  return result.success ? result.data : null;
}

function requireConfig(config: Record<string, unknown>): AlistConfig {
  const parsed = parseConfig(config);
  if (!parsed) {
    throw new Error("AList 配置无效：需要 url(http/https)、username、password");
  }
  return parsed;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const HREF_RE = /<(?:[a-zA-Z][\w.-]*:)?href>([^<]+)<\/(?:[a-zA-Z][\w.-]*:)?href>/g;

async function webdavRequest(
  cfg: AlistConfig,
  method: string,
  relPath: string,
  body?: Buffer,
  depth?: "0" | "1"
): Promise<Response> {
  const base = cfg.url.replace(/\/+$/, "");
  const url = `${base}/${relPath}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`,
  };
  if (depth !== undefined) headers.Depth = depth;

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : new Uint8Array(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 200 && res.status < 300) return res;
  throw new AlistError(res.status, method, relPath);
}

/** 把 multistatus 中的 href 解码为相对路径；目录（尾斜杠）被过滤。 */
function parseMultistatus(xml: string, baseUrl: string): string[] {
  const urlObj = new URL(baseUrl);
  const origin = urlObj.origin;
  const basePath = urlObj.pathname.replace(/\/+$/, "");
  const candidates = [basePath, `${basePath}/`, basePath.slice(1)].filter((c) => c.length > 0);

  const files: string[] = [];
  for (const match of xml.matchAll(HREF_RE)) {
    const raw = match[1] ?? "";
    let rel = percentDecode(decodeXmlEntities(raw));
    if (rel.startsWith(origin)) rel = rel.slice(origin.length);
    for (const candidate of candidates) {
      if (rel.startsWith(candidate)) {
        rel = rel.slice(candidate.length);
        break;
      }
    }
    rel = rel.replace(/^\/+/, "");
    if (!rel || rel.endsWith("/")) continue;
    files.push(rel);
  }
  return files;
}

export const alistRepository: BackupRepository = {
  name: "AList WebDAV",

  async testConnection(config: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
    const cfg = parseConfig(config);
    if (!cfg) {
      return { success: false, message: "AList 配置无效：需要 url(http/https)、username、password" };
    }
    try {
      const res = await webdavRequest(cfg, "PROPFIND", "", undefined, "0");
      if (res.status === 207) {
        return { success: true, message: "AList WebDAV 连接成功" };
      }
      return { success: false, message: `AList WebDAV 连接失败: HTTP ${res.status}` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "AList WebDAV 连接失败" };
    }
  },

  async ensureBasePath(): Promise<void> {
    // AList WebDAV 的 PUT 会自动创建父目录，无需显式 MKCOL
  },

  async uploadFile(config: Record<string, unknown>, remoteRelPath: string, content: Buffer): Promise<void> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);
    await webdavRequest(cfg, "PUT", safePath, content);
  },

  async readFile(config: Record<string, unknown>, remoteRelPath: string): Promise<Buffer | null> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);
    try {
      const res = await webdavRequest(cfg, "GET", safePath);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof AlistError && err.statusCode === 404) return null;
      throw err;
    }
  },

  async deleteFile(config: Record<string, unknown>, remoteRelPath: string): Promise<void> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);
    try {
      await webdavRequest(cfg, "DELETE", safePath);
    } catch (err) {
      if (err instanceof AlistError && err.statusCode === 404) return; // 幂等删除
      throw err;
    }
  },

  async listFiles(config: Record<string, unknown>, remoteRelPath?: string): Promise<string[]> {
    const cfg = requireConfig(config);
    const safePath = remoteRelPath ? sanitizeRelativePath(remoteRelPath) : "";
    const res = await webdavRequest(cfg, "PROPFIND", safePath, undefined, "1");
    if (res.status !== 207) {
      throw new AlistError(res.status, "PROPFIND", safePath);
    }
    const xml = await res.text();
    return parseMultistatus(xml, cfg.url);
  },
};
