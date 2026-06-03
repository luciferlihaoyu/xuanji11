/**
 * 阿里云盘连接器
 * 基于阿里云盘开放平台API (https://www.alipan.com/developer/)
 * 
 * 使用说明：
 * 1. 到 https://www.alipan.com/developer/ 申请开发者
 * 2. 创建应用获取 app_id 和 app_secret
 * 3. 用户授权获取 refresh_token 和 access_token
 * 4. 在数据源配置中填入 token 即可使用
 */
import { registerConnector, type CloudConnector, type CloudFile } from "./base";

/** 阿里云盘 API 基础地址 */
const API_BASE = "https://openapi.alipan.com";

/** 调用阿里云盘API */
async function callAliyunApi(token: string, endpoint: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`阿里云盘 API error: ${res.status}`);
  return res.json();
}

/** 刷新access_token */
async function refreshAliyunToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const res = await fetch(`${API_BASE}/v2/account/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const data = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (data.access_token) {
      return { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken };
    }
    return null;
  } catch {
    return null;
  }
}

/** 列出文件夹内容 */
async function listAliyunFiles(token: string, parentId?: string): Promise<CloudFile[]> {
  try {
    // 先获取drive_id
    const userInfo = (await callAliyunApi(token, "/adrive/v1.0/user/getDriveInfo")) as { default_drive_id?: string };
    const driveId = userInfo.default_drive_id;
    if (!driveId) return [];

    const data = (await callAliyunApi(token, "/adrive/v1.0/openFile/list", {
      drive_id: driveId,
      parent_file_id: parentId || "root",
      limit: 100,
      order_by: "updated_at",
      order_direction: "DESC",
    })) as { items?: Array<{ file_id: string; name: string; type: string; size?: number; mime_type?: string; parent_file_id?: string; updated_at?: string }> };

    if (!data.items) return [];

    return data.items.map((item) => ({
      id: item.file_id,
      name: item.name,
      type: item.type === "folder" ? "folder" : "file",
      size: item.size,
      mimeType: item.mime_type,
      parentId: item.parent_file_id,
      modifiedAt: item.updated_at ? new Date(item.updated_at) : undefined,
    }));
  } catch (err) {
    console.error("[阿里云盘] list files failed:", err);
    return [];
  }
}

/** 获取下载链接 */
async function getAliyunDownloadUrl(token: string, fileId: string): Promise<string | null> {
  try {
    const userInfo = (await callAliyunApi(token, "/adrive/v1.0/user/getDriveInfo")) as { default_drive_id?: string };
    const driveId = userInfo.default_drive_id;
    if (!driveId) return null;

    const data = (await callAliyunApi(token, "/adrive/v1.0/openFile/getDownloadUrl", {
      drive_id: driveId,
      file_id: fileId,
    })) as { url?: string };

    return data.url || null;
  } catch {
    return null;
  }
}

export const connectorAliyunDrive: CloudConnector = {
  name: "阿里云盘",
  authType: "oauth2",

  async testConnection(config) {
    const token = config.accessToken || config.apiKey;
    const refreshToken = config.refreshToken;

    if (!token && !refreshToken) {
      return { success: false, message: "缺少 accessToken 或 refreshToken" };
    }

    try {
      let effectiveToken = token as string;
      // 如果有refreshToken但没有accessToken，先刷新
      if (!effectiveToken && refreshToken) {
        const refreshed = await refreshAliyunToken(refreshToken as string);
        if (refreshed) {
          effectiveToken = refreshed.accessToken;
        } else {
          return { success: false, message: "refresh_token 已过期，请重新授权" };
        }
      }

      await callAliyunApi(effectiveToken, "/adrive/v1.0/user/getDriveInfo");
      return { success: true, message: "阿里云盘连接成功" };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "连接失败" };
    }
  },

  async listFiles(config, parentId) {
    const token = config.accessToken || config.apiKey;
    const refreshToken = config.refreshToken;
    if (!token && !refreshToken) return [];

    let effectiveToken = token as string;
    if (!effectiveToken && refreshToken) {
      const refreshed = await refreshAliyunToken(refreshToken as string);
      if (refreshed) effectiveToken = refreshed.accessToken;
      else return [];
    }

    return listAliyunFiles(effectiveToken, parentId);
  },

  async getDownloadUrl(config, fileId) {
    const token = config.accessToken || config.apiKey;
    const refreshToken = config.refreshToken;
    if (!token && !refreshToken) return null;

    let effectiveToken = token as string;
    if (!effectiveToken && refreshToken) {
      const refreshed = await refreshAliyunToken(refreshToken as string);
      if (refreshed) effectiveToken = refreshed.accessToken;
      else return null;
    }

    return getAliyunDownloadUrl(effectiveToken, fileId);
  },
};

// 注册连接器
registerConnector("aliyundrive", connectorAliyunDrive);
