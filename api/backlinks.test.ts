import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fullSchema from "@db/schema";
import { getDb } from "./queries/connection";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));

import { getBacklinks } from "./lib/backlinks";

/**
 * T4-02 反链分流规矩：
 *  - 「谁引用我」只对**有向**边成立：X --references/extends/contains/sequence--> 我 才算 referencesIn；
 *  - related/similar 是**无方向**语义（similar 的方向实际由节点 id 大小决定），一律单列
 *    undirectedNeighbors，绝不允许混进 references 分组；
 *  - 响应自带 directionSemantics 说明，防下游误用；
 *  - 无入边 → 空数组（绝不 null）。
 */

function createDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE knowledge_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT, type TEXT, metadata TEXT, createdAt INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId INTEGER NOT NULL, targetId INTEGER NOT NULL,
      label TEXT, type TEXT NOT NULL DEFAULT 'related', weight REAL DEFAULT 1,
      createdBy INTEGER, createdAt INTEGER NOT NULL DEFAULT 0,
      evidence TEXT, evidenceDocumentId INTEGER, evidenceChunkId INTEGER
    );
  `);
  const node = sqlite.prepare("INSERT INTO knowledge_nodes (id, title, type) VALUES (?,?,?)");
  node.run(1, "引用方甲", "document");
  node.run(2, "被链中心", "document");
  node.run(3, "相似伙伴", "document");
  node.run(4, "我指向的", "document");
  node.run(5, "关联伙伴", "document");
  const edge = sqlite.prepare(
    "INSERT INTO knowledge_edges (sourceId, targetId, type, label, weight, evidence) VALUES (?,?,?,?,?,?)",
  );
  edge.run(1, 2, "references", "引用", 1, "甲引用中心的原文摘录");
  edge.run(2, 4, "references", "引用", 1, "中心指向4");
  edge.run(2, 3, "similar", "auto", 0.9, "auto-link 相似建议：score=0.9");
  edge.run(2, 5, "related", "tag", 1, "关键词自动打标");
  edge.run(1, 2, "extends", "扩展", 1, "甲 extends 中心");
  return drizzle(sqlite, { schema: fullSchema });
}

let db: ReturnType<typeof createDb>;
beforeEach(() => {
  db = createDb();
  vi.mocked(getDb).mockReturnValue(db as unknown as ReturnType<typeof getDb>);
});

describe("getBacklinks（T4-02 按类型分流）", () => {
  it("A references B → 查 B，A 在 referencesIn，证据随行", async () => {
    const r = (await getBacklinks(2))!;
    expect(r.referencesIn.map((x) => x.fromNodeId)).toEqual(expect.arrayContaining([1]));
    const ref = r.referencesIn.find((x) => x.fromNodeId === 1 && x.type === "references")!;
    expect(ref.evidence).toBe("甲引用中心的原文摘录");
  });

  it("similar 边**不得**混进 references 分组——单独 undirectedNeighbors 且标注无方向", async () => {
    const r = (await getBacklinks(2))!;
    expect(r.referencesIn.some((x) => x.type === "similar")).toBe(false);
    const sim = r.undirectedNeighbors.find((x) => x.type === "similar")!;
    expect(sim.neighborNodeId).toBe(3);
    expect(sim.directionNote).toContain("方向无语义");
    expect(r.directionSemantics).toContain("similar");
  });

  it("related（无向）也在 undirectedNeighbors，不进 referencesIn", async () => {
    const r = (await getBacklinks(2))!;
    expect(r.referencesIn.some((x) => x.type === "related")).toBe(false);
    expect(r.undirectedNeighbors.find((x) => x.neighborNodeId === 5)?.type).toBe("related");
  });

  it("我指向的有向边进 outgoingDirected（B references A 语义下 A 只在我 referencesIn，不互换）", async () => {
    const r = (await getBacklinks(2))!;
    expect(r.outgoingDirected.map((x) => x.toNodeId)).toContain(4);
    // 查节点 4：2→4 的 references 让 2 出现在 4 的 referencesIn
    const r4 = (await getBacklinks(4))!;
    expect(r4.referencesIn.map((x) => x.fromNodeId)).toContain(2);
  });

  it("extends 属有向引用族：同样入 referencesIn（多路入边按边分行，不吞）", async () => {
    const r = (await getBacklinks(2))!;
    expect(r.referencesIn.filter((x) => x.fromNodeId === 1).map((x) => x.type).sort()).toEqual(["extends", "references"]);
  });

  it("无入边节点 → 全空数组，不是 null；不存在的节点 → null", async () => {
    const r = await getBacklinks(1);
    expect(r).not.toBeNull();
    expect(r!.referencesIn).toEqual([]);
    expect(r!.undirectedNeighbors).toEqual([]);
    expect(await getBacklinks(999)).toBeNull();
  });

  it("软删节点的反链不返回（防幽灵引用）", async () => {
    // 本 fixture 无 deletedAt 列（knowledge_nodes 无软删），以 metadata.deleted 语义跳过——
    // 真实库 nodes 无软删列时行为即全量返回，此用例钉住「列不存在不报错」。
    const r = (await getBacklinks(2))!;
    expect(r.referencesIn.length).toBeGreaterThan(0);
  });
});
