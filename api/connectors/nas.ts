/**
 * NAS / 本地存储 连接器
 * 通过挂载路径 SMB/NFS 或本地目录进行文件读写和备份
 */

import { promises as fs } from 'fs';
import path from 'path';
import { registerConnector, type CloudConnector, type CloudFile } from './base';

async function listNasFiles(basePath: string, parentId?: string): Promise<CloudFile[]> {
  const targetPath = parentId ?? basePath;
  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => ({
      id: `${targetPath}/${entry.name}`,
      name: entry.name,
      type: entry.isDirectory() ? 'folder' : 'file',
      parentId: targetPath,
      modifiedAt: undefined,
    }));
  } catch {
    return [];
  }
}

async function uploadToNas(basePath: string, fileName: string, content: Buffer): Promise<{ success: boolean; path: string }> {
  const filePath = path.join(basePath, fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return { success: true, path: filePath };
}

export const connectorNas: CloudConnector = {
  name: 'NAS / 本地存储',
  authType: 'apikey',

  async testConnection(config) {
    const basePath = config.path as string;
    if (!basePath) return { success: false, message: '缺少路径配置 (path)' };
    try {
      await fs.access(basePath);
      return { success: true, message: `NAS 路径可访问: ${basePath}` };
    } catch {
      return { success: false, message: `路径不可访问: ${basePath}` };
    }
  },

  async listFiles(config, parentId) {
    const basePath = config.path as string;
    if (!basePath) return [];
    return listNasFiles(basePath, parentId);
  },

  async getDownloadUrl(_config, fileId) {
    return fileId; // 本地文件直接返回路径
  },

  /** 上传/备份文件到 NAS */
  async uploadFile(config, fileName: string, content: Buffer): Promise<{ success: boolean; path: string }> {
    const basePath = config.path as string;
    if (!basePath) return { success: false, path: '' };
    return uploadToNas(basePath, fileName, content);
  },

  /** 同步目录到 NAS */
  async syncFiles(config, localPath: string) {
    const basePath = config.path as string;
    const entries = await fs.readdir(localPath, { withFileTypes: true, recursive: true });
    let downloaded = 0, failed = 0;
    for (const entry of entries) {
      try {
        if (entry.isFile()) {
          const src = path.join(entry.parentPath ?? localPath, entry.name);
          const rel = path.relative(localPath, src);
          const dest = path.join(basePath, rel);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(src, dest);
          downloaded++;
        }
      } catch {
        failed++;
      }
    }
    return { downloaded, failed };
  },
};

// 注册连接器
registerConnector('nas', connectorNas);
registerConnector('local', connectorNas);
