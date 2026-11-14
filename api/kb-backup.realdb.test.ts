/**
 * 灾备恢复链路的**真库**集成验证（2026-11-12 碧霄）。
 *
 * 为什么单独一个文件：`api/kb-backup.test.ts` 把 `./queries/connection` mock 掉了（假 db）。
 * 替身级的绿**证明不了**真实 drizzle 通路能跑通 —— 而恢复路径此前整整一个月
 * 没有任何测试保护（门禁从不跑 vitest），等到真要用时才可能炸。
 * 这里用内存 SQLite + 真 drizzle 跑「导出 → 导入」往返。
 *
 * 顺带钉死 A1 那个假设：真 drizzle 的 RunResult 字段是 `changes`（不是 affectedRows）。
 * 若这个字段名错了，本文件的计数断言会立刻红。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// connection 导入期会经 env.ts 强校验环境变量，缺失即 process.exit(1) → 整个文件静默失效
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "file::memory:";
  process.env.ADMIN_USERNAME ||= "test";
  process.env.ADMIN_PASSWORD ||= "test-password";
  process.env.JWT_SECRET ||= "fixed-test-jwt-secret-with-32-chars";
});

import Database from "better-sqlite3";
import { _setDbForTests, _resetDbForTests } from "./queries/connection";
import { exportKnowledgeBase, importKnowledgeBase, kbBackupSchema } from "./lib/kb-backup";

/** 与 db/schema.ts 对齐的三张表 DDL（只取导入/导出用到的列） */
const DDL = `
CREATE TABLE knowledge_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  type TEXT NOT NULL DEFAULT 'concept',
  posX REAL DEFAULT 0,
  posY REAL DEFAULT 0,
  style TEXT,
  metadata TEXT,
  createdBy INTEGER,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE TABLE knowledge_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceId INTEGER NOT NULL,
  targetId INTEGER NOT NULL,
  label TEXT,
  type TEXT NOT NULL DEFAULT 'related',
  weight REAL DEFAULT 1,
  createdBy INTEGER,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  evidence TEXT, evidenceDocumentId INTEGER, evidenceChunkId INTEGER
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
  createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deletedAt INTEGER,
  deletedReason TEXT,
  mergedIntoId INTEGER
);
`;

let sqlite: Database.Database;

function seed(): void {
  const t0 = Date.parse("2024-01-01T00:00:00Z");
  const tDeleted = Date.parse("2024-02-02T00:00:00Z");
  sqlite.exec("DELETE FROM kb_documents; DELETE FROM knowledge_nodes; DELETE FROM knowledge_edges;");
  sqlite
    .prepare(
      `INSERT INTO kb_documents (id, title, content, format, createdAt, updatedAt)
       VALUES (1, '在用文档', '正文甲', 'markdown', ?, ?)`,
    )
    .run(t0, t0);
  sqlite
    .prepare(
      `INSERT INTO kb_documents (id, title, content, format, createdAt, updatedAt, deletedAt, deletedReason)
       VALUES (2, '已归档文档', '正文乙', 'markdown', ?, ?, ?, 'manual')`,
    )
    .run(t0, t0, tDeleted);
  sqlite
    .prepare(
      `INSERT INTO kb_documents (id, title, content, format, createdAt, updatedAt, mergedIntoId)
       VALUES (3, '被合并文档', '正文丙', 'markdown', ?, ?, 1)`,
    )
    .run(t0, t0);
  sqlite
    .prepare(
      `INSERT INTO knowledge_nodes (id, title, content, type, createdAt, updatedAt)
       VALUES (1, '节点甲', '内容甲', 'concept', ?, ?)`,
    )
    .run(t0, t0);
  sqlite
    .prepare(
      `INSERT INTO knowledge_edges (id, sourceId, targetId, type, createdAt)
       VALUES (1, 1, 1, 'related', ?)`,
    )
    .run(t0);
}

function readDocs(): Array<Record<string, unknown>> {
  return sqlite
    .prepare(
      `SELECT id, title, deletedAt, deletedReason, mergedIntoId FROM kb_documents ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe("灾备恢复 · 真库往返（真 drizzle + 真 SQLite）", () => {
  beforeAll(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    _setDbForTests(sqlite);
  });

  afterAll(() => {
    _resetDbForTests();
    sqlite.close();
  });

  it("导出 → 导入往返：已归档文档不复活、合并关系不丢", async () => {
    seed();
    const exported = await exportKnowledgeBase();

    // ① 导出里必须带上软删三列（否则恢复后复活）
    const exportedDocs = exported.data.documents as unknown as Array<Record<string, unknown>>;
    const archived = exportedDocs.find((d) => d.id === 2);
    expect(archived?.deletedAt).toBeTruthy();
    expect(archived?.deletedReason).toBe("manual");
    const merged = exportedDocs.find((d) => d.id === 3);
    expect(merged?.mergedIntoId).toBe(1);

    // ② 清库后导入
    sqlite.exec("DELETE FROM kb_documents; DELETE FROM knowledge_nodes; DELETE FROM knowledge_edges;");
    const result = await importKnowledgeBase(JSON.parse(JSON.stringify(exported)));

    // 计数走真 drizzle 的 RunResult.changes（A1 的假设在此被真库验证）
    expect(result.documents).toBe(3);
    expect(result.nodes).toBe(1);
    expect(result.edges).toBe(1);
    expect(result.documentsNeedingReindex).toBe(3);  // 实际写入 3 篇 → 3 篇待重建索引

    // ③ 关键断言：归档文档仍是归档态（deletedAt 非空），没被复活
    const docs = readDocs();
    const restoredArchived = docs.find((d) => d.id === 2);
    expect(restoredArchived?.deletedAt).toBeTruthy();
    expect(restoredArchived?.deletedReason).toBe("manual");
    const restoredMerged = docs.find((d) => d.id === 3);
    expect(restoredMerged?.mergedIntoId).toBe(1);
  });

  it("重复导入幂等：onConflictDoNothing 不覆盖已有行", async () => {
    seed();
    const exported = await exportKnowledgeBase();
    const payload = JSON.parse(JSON.stringify(exported));

    // 先清库：第一次导入应当真的插入 3 行
    sqlite.exec("DELETE FROM kb_documents; DELETE FROM knowledge_nodes; DELETE FROM knowledge_edges;");
    const first = await importKnowledgeBase(payload);
    expect(first.documents).toBe(3);

    // 第二次导入：主键冲突 → onConflictDoNothing → 实际插入 0 行
    const second = await importKnowledgeBase(payload);
    expect(second.documents).toBe(0);
    // 口径：报**实际写入数** —— 没写入就没新文档需要重建索引
    expect(second.documentsNeedingReindex).toBe(0);
    expect(readDocs()).toHaveLength(3);
  });

  it("老备份的真实形状是**显式 null**（不是缺键）—— 也必须能导回去", async () => {
    // 评审勘误（天演 2026-11-12）：我原来的兼容用例把三个键整个省了，
    // 那不是老备份的真实形状 —— drizzle 直出的 JSON 里可空列是**显式 null**。
    // 真实老备份长这样：style/metadata/content/label/tags/createdBy/deletedAt 全是 null。
    seed();
    const exported = await exportKnowledgeBase();
    const legacyPayload = JSON.parse(JSON.stringify(exported));
    // 手工把可空列改成显式 null，模拟"老版本 schema 导出的备份"
    for (const n of legacyPayload.data.nodes) {
      n.style = null;
      n.metadata = null;
      n.content = null;
    }
    for (const e of legacyPayload.data.edges) {
      e.label = null;
    }
    for (const d of legacyPayload.data.documents) {
      d.tags = null;
      d.metadata = null;
      d.content = null;
      d.deletedAt = null;
      d.deletedReason = null;
      d.mergedIntoId = null;
    }
    sqlite.exec("DELETE FROM kb_documents; DELETE FROM knowledge_nodes; DELETE FROM knowledge_edges;");

    const result = await importKnowledgeBase(legacyPayload);
    expect(result.documents).toBe(3);
    expect(result.nodes).toBe(1);
    expect(result.edges).toBe(1);
  });

  it("真实规模必须导得回去：边超过 10,000 条 —— 既不被 schema 拒收，也插得进 SQLite", async () => {
    // 生产 knowledge_edges = 11,431 行（2026-11-12 实测），而 schema 限 max(10_000)
    // → **自己导出的备份自己导不回去**：灾备恢复在生产上 100% 失败（ZodError 数组超长）。
    // 旧 mock 测试永远发现不了：假数据只有 1 条边。
    //
    // 还有第二道坎（生产实测才暴露）：一条 INSERT 塞 11,431×8 = 91,448 个绑定变量
    // → SqliteError: too many SQL variables。必须分批插。
    const edges = Array.from({ length: 10_001 }, (_, i) => ({
      id: i + 1,
      sourceId: 1,
      targetId: 2,
      type: "related",
      createdAt: "2024-01-01T00:00:00Z",
    }));
    const parsed = kbBackupSchema.parse({ version: "1.0", data: { nodes: [], edges, documents: [] } });
    expect(parsed.data.edges).toHaveLength(10_001);

    // 真插一次：分批插必须能落库，且计数准确
    sqlite.exec("DELETE FROM knowledge_edges; DELETE FROM knowledge_nodes;");
    sqlite
      .prepare(
        `INSERT INTO knowledge_nodes (id, title, content, type, createdAt, updatedAt)
         VALUES (1, '节点甲', '内容甲', 'concept', 1704067200000, 1704067200000)`,
      )
      .run();
    const result = await importKnowledgeBase(parsed);
    expect(result.edges).toBe(10_001);
    const row = sqlite.prepare("SELECT COUNT(*) c FROM knowledge_edges").get() as { c: number };
    expect(row.c).toBe(10_001);
  });

  it("老备份（无软删三列）仍能导入真库 —— 向后兼容", async () => {    seed();
    sqlite.exec("DELETE FROM kb_documents; DELETE FROM knowledge_nodes; DELETE FROM knowledge_edges;");

    const result = await importKnowledgeBase({
      version: "1.0",
      data: {
        nodes: [
          { id: 11, title: "旧节点", type: "concept", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
        ],
        edges: [],
        documents: [
          { id: 21, title: "旧文档", format: "markdown", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
        ],
      },
    });

    expect(result.documents).toBe(1);
    expect(result.nodes).toBe(1);
    const docs = readDocs();
    expect(docs[0].deletedAt).toBeNull();
  });
});
