import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fullSchema from "@db/schema";
import { getDb } from "../queries/connection";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));
vi.mock("./hybrid-search", () => ({ executeHybridSearch: vi.fn() }));
vi.mock("./document-indexer", () => ({
  tryIndexDocumentById: vi.fn(async () => ({ chunks: 0, skipped: true, failed: false })),
  chunkText: vi.fn(() => []),
}));
vi.mock("./ingestion", () => ({ createIngestionJob: vi.fn() }));

import { linkArtifact, linkArtifactInputSchema } from "./connector-actions";

/** 与 schema 对齐的最小内存库（照抄本仓既有测试写法，见 ingestion.test.ts） */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderId INTEGER, title TEXT NOT NULL, content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown', tags TEXT, metadata TEXT,
      createdBy INTEGER, createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0, deletedAt INTEGER,
      deletedReason TEXT, mergedIntoId INTEGER
    );
    CREATE TABLE knowledge_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, content TEXT,
      type TEXT NOT NULL DEFAULT 'concept',
      posX REAL DEFAULT 0, posY REAL DEFAULT 0,
      style TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId INTEGER NOT NULL, targetId INTEGER NOT NULL,
      label TEXT, type TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0,
    
      evidence TEXT,
      evidenceDocumentId INTEGER,
      evidenceChunkId INTEGER
    );
  `);
  return sqlite;
}

describe("linkArtifact 的建边命名空间（T1-03）", () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = createTestDb();
    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
    // 场景文档：kb_documents id=7；对应图谱节点 id=1（metadata.documentId 存**字符串**——writeTaskMemory 形状）
    raw.prepare("INSERT INTO kb_documents (id, title) VALUES (7, '任务记忆甲')").run();
    raw
      .prepare(
        "INSERT INTO knowledge_nodes (id, title, type, metadata) VALUES (1, '任务记忆甲', 'document', ?)",
      )
      .run(JSON.stringify({ sourceSystem: "tiangong", documentId: "7" }));
  });

  it("文档有对应节点 → sourceId 必须是**节点 id**，不是 kb_documents.id", async () => {
    const input = linkArtifactInputSchema.parse({
      taskId: "TG-TEST",
      documentId: 7,
      artifact: { artifactRef: "art://x/1" },
    });
    const result = await linkArtifact(input);
    // 修复点：此前 sourceId=documentId(7)——FK 指向 knowledge_nodes.id，7 号节点并不存在
    const edge = raw
      .prepare("SELECT sourceId, targetId, type FROM knowledge_edges WHERE id = ?")
      .get(result.edgeId) as { sourceId: number; targetId: number; type: string };
    expect(edge.sourceId).toBe(1); // 节点 id，不是文档 id 7
    expect(edge.targetId).toBe(result.nodeId);
    expect(edge.type).toBe("references");
    // 两端都必须真实存在于 knowledge_nodes（FK 语义）
    const src = raw.prepare("SELECT id FROM knowledge_nodes WHERE id = ?").get(edge.sourceId);
    const dst = raw.prepare("SELECT id FROM knowledge_nodes WHERE id = ?").get(edge.targetId);
    expect(src).toBeTruthy();
    expect(dst).toBeTruthy();
  });

  it("文档在但节点缺 → 自动补建 document 节点再建边（此前该路从未成功过）", async () => {
    raw.prepare("INSERT INTO kb_documents (id, title) VALUES (9, '任务记忆乙')").run();
    const input = linkArtifactInputSchema.parse({
      taskId: "TG-TEST",
      documentId: 9,
      artifact: { artifactRef: "art://x/2" },
    });
    const result = await linkArtifact(input);
    expect(result.linked).toBe(true);
    // 返回值 nodeId 是 artifact 节点；补建的 document 节点用「唯一出处」口径查
    const docNode = raw
      .prepare(
        "SELECT id, type, metadata FROM knowledge_nodes WHERE type='document' AND json_extract(metadata,'$.documentId')='9'",
      )
      .get() as { id: number; type: string; metadata: string };
    expect(docNode).toBeTruthy();
    expect(docNode.type).toBe("document");
    const edge = raw
      .prepare("SELECT sourceId FROM knowledge_edges WHERE id = ?")
      .get(result.edgeId) as { sourceId: number };
    expect(edge.sourceId).toBe(docNode.id);
  });

  it("文档本身不存在 → 抛错且不写任何边（此前会静默写一条悬挂边）", async () => {
    const input = linkArtifactInputSchema.parse({
      taskId: "TG-TEST",
      documentId: 999,
      artifact: { artifactRef: "art://x/3" },
    });
    await expect(linkArtifact(input)).rejects.toThrow(/999/);
    const count = raw.prepare("SELECT count(*) n FROM knowledge_edges").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
