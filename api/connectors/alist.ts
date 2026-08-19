/**
 * AList 网盘连接器
 * 通过 AList REST API 接入：登录获取 token，列目录、取下载链接、上传文件。
 * 配置：{ url: "https://alist.example.com", username, password }
 * 凭据只存于 system_settings（服务端），不写入日志或错误消息。
 */

import { registerConnector, type CloudConnector } from './base';

const TIMEOUT_MS = 30_000;

interface AlistConfig {
  url: string;
  username: string;
  password: string;
}

function parseConfig(config: Record<string, unknown>): AlistConfig | null {
  const url = typeof config.url === 'string' ? config.url.trim().replace(/\/+$/, '') : '';
  const username = typeof config.username === 'string' ? config.username.trim() : '';
  const password = typeof config.password === 'string' ? config.password : '';
  if (!url || !username || !password) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, username, password };
}

// token 缓存：key = url+username
const tokenCache = new Map<string, { token: string; obtainedAt: number }>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // AList token 有效期 48h，提前一天续期

async function login(cfg: AlistConfig): Promise<string> {
  const cacheKey = `${cfg.url}::${cfg.username}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.obtainedAt < TOKEN_TTL_MS) return cached.token;

  const res = await fetch(`${cfg.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AList 登录失败: HTTP ${res.status}`);
  const payload = (await res.json()) as { code?: number; data?: { token?: string } };
  const token = payload.data?.token;
  if (!token) throw new Error('AList 登录失败：未返回 token（请检查账号密码）');
  tokenCache.set(cacheKey, { token, obtainedAt: Date.now() });
  return token;
}

interface FsItem {
  name?: string;
  size?: number;
  is_dir?: boolean;
  modified?: string;
}

async function fsList(cfg: AlistConfig, token: string, path: string): Promise<FsItem[]> {
  const res = await fetch(`${cfg.url}/api/fs/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ path, page: 1, per_page: 1000, refresh: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AList 列目录失败: HTTP ${res.status}`);
  const payload = (await res.json()) as { code?: number; data?: { content?: FsItem[] | null } };
  if (payload.code !== 200) throw new Error('AList 列目录失败');
  return payload.data?.content ?? [];
}

async function fsGetRawUrl(cfg: AlistConfig, token: string, path: string): Promise<string | null> {
  const res = await fetch(`${cfg.url}/api/fs/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { code?: number; data?: { raw_url?: string } };
  return payload.data?.raw_url ?? null;
}

function joinPath(parent: string, name: string): string {
  const p = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return `${p}/${name}`;
}

export const connectorAlist: CloudConnector = {
  name: 'AList 网盘',
  authType: 'apikey',

  async testConnection(config) {
    const cfg = parseConfig(config);
    if (!cfg) return { success: false, message: '配置不完整：需要 url、username、password' };
    try {
      const token = await login(cfg);
      const items = await fsList(cfg, token, '/');
      return { success: true, message: `连接成功，根目录 ${items.length} 个条目` };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : '连接失败' };
    }
  },

  async listFiles(config, parentId) {
    const cfg = parseConfig(config);
    if (!cfg) return [];
    const token = await login(cfg);
    const dir = parentId || '/';
    const items = await fsList(cfg, token, dir);
    return items.map((item) => ({
      id: joinPath(dir, item.name ?? ''),
      name: item.name ?? '',
      type: item.is_dir ? ('folder' as const) : ('file' as const),
      size: item.size,
      modifiedAt: item.modified ? new Date(item.modified) : undefined,
    }));
  },

  async getDownloadUrl(config, fileId) {
    const cfg = parseConfig(config);
    if (!cfg) return null;
    const token = await login(cfg);
    return fsGetRawUrl(cfg, token, fileId);
  },

  async uploadFile(config, fileName, content) {
    const cfg = parseConfig(config);
    if (!cfg) return { success: false, path: '' };
    if (fileName.split('/').some((seg) => seg === '..')) {
      throw new Error('Invalid upload path');
    }
    const token = await login(cfg);
    const target = fileName.startsWith('/') ? fileName : `/${fileName}`;
    const res = await fetch(`${cfg.url}/api/fs/put`, {
      method: 'PUT',
      headers: {
        Authorization: token,
        'File-Path': encodeURIComponent(target),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(content),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`AList 上传失败: HTTP ${res.status}`);
    const payload = (await res.json().catch(() => null)) as { code?: number } | null;
    if (payload && payload.code !== 200) throw new Error('AList 上传失败');
    return { success: true, path: target };
  },

  async syncFiles(config, localPath) {
    // AList → 本地：遍历根目录下载（尽力而为）
    const cfg = parseConfig(config);
    if (!cfg) return { downloaded: 0, failed: 0 };
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const token = await login(cfg);
    let downloaded = 0;
    let failed = 0;

    const walk = async (dir: string): Promise<void> => {
      const items = await fsList(cfg, token, dir);
      for (const item of items) {
        const full = joinPath(dir, item.name ?? '');
        if (item.is_dir) {
          await walk(full);
          continue;
        }
        try {
          const url = await fsGetRawUrl(cfg, token, full);
          if (!url) throw new Error('no raw_url');
          const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const dest = pathMod.join(localPath, full.replace(/^\/+/, ''));
          await fs.mkdir(pathMod.dirname(dest), { recursive: true });
          await fs.writeFile(dest, buf);
          downloaded++;
        } catch {
          failed++;
        }
      }
    };
    await walk('/');
    return { downloaded, failed };
  },
};

registerConnector('alist', connectorAlist);
