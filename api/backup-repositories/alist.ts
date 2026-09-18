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
import { assertEgressAllowed } from "../lib/egress";
import type { BackupRepository, PruneRunsResult } from "./base";

const TIMEOUT_MS = 30_000;

/** CF 免费版 100MB 上限 + 100s 响应超时（524）。真实数据走 115 真实上传（秒传 miss）
 *  实测：随机 10MB=14s ✓ / 随机 30MB>100s ✗（零填充有秒传命中假象）→ 取 10MB 分片 */
const CHUNK_THRESHOLD = 12 * 1048576;
const CHUNK_SIZE = 10 * 1048576;
/** 单片失败重试次数 */
const PART_MAX_ATTEMPTS = 3;
/** 分片清单后缀：file.xjmanifest 记录 {parts, size}；分片名 file.partNNN */
const PARTS_MANIFEST_SUFFIX = ".xjmanifest";

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

/** 单文件 PUT（动态超时：30s + 5s/MB，封顶 15 分钟） */
/** 带重试的单文件上传：AList 偶发 5xx/Go panic/网络抖动不该拖垮整个备份 */
async function putWithRetry(
  cfg: AlistConfig,
  token: string,
  safePath: string,
  content: Buffer | Uint8Array,
  attempts: number = PART_MAX_ATTEMPTS
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await putOne(cfg, token, safePath, content as Buffer);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function putOne(
  cfg: AlistConfig,
  token: string,
  safePath: string,
  content: Buffer,
): Promise<void> {
  const target = joinFsPath(cfg.basePath, safePath);
  const parentDir = target.slice(0, target.lastIndexOf("/")) || "/";
  await ensureDir(cfg, token, parentDir);
  await assertEgressAllowed(cfg.baseUrl);
  // 115 经 Cloudflare 的实传速率在 0.3~0.7MB/s 大幅波动（还会被限速），
  // 原先 30s + 5s/MB（10MB 分片仅 80s）预算过紧 → 大文件整批超时。
  // 改为 5 分钟基础 + 10s/MB：10MB 分片 ≈ 6.7 分钟预算，仍留有硬上限防挂死。
  const uploadTimeoutMs = Math.min(20 * 60_000, 5 * 60_000 + Math.floor(content.length / 1048576) * 10_000);
  const res = await fetch(`${cfg.baseUrl}/api/fs/put`, {
    method: "PUT",
    headers: {
      Authorization: token,
      "File-Path": encodeURIComponent(target),
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(content),
    signal: AbortSignal.timeout(uploadTimeoutMs),
  });
  if (!res.ok) throw new AlistError(res.status, "PUT", safePath);
  const payload = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
  if (payload && payload.code !== 200) {
    throw new Error(`AList 上传失败 (${safePath})${payload.message ? `: ${payload.message}` : ""}`);
  }
}
export class AlistError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, method: string, relPath: string) {
    super(`AList ${method} ${relPath} 失败: HTTP ${statusCode}`);
    this.name = "AlistError";
    this.statusCode = statusCode;
  }
}

/** 快照目录名：只允许 formatRunDir 产出的时间戳形态，杜绝路径穿越 */
const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

function parseConfig(config: Record<string, unknown>): AlistConfig | null {
  const result = alistConfigSchema.safeParse(config);
  if (!result.success) return null;
  const { username, password } = result.data;
  const u = new URL(result.data.url);
  let pathname = decodeURIComponent(u.pathname).replace(/\/+$/, "");
  // 兼容旧的 WebDAV 写法：剥掉 /dav 前缀，剩余部分作为备份目录
  if (pathname === "/dav") pathname = "";
  else if (pathname.startsWith("/dav/")) pathname = pathname.slice("/dav".length);
  // 版本化：本次运行的 runDir 直接拼进 basePath，上传/读取/删除全部自动落在该快照目录内
  const runDir = typeof config.runDir === "string" ? config.runDir.trim() : "";
  if (runDir && !RUN_DIR_PATTERN.test(runDir)) return null;
  const basePath = runDir ? joinFsPath(pathname || "/", runDir) : pathname || "/";
  return {
    baseUrl: u.origin,
    basePath,
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

// 已确认存在的目录缓存：key = baseUrl+username+dir，避免每次上传前重复探测
const ensuredDirs = new Set<string>();

async function login(cfg: AlistConfig): Promise<string> {
  const cacheKey = `${cfg.baseUrl}::${cfg.username}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.obtainedAt < TOKEN_TTL_MS) return cached.token;

  // SSRF guard：用户配置的站点地址，默认禁私网（EGRESS_ALLOW_PRIVATE_NET=true 放行内网部署）
  await assertEgressAllowed(cfg.baseUrl);
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
  await assertEgressAllowed(cfg.baseUrl);
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
  await assertEgressAllowed(cfg.baseUrl);
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

/** 递归确保目录存在（带进程内缓存） */
async function ensureDir(cfg: AlistConfig, token: string, dir: string): Promise<void> {
  if (dir === "/") return;
  const cacheKey = `${cfg.baseUrl}::${cfg.username}::${dir}`;
  if (ensuredDirs.has(cacheKey)) return;
  try {
    await fsList(cfg, token, dir);
    ensuredDirs.add(cacheKey);
    return; // 已存在
  } catch {
    // 不存在（或无权限列），尝试创建
  }
  const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
  if (parent !== dir) await ensureDir(cfg, token, parent);
  await fsMkdir(cfg, token, dir);
  ensuredDirs.add(cacheKey);
}

/** 裸取远端单个文件（不做分片探测）：readFile / deleteFile 共用，杜绝递归自探 */
/** AList 删除（一次调用可带多个名字）；code != 200 视为失败并带上服务端消息 */
async function fsRemove(cfg: AlistConfig, token: string, dir: string, names: string[]): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/api/fs/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ dir, names }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
  if (!res.ok) throw new AlistError(res.status, "REMOVE", dir);
  if (payload && payload.code !== 200) {
    throw new Error(`AList 删除失败 (${dir})${payload.message ? `: ${payload.message}` : ""}`);
  }
}

/** 递归删除目录：先删子项（自底向上），最后删目录本身 */
async function removeTree(cfg: AlistConfig, token: string, absPath: string, depth = 0): Promise<void> {
  if (depth > MAX_PRUNE_DEPTH) throw new Error(`目录层级超过 ${MAX_PRUNE_DEPTH} 层，放弃递归删除：${absPath}`);
  const items = await fsList(cfg, token, absPath);
  // AList 返回的 name 是可选的；没有名字的条目无法寻址（不能删、不能进子目录），直接跳过
  const named = items.filter((i): i is FsItem & { name: string } => typeof i.name === "string" && i.name.length > 0);
  const files = named.filter((i) => !i.is_dir).map((i) => i.name);
  if (files.length > 0) await fsRemove(cfg, token, absPath, files);
  for (const dir of named.filter((i) => i.is_dir)) {
    await removeTree(cfg, token, joinFsPath(absPath, dir.name), depth + 1);
    await fsRemove(cfg, token, absPath, [dir.name]);
  }
}

async function fetchWholeFile(cfg: AlistConfig, safePath: string): Promise<Buffer | null> {
  const target = joinFsPath(cfg.basePath, safePath);
  const token = await login(cfg);
  await assertEgressAllowed(cfg.baseUrl);
  // 恢复是慢速下行：给足 5 分钟（分片 ≤10MB，整文件路径也够用）
  const downloadTimeout = Math.max(TIMEOUT_MS, 5 * 60_000);
  const res = await fetch(`${cfg.baseUrl}/api/fs/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ path: target }),
    signal: AbortSignal.timeout(downloadTimeout),
  });
  if (!res.ok) throw new AlistError(res.status, "GET", safePath);
  const payload = (await res.json()) as { code?: number; message?: string; data?: { raw_url?: string } };
  if (payload.code !== 200) {
    if (/not found|不存在/i.test(payload.message ?? "")) return null;
    throw new Error(`AList 读取失败 (${safePath})${payload.message ? `: ${payload.message}` : ""}`);
  }
  const rawUrl = payload.data?.raw_url;
  if (!rawUrl) return null;
  await assertEgressAllowed(rawUrl);
  const fileRes = await fetch(rawUrl, { signal: AbortSignal.timeout(downloadTimeout) });
  if (!fileRes.ok) {
    if (fileRes.status === 404) return null;
    throw new AlistError(fileRes.status, "GET", safePath);
  }
  return Buffer.from(await fileRes.arrayBuffer());
}

const MAX_PRUNE_DEPTH = 8;

export const alistRepository: BackupRepository = {
  name: "AList 网盘",

  supportsRunDirs: true,

  /**
   * 版本化备份的远端保留策略：basePath 下每个 runDir 是一份完整快照，
   * 只保留最新 keepLastN 份，其余递归删除。删除权限不足时记入 failures 而不抛错。
   */
  async pruneRuns(config: Record<string, unknown>, keepLastN: number): Promise<PruneRunsResult> {
    // 关键：清理视角必须站在「父目录」上，所以丢掉调用方可能带上的 runDir
    const { runDir: _ignored, ...parentConfig } = config;
    const cfg = requireConfig(parentConfig);
    const keep = Math.max(1, Math.floor(keepLastN) || 1);
    const token = await login(cfg);
    const items = await fsList(cfg, token, cfg.basePath);
    const runs = items
      // 同上：无名条目不可寻址；顺带避免 RUN_DIR_PATTERN.test(undefined) 把 "undefined" 当目录名去测
      .filter((i): i is FsItem & { name: string } => !!i.is_dir && typeof i.name === "string" && RUN_DIR_PATTERN.test(i.name))
      .map((i) => i.name)
      .sort()
      .reverse();
    const result: PruneRunsResult = { deleted: [], kept: Math.min(runs.length, keep), failures: [] };
    for (const name of runs.slice(keep)) {
      try {
        await removeTree(cfg, token, joinFsPath(cfg.basePath, name));
        await fsRemove(cfg, token, cfg.basePath, [name]);
        result.deleted.push(name);
      } catch (err) {
        result.failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  },

  async testConnection(config: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
    const cfg = parseConfig(config);
    if (!cfg) {
      return { success: false, message: "AList 配置无效：需要 url(http/https)、username、password" };
    }
    try {
      const token = await login(cfg);
      let created = false;
      try {
        await fsList(cfg, token, cfg.basePath);
      } catch {
        // 目录不存在则自动创建（含父目录）
        await ensureDir(cfg, token, cfg.basePath);
        created = true;
      }
      const items = await fsList(cfg, token, cfg.basePath);
      return {
        success: true,
        message: `AList 连接成功，备份目录 ${cfg.basePath}${created ? " 已自动创建，" : ""}下 ${items.length} 个条目`,
      };
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
    const token = await login(cfg);

    // 大文件分片上传（绕开 Cloudflare 100MB 上限）
    if (content.length > CHUNK_THRESHOLD) {
      const parts = Math.ceil(content.length / CHUNK_SIZE);
      for (let i = 0; i < parts; i++) {
        const part = content.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const partPath = `${safePath}.part${String(i + 1).padStart(3, "0")}`;
        // 单片重试：CF 偶发 524/网络抖动不拖垮整个备份
        let lastErr: unknown;
        for (let attempt = 1; attempt <= PART_MAX_ATTEMPTS; attempt++) {
          try {
            await putOne(cfg, token, partPath, part);
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < PART_MAX_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
          }
        }
        if (lastErr) throw lastErr;
      }
      const manifest = Buffer.from(JSON.stringify({ parts, size: content.length }));
      await putWithRetry(cfg, token, `${safePath}${PARTS_MANIFEST_SUFFIX}`, manifest);
      return;
    }
    await putWithRetry(cfg, token, safePath, content);
  },

  async uploadBigFile(config: Record<string, unknown>, remoteRelPath: string, localPath: string): Promise<void> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);
    const token = await login(cfg);
    const { open } = await import("node:fs/promises");
    const fh = await open(localPath, "r");
    try {
      const stat = await fh.stat();
      if (stat.size <= CHUNK_THRESHOLD) {
        const buf = await fh.readFile();
        await putWithRetry(cfg, token, safePath, buf);
        return;
      }
      const parts = Math.ceil(stat.size / CHUNK_SIZE);
      const sliceBuf = Buffer.allocUnsafe(CHUNK_SIZE);
      for (let i = 0; i < parts; i++) {
        const offset = i * CHUNK_SIZE;
        const { bytesRead } = await fh.read(sliceBuf, 0, CHUNK_SIZE, offset);
        const part = sliceBuf.subarray(0, bytesRead);
        const partPath = `${safePath}.part${String(i + 1).padStart(3, "0")}`;
        let lastErr: unknown;
        const partStart = Date.now();
        for (let attempt = 1; attempt <= PART_MAX_ATTEMPTS; attempt++) {
          try {
            await putOne(cfg, token, partPath, part as Buffer);
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            const secs = ((Date.now() - partStart) / 1000).toFixed(1);
            console.warn(
              `[Backup] 分片重试 ${partPath} 第 ${attempt}/${PART_MAX_ATTEMPTS} 次失败（已耗时 ${secs}s）: ${err instanceof Error ? err.message : String(err)}`
            );
            if (attempt < PART_MAX_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
          }
        }
        if (lastErr) throw lastErr;
        const elapsed = (Date.now() - partStart) / 1000;
        console.log(
          `[Backup] ${safePath} 分片 ${i + 1}/${parts} 完成 ${(bytesRead / 1048576).toFixed(1)}MB / ${elapsed.toFixed(1)}s（${(bytesRead / 1048576 / elapsed).toFixed(2)} MB/s）`
        );
      }
      const manifest = Buffer.from(JSON.stringify({ parts, size: stat.size }));
      await putOne(cfg, token, `${safePath}${PARTS_MANIFEST_SUFFIX}`, manifest);
    } finally {
      await fh.close();
    }
  },

  async readFile(config: Record<string, unknown>, remoteRelPath: string): Promise<Buffer | null> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);

    // 先查分片清单：大文件以 file.partNNN + file.xjmanifest 存储。
    // 必须用 fetchWholeFile（裸取）：若递归 readFile，探清单的动作本身又会去探
    // `<清单>.xjmanifest`，无限递归直至栈溢出（实测恢复路径 100% 崩）
    let manifestBuf: Buffer | null = null;
    try {
      manifestBuf = await fetchWholeFile(cfg, `${safePath}${PARTS_MANIFEST_SUFFIX}`);
    } catch {
      manifestBuf = null; // 无清单/清单不可读 → 按整文件处理
    }
    if (manifestBuf) {
      let parts = 0;
      try {
        const meta = JSON.parse(manifestBuf.toString("utf8")) as { parts?: number };
        parts = typeof meta.parts === "number" ? meta.parts : 0;
      } catch {
        parts = 0; // 清单损坏 → 按整文件处理
      }
      if (parts > 0) {
        const chunks: Buffer[] = [];
        for (let i = 1; i <= parts; i++) {
          const partName = `${safePath}.part${String(i).padStart(3, "0")}`;
          const part = await fetchWholeFile(cfg, partName);
          if (!part) throw new Error(`分片缺失: ${partName}`);
          chunks.push(part);
        }
        return Buffer.concat(chunks);
      }
    }

    return fetchWholeFile(cfg, safePath);
  },

  async deleteFile(config: Record<string, unknown>, remoteRelPath: string): Promise<void> {
    const cfg = requireConfig(config);
    const safePath = sanitizeRelativePath(remoteRelPath);
    const target = joinFsPath(cfg.basePath, safePath);
    const dir = target.slice(0, target.lastIndexOf("/")) || "/";
    const name = target.slice(target.lastIndexOf("/") + 1);
    const token = await login(cfg);
    await assertEgressAllowed(cfg.baseUrl);

    // 分片文件连带删除（先读清单拿片数；清单不可读不影响主删除）
    const names = [name];
    try {
      const manifestBuf = await fetchWholeFile(cfg, `${safePath}${PARTS_MANIFEST_SUFFIX}`);
      if (manifestBuf) {
        const meta = JSON.parse(manifestBuf.toString("utf8")) as { parts?: number };
        names.push(`${name}${PARTS_MANIFEST_SUFFIX}`);
        for (let i = 1; i <= (meta.parts ?? 0); i++) {
          names.push(`${name}.part${String(i).padStart(3, "0")}`);
        }
      }
    } catch { /* 清单不可读 → 只删主文件 */ }

    const res = await fetch(`${cfg.baseUrl}/api/fs/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ dir, names }),
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
    const out: string[] = [];
    for (const item of items) {
      if (item.is_dir) continue;
      const name = item.name ?? "";
      if (/\.part\d{3}$/.test(name)) continue; // 分片不单独列出
      if (name.endsWith(PARTS_MANIFEST_SUFFIX)) {
        out.push(`${prefix}${name.slice(0, -PARTS_MANIFEST_SUFFIX.length)}`); // 分片文件按逻辑名
        continue;
      }
      out.push(`${prefix}${name}`);
    }
    return out;
  },
};
