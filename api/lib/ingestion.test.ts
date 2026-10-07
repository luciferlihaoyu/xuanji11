/**
 * ingestFile 的归档口径（2026-10-01）。
 *
 * 文档该落进哪个知识库文件夹，由调用方传入的 folderId 决定 —— 此前 docValues.folderId
 * 被**写死为 null**，于是数据源同步进来的内容全部悬空、无法按源归档（用户诉求：
 * 「根据对应的数据源新建一个文件夹，对应数据源的数据资料都放进自己对应的文件夹」）。
 * 本文件钉住两条：传则落、不传则保持 null（既有调用方行为不变）。
 */
import * as fs from "fs";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fullSchema from "@db/schema";
import { getDb } from "../queries/connection";
import { ingestFile } from "./ingestion";

vi.hoisted(() => {
  // env.ts 对必填变量做存在性校验，缺了就 process.exit(1)（本仓既有测试都在 hoisted 里补）
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
  process.env.UPLOAD_DIR = `${process.env.TMPDIR || "/tmp"}/xuanji-ingest-test-${process.pid}`;
});

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));

// vectorEngine 是 Zvec 原生二进制，本容器加载不了；连同 vector-service 一起 mock（仓库既有测试惯例）
vi.mock("./vector", () => ({
  vectorEngine: { size: 0, indexDocumentChunks: vi.fn(async () => 0) },
  initializeZvec: vi.fn(),
}));

vi.mock("./vector-service", () => ({
  listCollections: vi.fn(),
  addDocumentsToCollection: vi.fn(),
  deleteCollection: vi.fn(),
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
  getStats: vi.fn(),
  initializeZvec: vi.fn(),
  vectorEngine: { size: 0 },
}));

/** 与 schema 对齐的最小内存库；用真实 drizzle 实例（照抄本仓既有测试写法）。 */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE ingestion_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceType TEXT NOT NULL, sourceId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      totalItems INTEGER DEFAULT 0, processedItems INTEGER DEFAULT 0, failedItems INTEGER DEFAULT 0,
      error TEXT, retryCount INTEGER DEFAULT 0, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ingestion_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId INTEGER NOT NULL, externalId TEXT, name TEXT NOT NULL, mimeType TEXT, size INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT,
      sourceUrl TEXT, storagePath TEXT, documentId INTEGER, metadata TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderId INTEGER,
      title TEXT NOT NULL,
      content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown',
      tags TEXT,
      metadata TEXT,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0,
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
      createdAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      type TEXT NOT NULL DEFAULT 'concept',
      posX REAL DEFAULT 0, posY REAL DEFAULT 0,
      style TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
  `);
  return sqlite;
}

function writeTempMarkdown(name: string, content: string): string {
  const dir = `${process.env.TMPDIR || "/tmp"}/xuanji-ingest-test-${process.pid}`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

describe("ingestFile 的文件夹归档口径", () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = createTestDb();
    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
  });

  it("传 folderId → 文档落进该文件夹（数据源按源归档的地基）", async () => {
    const file = writeTempMarkdown("归档-甲.md", "# 甲文\n\n这是正文内容。");
    const { documentId } = await ingestFile({
      sourceType: "datasource",
      fileName: "归档-甲.md",
      mimeType: "text/markdown",
      size: fs.statSync(file).size,
      storagePath: file,
      folderId: 42,
    });

    const row = raw
      .prepare("SELECT folderId, title FROM kb_documents WHERE id = ?")
      .get(documentId) as { folderId: number | null; title: string } | undefined;
    expect(row?.folderId).toBe(42);
  });

  it("不传 folderId → 保持 null（既有调用方行为不变，向后兼容）", async () => {
    const file = writeTempMarkdown("归档-乙.md", "# 乙文\n\n这是正文内容。");
    const { documentId } = await ingestFile({
      sourceType: "upload",
      fileName: "归档-乙.md",
      mimeType: "text/markdown",
      size: fs.statSync(file).size,
      storagePath: file,
    });

    const row = raw
      .prepare("SELECT folderId FROM kb_documents WHERE id = ?")
      .get(documentId) as { folderId: number | null } | undefined;
    expect(row?.folderId).toBeNull();
  });
});
