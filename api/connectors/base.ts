/**
 * 网盘连接器基础接口
 * 所有网盘连接器必须实现此接口
 */

export interface CloudFile {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  mimeType?: string;
  parentId?: string;
  modifiedAt?: Date;
  downloadUrl?: string;
}

export interface CloudConnector {
  /** 连接器名称 */
  name: string;
  /** 授权类型 */
  authType: 'oauth2' | 'apikey' | 'cookie';
  /** 测试连接 */
  testConnection(config: Record<string, unknown>): Promise<{ success: boolean; message: string }>;
  /** 获取文件列表 */
  listFiles(config: Record<string, unknown>, parentId?: string): Promise<CloudFile[]>;
  /** 获取下载链接 */
  getDownloadUrl(config: Record<string, unknown>, fileId: string): Promise<string | null>;
  /** 上传/备份文件（备份用） */
  uploadFile(config: Record<string, unknown>, fileName: string, content: Buffer): Promise<{ success: boolean; path: string }>;
  /** 同步文件到本地（返回下载的文件信息） */
  syncFiles(config: Record<string, unknown>, localPath: string): Promise<{ downloaded: number; failed: number }>;
  /** 刷新 token */
  refreshToken?(config: Record<string, unknown>): Promise<{ accessToken: string; refreshToken: string } | null>;
}

// 连接器注册表
const connectors: Map<string, CloudConnector> = new Map();

export function registerConnector(platform: string, connector: CloudConnector) {
  connectors.set(platform, connector);
}

export function getConnector(platform: string): CloudConnector | undefined {
  return connectors.get(platform);
}

export function listConnectors(): { key: string; name: string }[] {
  return Array.from(connectors.entries()).map(([key, c]) => ({ key, name: c.name }));
}
