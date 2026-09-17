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
  /** 大文件磁盘直传（可选）：避免整文件读入内存；缺省时调用方自行读入再走 uploadFile */
  uploadBigFile?(config: Record<string, unknown>, remoteRelPath: string, localPath: string): Promise<void>;
  /** 读取文件，不存在时返回 null */
  readFile(config: Record<string, unknown>, remoteRelPath: string): Promise<Buffer | null>;
  /** 删除文件（不存在时视为成功） */
  deleteFile(config: Record<string, unknown>, remoteRelPath: string): Promise<void>;
  /** 列出 basePath（或子目录）下的相对路径（仅文件，不含目录） */
  listFiles(config: Record<string, unknown>, remoteRelPath?: string): Promise<string[]>;
  /**
   * 是否支持「每次运行独立快照目录」（版本化备份）。
   * 支持时执行层会给 config 注入 runDir，该次运行的全部文件都落在 basePath/runDir 下。
   */
  readonly supportsRunDirs?: boolean;
  /**
   * 清理历史快照目录，只保留最新 keepLastN 份（可选能力）。
   * 删除权限不足时应把失败明细放进 failures 返回，而不是抛错——备份本身已经成功。
   */
  pruneRuns?(config: Record<string, unknown>, keepLastN: number): Promise<PruneRunsResult>;
}

/** 远端快照清理结果 */
export interface PruneRunsResult {
  /** 成功删除的快照目录名 */
  deleted: string[];
  /** 保留（未删除）的快照目录数 */
  kept: number;
  /** 删除失败的明细（如权限不足） */
  failures: string[];
}

/** 快照目录名约定：2026-09-17T05-23-00（UTC，可字典序排序 = 时间序） */
export function formatRunDir(from: Date): string {
  return from.toISOString().replace(/\.\d{3}Z$/, "").replace(/:/g, "-");
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
