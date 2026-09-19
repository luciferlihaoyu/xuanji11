/**
 * P0-4：全库回填的取消必须真的让循环停下（不是只把信号挂在句柄上）。
 * 用真实 document-indexer + 内存 SQLite，把向量/嵌入依赖换成替身。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));
vi.mock("./vector", () => ({
  vectorEngine: {
    size: 0,
    deleteByDocumentId: vi.fn(async () => {}),
    insertBatch: vi.fn(async () => {}),
    countByDocumentId: vi.fn(async () => 0),
  },
}));
vi.mock("./vector-service", () => ({
  ensureCorrectDimension: vi.fn(async () => {}),
  getLastEmbeddingIdentity: vi.fn(() => ({ model: "test-model", dimension: 8 })),
  embedTextsWithFallback: vi.fn(async (texts: string[]) => texts.map(() => new Array(8).fill(0))),
}));

import { getDb } from "../queries/connection";
import { getActiveReindexTaskId, getReindexProgress, startReindexAll } from "./document-indexer";
import { createTask, getTask, requestCancel, resetTaskRegistryForTest } from "./task-registry";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderId INTEGER,
      title TEXT NOT NULL,
      content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown',
      tags TEXT,
      metadata TEXT,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      deletedAt INTEGER,
      deletedReason TEXT,
      mergedIntoId INTEGER
    );
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documentId INTEGER NOT NULL,
      itemId INTEGER,
      content TEXT NOT NULL,
      chunkIndex INTEGER NOT NULL DEFAULT 0,
      embedding TEXT,
      embeddingModel TEXT,
      metadata TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  const db = drizzle(sqlite, { schema: { ...schema, ...relations } });
  for (const t of ["甲", "乙", "丙"]) {
    db.insert(schema.kbDocuments).values({ title: t, content: `${t}的正文内容` }).run();
  }
  return db;
}

beforeEach(() => {
  vi.clearAllMocks(); // 只清调用记录（保留替身实现），避免跨用例计数污染
  resetTaskRegistryForTest();
  vi.mocked(getDb).mockReturnValue(createTestDb() as never);
});

describe("全库回填取消（P0-4）", () => {
  it("无取消信号时跑完全部文档，任务 completed/100", async () => {
    const task = createTask({ kind: "reindex" });
    startReindexAll(task.taskId);
    // 等后台跑完（3 篇小文档 + 100ms 间隔）
    for (let i = 0; i < 60 && getReindexProgress().running; i += 1) await new Promise((r) => setTimeout(r, 50));

    const p = getReindexProgress();
    expect(p.running).toBe(false);
    expect(p.done).toBe(3);
    expect(getTask(task.taskId)?.status).toBe("completed");
  });

  it("运行中才认领句柄同样有效：UI 起的回填可被后到的 MCP 句柄取消", async () => {
    // UI（kb.reindexAll）起的回填没有句柄；此时 MCP 调用应当**认领**它而不是另起一个孤儿句柄
    startReindexAll();
    const task = createTask({ kind: "reindex" });
    startReindexAll(task.taskId); // 已在运行 → 认领
    expect(getActiveReindexTaskId()).toBe(task.taskId);

    requestCancel(task.taskId);
    for (let i = 0; i < 60 && getReindexProgress().running; i += 1) await new Promise((r) => setTimeout(r, 50));

    const p = getReindexProgress();
    expect(p.running).toBe(false);
    expect(p.done).toBeLessThan(3); // 被中途叫停，不是跑完
    expect(getTask(task.taskId)?.status).toBe("cancelled");
  });

  it("嵌入失败时**不动**旧向量（审查 MEDIUM：先清后 embed 会让文档同时失去 chunks 与向量）", async () => {
    const { embedTextsWithFallback } = await import("./vector-service");
    vi.mocked(embedTextsWithFallback).mockRejectedValueOnce(new Error("嵌入服务 502"));
    const { vectorEngine } = await import("./vector");
    const engine = vectorEngine as unknown as { deleteByDocumentId: ReturnType<typeof vi.fn> };
    const { indexDocumentById } = await import("./document-indexer");

    await expect(indexDocumentById(1)).rejects.toThrow("嵌入服务 502");
    expect(engine.deleteByDocumentId).not.toHaveBeenCalled();
  });

  it("重索引每篇文档都先清旧向量再写入（否则分块变少会留孤儿向量）", async () => {
    const task = createTask({ kind: "reindex" });
    startReindexAll(task.taskId);
    for (let i = 0; i < 60 && getReindexProgress().running; i += 1) await new Promise((r) => setTimeout(r, 50));

    const { vectorEngine } = await import("./vector");
    const engine = vectorEngine as unknown as { deleteByDocumentId: ReturnType<typeof vi.fn>; insertBatch: ReturnType<typeof vi.fn> };
    expect(engine.deleteByDocumentId).toHaveBeenCalledTimes(3); // 3 篇文档
    expect(engine.insertBatch).toHaveBeenCalledTimes(3);
    // 每一篇都必须是「先删后插」
    for (let i = 0; i < 3; i += 1) {
      expect(engine.deleteByDocumentId.mock.invocationCallOrder[i]).toBeLessThan(engine.insertBatch.mock.invocationCallOrder[i]);
    }
  });

  it("取消请求到达后循环停下：done 停在原地，任务 cancelled（不是 completed）", async () => {
    const task = createTask({ kind: "reindex" });
    requestCancel(task.taskId); // 循环开始前就取消 → 一个文档都不该索引
    startReindexAll(task.taskId);
    for (let i = 0; i < 60 && getReindexProgress().running; i += 1) await new Promise((r) => setTimeout(r, 50));

    const p = getReindexProgress();
    expect(p.done).toBe(0);
    expect(p.running).toBe(false);
    expect(getTask(task.taskId)?.status).toBe("cancelled");
  });
});
