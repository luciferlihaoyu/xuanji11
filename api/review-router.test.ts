import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import { eq } from "drizzle-orm";
import type { AuthInfo } from "./lib/auth";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./queries/connection", () => ({ getDb: vi.fn(), getRawDb: vi.fn() }));
vi.mock("./lib/audit", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("./lib/document-indexer", () => ({ tryIndexDocumentById: vi.fn(async () => ({ chunks: 3, skipped: false })) }));

import { getDb } from "./queries/connection";
import { reviewRouter } from "./review-router";
import { logAudit } from "./lib/audit";
import { tryIndexDocumentById } from "./lib/document-indexer";

function createDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE kb_review_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      documentId INTEGER, relatedDocumentId INTEGER,
      title TEXT NOT NULL, payload TEXT, confidence REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolverNote TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0, resolvedAt INTEGER
    );
    CREATE TABLE kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderId INTEGER, title TEXT NOT NULL, content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown', tags TEXT, metadata TEXT,
      createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER, deletedReason TEXT, mergedIntoId INTEGER
    );
  `);
  return drizzle(sqlite, { schema });
}

function caller(): ReturnType<typeof reviewRouter.createCaller> {
  return reviewRouter.createCaller({
    req: new Request("http://localhost:3000/"),
    resHeaders: new Headers(),
    user: { id: 1, unionId: "local_admin", name: "admin", email: null, avatar: null, role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignInAt: new Date() },
    auth: { type: "session", userId: 1 } as AuthInfo,
  } as never);
}

function seedQualityItem(db: ReturnType<typeof createDb>, docId: number, payload: Record<string, unknown>, createdAtMs = Date.now()): number {
  const res = db.insert(schema.kbReviewItems)
    .values({ kind: "quality", documentId: docId, title: "质量复核（55 分）：测试文档", payload, createdAt: new Date(createdAtMs) })
    .run() as unknown as { lastInsertRowid: number | bigint };
  return Number(res.lastInsertRowid);
}

function seedDoc(db: ReturnType<typeof createDb>, metadata: Record<string, unknown> | null): number {
  const res = db.insert(schema.kbDocuments)
    .values({ title: "测试文档", content: "c", format: "markdown", metadata: metadata ?? undefined, createdAt: new Date(0), updatedAt: new Date(0) })
    .run() as unknown as { lastInsertRowid: number | bigint };
  return Number(res.lastInsertRowid);
}

let db: ReturnType<typeof createDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createDb();
  vi.mocked(getDb).mockReturnValue(db as never);
});

describe("T3-02 quality 处置动作（approve 必须真执行，不做空操作档案柜）", () => {
  it("默认（keep）：清除 excludeFromDefaultSearch 标记，文档回归默认搜索", async () => {
    const docId = seedDoc(db, { quality: { score: 55, level: "review", issues: [] }, excludeFromDefaultSearch: true });
    const itemId = seedQualityItem(db, docId, { score: 55, level: "review", contentHash: "h1" });

    const r = await caller().resolve({ id: itemId, action: "approved" });
    expect(r.success).toBe(true);
    expect(r.actionResult).toEqual({ kept: docId });

    const [doc] = await db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, docId));
    const md = doc.metadata as Record<string, unknown>;
    expect(md.excludeFromDefaultSearch).toBeUndefined();
    expect(md.quality).toBeDefined(); // 评分快照保留

    const [item] = await db.select().from(schema.kbReviewItems).where(eq(schema.kbReviewItems.id, itemId));
    expect(item.status).toBe("approved");
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it("decision=exclude：打标退出默认搜索（人工确认排除）", async () => {
    const docId = seedDoc(db, { quality: { score: 55, level: "review", issues: [] } });
    const itemId = seedQualityItem(db, docId, { score: 55, level: "review", decision: "exclude", contentHash: "h1" });

    const r = await caller().resolve({ id: itemId, action: "approved" });
    expect(r.actionResult).toEqual({ excluded: docId });
    const [doc] = await db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, docId));
    expect((doc.metadata as Record<string, unknown>).excludeFromDefaultSearch).toBe(true);
  });

  it("decision=reindex：真调用索引器重建该文档索引", async () => {
    const docId = seedDoc(db, { quality: { score: 55, level: "review", issues: [] } });
    const itemId = seedQualityItem(db, docId, { score: 55, level: "review", decision: "reindex", contentHash: "h1" });

    const r = await caller().resolve({ id: itemId, action: "approved" });
    expect(tryIndexDocumentById).toHaveBeenCalledWith(docId);
    expect(r.actionResult).toMatchObject({ reindexed: docId, chunks: 3 });
  });

  it("rejected/ignored 不执行副作用（人工否定=不动文档）", async () => {
    const docId = seedDoc(db, { quality: { score: 55, level: "review", issues: [] }, excludeFromDefaultSearch: true });
    const itemId = seedQualityItem(db, docId, { score: 55, level: "review", contentHash: "h1" });

    const r = await caller().resolve({ id: itemId, action: "rejected" });
    expect(r.actionResult).toEqual({ skipped: true });
    const [doc] = await db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, docId));
    expect((doc.metadata as Record<string, unknown>).excludeFromDefaultSearch).toBe(true); // 原样未动
  });

  it("已处置项二次 resolve 不重复执行动作（already 短路）", async () => {
    const docId = seedDoc(db, { quality: { score: 55, level: "review", issues: [] } });
    const itemId = seedQualityItem(db, docId, { score: 55, level: "review", contentHash: "h1" });
    await caller().resolve({ id: itemId, action: "approved" });
    vi.mocked(tryIndexDocumentById).mockClear();

    const r2 = await caller().resolve({ id: itemId, action: "approved" });
    expect(r2).toEqual({ success: true, already: true });
  });

  it("回归护栏：dedup approve 仍是软删副本（quality 分支没吃掉既有行为）", async () => {
    const keepId = seedDoc(db, null);
    const dupId = seedDoc(db, null);
    const res = db.insert(schema.kbReviewItems)
      .values({ kind: "dedup", documentId: keepId, relatedDocumentId: dupId, title: "疑似重复", payload: { matchType: "exact_content" } })
      .run() as unknown as { lastInsertRowid: number | bigint };
    const r = await caller().resolve({ id: Number(res.lastInsertRowid), action: "approved" });
    expect(r.actionResult).toEqual({ softDeleted: dupId, kept: keepId });
    const [dup] = await db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, dupId));
    expect(dup.deletedAt).toBeTruthy();
    expect(dup.mergedIntoId).toBe(keepId);
  });
});

describe("T3-02 backlogStats（积压可见：数量 + 最老时长，不许再沉默 48 天）", () => {
  it("两类 pending：返回条数与最老 pending 秒龄", async () => {
    const now = Date.now();
    const docId = seedDoc(db, {});
    // dedup 一条 1 小时前，quality 两条（其中一条 30 天前）
    seedQualityItem(db, docId, { score: 55, contentHash: "a" }, now - 30 * 24 * 3600 * 1000);
    seedQualityItem(db, docId, { score: 60, contentHash: "b" }, now - 60 * 60 * 1000);
    db.insert(schema.kbReviewItems).values({ kind: "dedup", documentId: docId, relatedDocumentId: docId + 1, title: "d", payload: {}, createdAt: new Date(now - 2 * 3600 * 1000) }).run();
    // 已处置的不算积压
    db.insert(schema.kbReviewItems).values({ kind: "quality", documentId: docId, title: "done", payload: {}, status: "approved", createdAt: new Date(now - 90 * 24 * 3600 * 1000) }).run();

    const stats = await caller().backlogStats();
    const quality = stats.find((s) => s.kind === "quality")!;
    const dedup = stats.find((s) => s.kind === "dedup")!;
    expect(quality.pending).toBe(2);
    expect(quality.oldestPendingSeconds).toBeGreaterThanOrEqual(30 * 24 * 3600 - 5);
    expect(dedup.pending).toBe(1);
    expect(dedup.oldestPendingSeconds).toBeGreaterThanOrEqual(2 * 3600 - 5);
  });

  it("空队列 → 空数组（不是报错）", async () => {
    expect(await caller().backlogStats()).toEqual([]);
  });
});

describe("P2 dedup 处置护栏（碧霄 2026-11-14，43 条积压清理前的代码前提）", () => {
  it("副本早已软删：不重写它的 deletedAt/mergedIntoId，报告 alreadyDeleted", async () => {
    const keepId = seedDoc(db, null);
    const dupId = seedDoc(db, null);
    const DEAD_AT = 1_000_000; // 一个远古的删除时刻
    db.update(schema.kbDocuments).set({ deletedAt: new Date(DEAD_AT), deletedReason: "manual" })
      .where(eq(schema.kbDocuments.id, dupId)).run();
    const res = db.insert(schema.kbReviewItems)
      .values({ kind: "dedup", documentId: keepId, relatedDocumentId: dupId, title: "疑似重复（副本已死）", payload: {} })
      .run() as unknown as { lastInsertRowid: number | bigint };

    const r = await caller().resolve({ id: Number(res.lastInsertRowid), action: "approved" });

    expect(r.actionResult).toEqual({ alreadyDeleted: dupId, kept: keepId });
    const [dup] = await db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, dupId));
    expect((dup.deletedAt as unknown as Date).getTime()).toBe(DEAD_AT); // 现行代码会用 new Date() 覆盖真实删除历史
    expect(dup.mergedIntoId ?? null).toBeNull();                        // 死者不补写合并指针（历史就是历史）
  });

  it("保留篇已死、副本还活：拒绝 approve（照现有配置会净丢内容），条目留在 pending 等人工", async () => {
    const keepId = seedDoc(db, null);
    const dupId = seedDoc(db, null);
    db.update(schema.kbDocuments).set({ deletedAt: new Date(1_000), deletedReason: "manual" })
      .where(eq(schema.kbDocuments.id, keepId)).run();
    const res = db.insert(schema.kbReviewItems)
      .values({ kind: "dedup", documentId: keepId, relatedDocumentId: dupId, title: "疑似重复（保留方已死）", payload: {} })
      .run() as unknown as { lastInsertRowid: number | bigint };
    const itemId = Number(res.lastInsertRowid);

    await expect(caller().resolve({ id: itemId, action: "approved" })).rejects.toThrow(/保留/);

    const [dup] = await db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, dupId));
    expect(dup.deletedAt).toBeNull(); // 现行代码会把活的那份也软删 → 双死 = 内容净丢失
    const [item] = await db.select().from(schema.kbReviewItems).where(eq(schema.kbReviewItems.id, itemId));
    expect(item.status).toBe("pending");
  });

  it("保留指向的行已不存在的（被硬清）：拒绝 approve，不把副本软删进虚空合并（审查 c3）", async () => {
    const keepId = seedDoc(db, null);
    const dupId = seedDoc(db, null);
    db.delete(schema.kbDocuments).where(eq(schema.kbDocuments.id, keepId)).run(); // 条目插入前清除，无 FK 羁绊
    const res = db.insert(schema.kbReviewItems)
      .values({ kind: "dedup", documentId: keepId, relatedDocumentId: dupId, title: "疑似重复（保留方缺失）", payload: {} })
      .run() as unknown as { lastInsertRowid: number | bigint };
    const itemId = Number(res.lastInsertRowid);

    await expect(caller().resolve({ id: itemId, action: "approved" })).rejects.toThrow(/不存在|拒绝/);

    const [dup] = await db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, dupId));
    expect(dup.deletedAt).toBeNull(); // 现行代码：keepDoc undefined → 护栏静默放行 → 副本被软删且 mergedIntoId 指向不存在的文档
    expect(dup.mergedIntoId ?? null).toBeNull();
    const [item] = await db.select().from(schema.kbReviewItems).where(eq(schema.kbReviewItems.id, itemId));
    expect(item.status).toBe("pending");
  });
});
