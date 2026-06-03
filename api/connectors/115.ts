/**
 * 115网盘连接器
 * 基于115开放平台API (https://www.yuque.com/115yun/open)
 * 
 * 使用说明：
 * 1. 到 https://open.115.com/ 申请开发者入驻
 * 2. 创建应用获取 app_id 和 app_secret
 * 3. 用户授权获取 access_token
 * 4. 在数据源配置中填入 token 即可使用
 */
import { registerConnector, type CloudConnector, type CloudFile } from "./base";

/** 115 API 基础地址 */
const API_BASE = "https://proapi.115.com/app/open";

/** 获取用户信息的授权验证 */
async function call115Api(token: string, endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${API_BASE}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`115 API error: ${res.status}`);
  return res.json();
}

/** 列出文件夹内容 */
async function list115Files(token: string, parentId?: string): Promise<CloudFile[]> {
  try {
    const data = (await call115Api(token, "/files", {
      cid: parentId || "0",
      limit: "100",
      offset: "0",
    })) as { data?: Array<{ fid: string; cid: string; n: string; s?: number; m?: string; t: string }> };

    if (!data.data) return [];

    return data.data.map((item) => ({
      id: item.fid || item.cid,
      name: item.n,
      type: item.t === "1" ? "folder" : "file",
      size: item.s,
      mimeType: item.m,
      parentId: parentId || "0",
    }));
  } catch (err) {
    console.error("[115] list files failed:", err);
    return [];
  }
}

/** 获取下载链接 */
async function get115DownloadUrl(token: string, fileId: string): Promise<string | null> {
  try {
    const data = (await call115Api(token, "/files/download", { fid: fileId })) as { url?: string };
    return data.url || null;
  } catch {
    return null;
  }
}

export const connector115: CloudConnector = {
  name: "115网盘",
  authType: "oauth2",

  async testConnection(config) {
    const token = config.accessToken || config.apiKey;
    if (!token) return { success: false, message: "缺少 accessToken，请先完成OAuth授权" };
    try {
      await call115Api(token as string, "/user/info");
      return { success: true, message: "115网盘连接成功" };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "连接失败" };
    }
  },

  async listFiles(config, parentId) {
    const token = config.accessToken || config.apiKey;
    if (!token) return [];
    return list115Files(token as string, parentId);
  },

  async getDownloadUrl(config, fileId) {
    const token = config.accessToken || config.apiKey;
    if (!token) return null;
    return get115DownloadUrl(token as string, fileId);
  },
};

// 注册连接器
registerConnector("115", connector115);
