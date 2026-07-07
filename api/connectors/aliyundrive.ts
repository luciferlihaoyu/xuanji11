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

interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string;
}

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
async function refreshAliyunToken(refreshToken: string): Promise<TokenRefreshResult | null> {
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
  } catch (err) {
    console.error("[阿里云盘] refresh token failed:", err);
    return null;
  }
}

/** 获取有效的 drive_id */
async function getAliyunDriveId(token: string): Promise<string | null> {
  try {
    const userInfo = (await callAliyunApi(token, "/adrive/v1.0/user/getDriveInfo")) as { default_drive_id?: string };
    return userInfo.default_drive_id || null;
  } catch (err) {
    console.error("[阿里云盘] get drive id failed:", err);
    return null;
  }
}

/** 列出文件夹内容 */
async function listAliyunFiles(token: string, parentId?: string): Promise<CloudFile[]> {
  try {
    const driveId = await getAliyunDriveId(token);
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
    const driveId = await getAliyunDriveId(token);
    if (!driveId) return null;

    const data = (await callAliyunApi(token, "/adrive/v1.0/openFile/getDownloadUrl", {
      drive_id: driveId,
      file_id: fileId,
    })) as { url?: string };

    return data.url || null;
  } catch (err) {
    console.error("[阿里云盘] get download url failed:", err);
    return null;
  }
}

/** 阿里云盘上传文件（使用创建文件 + 上传方式） */
async function uploadAliyunFile(token: string, fileName: string, content: Buffer): Promise<{ success: boolean; path: string }> {
  try {
    const driveId = await getAliyunDriveId(token);
    if (!driveId) {
      throw new Error("无法获取 drive_id");
    }

    // 1. 创建文件（获取上传地址）
    const createRes = (await callAliyunApi(token, "/adrive/v1.0/openFile/create", {
      drive_id: driveId,
      parent_file_id: "root",
      name: fileName,
      type: "file",
      size: content.length,
      check_name_mode: "auto_rename",
    })) as { file_id?: string; upload_id?: string; part_info_list?: Array<{ upload_url: string; part_number: number }> };

    if (!createRes.file_id) {
      throw new Error("创建文件失败");
    }

    // 2. 上传内容（简单上传，不分片）
    const uploadUrl = createRes.part_info_list?.[0]?.upload_url;
    if (uploadUrl) {
      const uploadResult = await fetch(uploadUrl, {
        method: "PUT",
        body: new Uint8Array(content),
        headers: {
          "Content-Type": "application/octet-stream",
        },
      });
      if (!uploadResult.ok) {
        throw new Error(`上传失败: ${uploadResult.status}`);
      }
    }

    // 3. 完成上传
    await callAliyunApi(token, "/adrive/v1.0/openFile/complete", {
      drive_id: driveId,
      file_id: createRes.file_id,
      upload_id: createRes.upload_id,
    });

    return { success: true, path: fileName };
  } catch (err) {
    console.error("[阿里云盘] upload file failed:", err);
    return { success: false, path: "" };
  }
}

async function getEffectiveToken(config: Record<string, unknown>): Promise<string | null> {
  const accessToken = config.accessToken as string | undefined;
  const refreshToken = config.refreshToken as string | undefined;

  if (accessToken) return accessToken;
  if (!refreshToken) return null;

  const refreshed = await refreshAliyunToken(refreshToken);
  return refreshed?.accessToken ?? null;
}

export const connectorAliyunDrive: CloudConnector = {
  name: "阿里云盘",
  authType: "oauth2",

  async testConnection(config) {
    const token = await getEffectiveToken(config);
    const refreshToken = config.refreshToken as string | undefined;

    if (!token && !refreshToken) {
      return { success: false, message: "缺少 accessToken 或 refreshToken" };
    }

    try {
      let effectiveToken = token as string;
      // 如果有refreshToken但没有accessToken，先刷新
      if (!effectiveToken && refreshToken) {
        const refreshed = await refreshAliyunToken(refreshToken);
        if (refreshed) {
          effectiveToken = refreshed.accessToken;
        } else {
          return { success: false, message: "refresh_token 已过期，请重新授权" };
        }
      }

      await callAliyunApi(effectiveToken, "/adrive/v1.0/user/getDriveInfo");
      return { success: true, message: "阿里云盘连接成功" };
    } catch (err) {
      console.error("[阿里云盘] test connection failed:", err);
      return { success: false, message: "连接测试失败" };
    }
  },

  async listFiles(config, parentId) {
    const token = await getEffectiveToken(config);
    if (!token) {
      console.error("[阿里云盘] listFiles: no token available");
      return [];
    }
    return listAliyunFiles(token, parentId);
  },

  async getDownloadUrl(config, fileId) {
    const token = await getEffectiveToken(config);
    if (!token) {
      console.error("[阿里云盘] getDownloadUrl: no token available");
      return null;
    }
    return getAliyunDownloadUrl(token, fileId);
  },

  async uploadFile(config, fileName: string, content: Buffer) {
    const token = await getEffectiveToken(config);
    if (!token) {
      console.error("[阿里云盘] uploadFile: no token available");
      return { success: false, path: "" };
    }
    return uploadAliyunFile(token, fileName, content);
  },

  async syncFiles(_config, _localPath: string) {
    console.error("[阿里云盘] syncFiles not supported, use uploadFile instead");
    return { downloaded: 0, failed: 0 };
  },

  async refreshToken(config) {
    const refreshToken = config.refreshToken as string | undefined;
    if (!refreshToken) {
      console.error("[阿里云盘] refreshToken: no refreshToken provided");
      return null;
    }
    return refreshAliyunToken(refreshToken);
  },
};

// 注册连接器
registerConnector("aliyundrive", connectorAliyunDrive);
