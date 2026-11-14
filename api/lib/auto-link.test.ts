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
vi.mock("./vector-service", () => ({
  // 确定性向量：节点 1、2 同向（cos=1），节点 3 正交（cos=0）
  embedTextsWithFallback: vi.fn(async (texts: string[]) =>
    texts.map((_, i) => (i < 2 ? [1, 0] : [0, 1]))),
}));

import { autoLinkEdgesCore } from "./auto-link";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE knowledge_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, content TEXT, type TEXT NOT NULL DEFAULT 'concept',
      posX REAL DEFAULT 0, posY REAL DEFAULT 0, style TEXT, metadata TEXT,
      createdBy INTEGER, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId INTEGER NOT NULL, targetId INTEGER NOT NULL,
      label TEXT, type TEXT NOT NULL DEFAULT 'related', weight REAL DEFAULT 1,
      createdBy INTEGER, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      evidence TEXT, evidenceDocumentId INTEGER, evidenceChunkId INTEGER
    );
  `);
  sqlite
    .prepare("INSERT INTO knowledge_nodes (id, title, content, type) VALUES (?,?,?,?)")
    .run(1, "库存服务设计", "本文说明库存服务的扣减与回滚流程。", "document");
  sqlite
    .prepare("INSERT INTO knowledge_nodes (id, title, content, type) VALUES (?,?,?,?)")
    .run(2, "服务治理", "本文讨论服务治理的三个层次。", "document");
  sqlite
    .prepare("INSERT INTO knowledge_nodes (id, title, content, type) VALUES (?,?,?,?)")
    .run(3, "无关主题", "咖啡拉花入门。", "concept");
  return drizzle(sqlite, { schema: fullSchema });
}

let db: ReturnType<typeof createTestDb>;
let raw: Database.Database;
beforeEach(() => {
  db = createTestDb();
  raw = (db as unknown as { $client: Database.Database }).$client;
  vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
});

describe("auto-link T4-01：similar 边必须带证据经 edge-writer 落库", () => {
  it("dryRun 只预览，库里一行都不多", async () => {
    const r = await autoLinkEdgesCore({ threshold: 0.5, maxPerNode: 5, dryRun: true });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(raw.prepare("SELECT COUNT(*) c FROM knowledge_edges").get()).toEqual({ c: 0 });
  });

  it("落库边：evidence 非空，含 score 与依据短语（共享短语或目标首句），type=similar", async () => {
    await autoLinkEdgesCore({ threshold: 0.5, maxPerNode: 5, dryRun: false });
    const edges = raw.prepare("SELECT sourceId, targetId, type, evidence, label FROM knowledge_edges").all() as Array<{
      sourceId: number; targetId: number; type: string; evidence: string; label: string;
    }>;
    expect(edges).toHaveLength(1); // 只有 1↔2；3 正交不成边
    const e = edges[0];
    expect([e.sourceId, e.targetId, e.type, e.label]).toEqual([1, 2, "similar", "auto"]);
    expect(e.evidence).toContain("auto-link 相似建议");
    expect(e.evidence).toContain("score=");
    expect(e.evidence.includes("共享短语「") || e.evidence.includes("目标首句「")).toBe(true);
  });

  it("已存在 1↔2 边（任意方向）→ 不重复建", async () => {
    raw.prepare("INSERT INTO knowledge_edges (sourceId, targetId, type, evidence) VALUES (?,?,?,?)").run(2, 1, "related", "旧边");
    const r = await autoLinkEdgesCore({ threshold: 0.5, maxPerNode: 5, dryRun: false });
    expect(r.created).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) c FROM knowledge_edges").get()).toEqual({ c: 1 });
  });

  it("threshold 抬高到超过相似度 → 无候选无落库", async () => {
    const r = await autoLinkEdgesCore({ threshold: 1.5, maxPerNode: 5, dryRun: false });
    expect(r.created).toBe(0);
    expect(r.totalCandidates).toBe(0);
  });
});
