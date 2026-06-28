/**
 * 璇玑备份系统 — 支持阿里云盘、115网盘、本地NAS三种备份目标
 */

import { z } from "zod";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getConnector } from "./connectors/base";
import type { CloudConnector } from "./connectors/base";
import path from "path";
import { promises as fs } from "fs";

// 备份任务状态
type BackupStatus = "pending" | "running" | "completed" | "failed";

// 内存备份任务存储（生产应接入数据库）
interface BackupTask {
  id: number;
  target: string;
  sourcePath: string;
  status: BackupStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  filesTotal: number;
  filesDone: number;
}

const tasks: BackupTask[] = [];
let nextId = 1;

// 支持的备份目标
const BACKUP_TARGETS = ["aliyundrive", "115", "nas", "local"] as const;

async function executeBackup(task: BackupTask): Promise<void> {
  const connector = getConnector(task.target) as CloudConnector | undefined;
  if (!connector) {
    task.status = "failed";
    task.error = `未找到连接器: ${task.target}`;
    return;
  }

  task.status = "running";
  task.startedAt = new Date().toISOString();

  try {
    if (connector.syncFiles) {
      const result = await connector.syncFiles(
        { path: task.sourcePath },
        task.sourcePath
      );
      task.filesDone = result.downloaded;
      task.filesTotal = result.downloaded + result.failed;
      task.progress = 100;
      task.completedAt = new Date().toISOString();

      if (result.failed > 0) {
        task.status = "completed";
        task.error = `${result.failed} 个文件备份失败`;
      } else {
        task.status = "completed";
      }
    } else {
      // 回退：逐个文件上传
      task.status = "running";
      task.progress = 0;

      const items = await connector.listFiles({ path: task.sourcePath });
      task.filesTotal = items.length;
      task.filesDone = 0;

      for (const item of items) {
        if (item.type === "file") {
          try {
            const url = await connector.getDownloadUrl({ path: task.sourcePath }, item.id);
            if (url && connector.uploadFile) {
              const content = Buffer.from(await (await fetch(url)).arrayBuffer());
              await connector.uploadFile({ path: task.sourcePath }, item.name, content);
            }
            task.filesDone++;
          } catch {
            // 跳过失败文件
          }
        }
        task.progress = Math.round((task.filesDone / task.filesTotal) * 100);
      }
      task.status = "completed";
      task.completedAt = new Date().toISOString();
    }
  } catch (err) {
    task.status = "failed";
    task.error = err instanceof Error ? err.message : "备份执行失败";
  }
}

export const backupRouter = createRouter({
  /** 列出可用备份目标 */
  targets: authedQuery.query(async () => {
    return BACKUP_TARGETS.map((key) => {
      const c = getConnector(key);
      return { key, name: c?.name ?? key, available: !!c };
    });
  }),

  /** 列出备份任务 */
  list: authedQuery.query(async () => {
    return tasks.slice(-20).reverse();
  }),

  /** 获取单个备份任务 */
  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      return tasks.find((t) => t.id === input.id) ?? null;
    }),

  /** 创建并启动备份 */
  create: adminQuery
    .input(
      z.object({
        target: z.enum(["aliyundrive", "115", "nas", "local"]),
        sourcePath: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const connector = getConnector(input.target);
      if (!connector) {
        throw new Error(`备份目标不可用: ${input.target}`);
      }

      const testResult = await connector.testConnection({ path: input.sourcePath });
      if (!testResult.success) {
        throw new Error(`连接测试失败: ${testResult.message}`);
      }

      const task: BackupTask = {
        id: nextId++,
        target: input.target,
        sourcePath: input.sourcePath,
        status: "pending",
        progress: 0,
        filesTotal: 0,
        filesDone: 0,
      };

      tasks.push(task);

      // 异步执行备份
      executeBackup(task).catch(console.error);

      return task;
    }),

  /** 获取备份任务状态 */
  status: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const task = tasks.find((t) => t.id === input.id);
      if (!task) return null;
      return {
        id: task.id,
        target: task.target,
        status: task.status,
        progress: task.progress,
        filesTotal: task.filesTotal,
        filesDone: task.filesDone,
        error: task.error,
      };
    }),
});
