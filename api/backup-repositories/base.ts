/**
 * 备份仓库抽象层
 *
 * 服务「备份包目录同步」而非单文件网盘：
 * 每个仓库都是 `{ basePath } + 相对路径` 的目录视图，
 * 上层用它同步一个备份包（manifest.json + 内容文件）而不是零散文件。
 */

/** 备份仓库接口 —— 能力最小化 */
export interface BackupRepository {
  /** 仓库显示名称 */
  readonly name: string;
  /** 测试连接（配置来自调用方，不落盘） */
  testConnection(config: Record<string, unknown>): Promise<{ success: boolean; message: string }>;
  /** 确保基础目录存在（如本地目录的 mkdir -p） */
  ensureBasePath(config: Record<string, unknown>): Promise<void>;
  /** 上传文件到 basePath 下的相对路径 */
  uploadFile(config: Record<string, unknown>, remoteRelPath: string, content: Buffer): Promise<void>;
  /** 读取文件，不存在时返回 null */
  readFile(config: Record<string, unknown>, remoteRelPath: string): Promise<Buffer | null>;
  /** 删除文件（不存在时视为成功） */
  deleteFile(config: Record<string, unknown>, remoteRelPath: string): Promise<void>;
  /** 列出 basePath（或子目录）下的相对路径（仅文件，不含目录） */
  listFiles(config: Record<string, unknown>, remoteRelPath?: string): Promise<string[]>;
}

const registry = new Map<string, BackupRepository>();

export function registerBackupRepository(key: string, repo: BackupRepository): void {
  registry.set(key, repo);
}

export function getBackupRepository(key: string): BackupRepository | undefined {
  return registry.get(key);
}

export function listBackupRepositories(): { key: string; name: string }[] {
  return Array.from(registry.entries()).map(([key, repo]) => ({ key, name: repo.name }));
}
