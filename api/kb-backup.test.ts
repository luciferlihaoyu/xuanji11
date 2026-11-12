import { describe, expect, it, vi } from "vitest";
import type { User, KnowledgeNode, KnowledgeEdge, KbDocument } from "@db/schema";
import { knowledgeNodes, knowledgeEdges, kbDocuments } from "@db/schema";
import type { AuthInfo } from "./lib/auth";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./lib/auth", async () => {
  const actual = await vi.importActual<typeof import("./lib/auth")>("./lib/auth");
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
  };
});

vi.mock("./local-auth", () => ({
  authenticateLocalRequest: vi.fn(),
}));

vi.mock("./lib/vector-service", () => ({
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
  listCollections: vi.fn(),
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  getCollectionStats: vi.fn(),
  addDocumentsToCollection: vi.fn(),
  getStats: vi.fn(),
}));

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";

function fakeUser(): User {
  return {
    id: 1,
    unionId: "local_admin",
    name: "admin",
    email: null,
    avatar: null,
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignInAt: new Date(),
  };
}

function readAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["knowledge:read"] };
}

function writeAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["knowledge:read", "knowledge:write"] };
}

interface FakeDbOptions {
  readonly nodes?: readonly KnowledgeNode[];
  readonly edges?: readonly KnowledgeEdge[];
  readonly documents?: readonly KbDocument[];
  readonly insertAffectedRows?: number;
}

function createFakeDb(options: FakeDbOptions = {}) {
  const nodes = options.nodes ?? [];
  const edges = options.edges ?? [];
  const documents = options.documents ?? [];
  const insertAffectedRows = options.insertAffectedRows ?? 0;
  // 记录每次 insert 的表与行：让"恢复会不会复活已删文档"这类问题有可断言的落点
  const inserted: Array<{ table: unknown; rows: unknown[] }> = [];

  return {
    inserted,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        if (table === knowledgeNodes) return Promise.resolve(nodes);
        if (table === knowledgeEdges) return Promise.resolve(edges);
        if (table === kbDocuments) return Promise.resolve(documents);
        return Promise.resolve([]);
      }),
    })),
    // drizzle **现行**链式 API：insert(table).values(rows).onConflictDoNothing() → RunResult{changes}
    // 生产代码正是这么调的：
    //   api/lib/kb-backup.ts:124  await db.insert(t).values(rows).onConflictDoNothing() → 读 result.changes
    //   api/lib/audit.ts:31        await db.insert(t).values({...})                   → 直接 await values()
    // 旧替身是古早的 .ignore().values() 形状、且返回数组 [{affectedRows}]（真 drizzle 是 {changes}），
    // 于是 2026-10 起就与生产漂移：这条测试红了整整一个月没人发现（门禁从不跑 vitest）。
    // 现在 values() 返回"既是 Promise 又带 onConflictDoNothing"的对象，两种调用形状都支持。
    insert: vi.fn((table: unknown) => {
      const values = vi.fn((rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        inserted.push({ table, rows: list });
        // changes 必须**忠实**于真 drizzle：= 实际写入行数（真库已实证，见 kb-backup.realdb.test.ts）
        // 固定写死一个常数会让"导入 N 篇"的计数断言失去意义。
        const changes = insertAffectedRows > 0 ? list.length : 0;
        return Object.assign(Promise.resolve({ changes }), {
          onConflictDoNothing: vi.fn(() => Promise.resolve({ changes })),
        });
      });
      return { values };
    }),
  };
}

function sampleNode(): KnowledgeNode {
  return {
    id: 1,
    title: "Sample Node",
    content: "content",
    type: "concept",
    posX: 0,
    posY: 0,
    style: null,
    metadata: null,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function sampleEdge(): KnowledgeEdge {
  return {
    id: 1,
    sourceId: 1,
    targetId: 2,
    label: "relates",
    type: "related",
    weight: 1,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function sampleDocument(): KbDocument {
  return {
    id: 1,
    folderId: null,
    title: "Sample Doc",
    content: "doc content",
    format: "markdown",
    tags: null,
    metadata: null,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    deletedReason: null,
    mergedIntoId: null,
  };
}

describe("kb-backup core", () => {
  it("exports all knowledge base data", async () => {
    const { exportKnowledgeBase } = await import("./lib/kb-backup");
    const node = sampleNode();
    const edge = sampleEdge();
    const doc = sampleDocument();
    vi.mocked(getDb).mockReturnValue(createFakeDb({ nodes: [node], edges: [edge], documents: [doc] }) as never);

    const result = await exportKnowledgeBase();

    expect(result.version).toBe("1.0");
    expect(result.data.nodes).toEqual([node]);
    expect(result.data.edges).toEqual([edge]);
    expect(result.data.documents).toEqual([doc]);
    expect(result.exportedAt).toBeDefined();
  });

  it("imports valid backup data and returns counts", async () => {
    const { importKnowledgeBase } = await import("./lib/kb-backup");
    const db = createFakeDb({ insertAffectedRows: 1 });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await importKnowledgeBase({
      version: "1.0",
      data: {
        nodes: [{ id: 1, title: "Node", type: "concept", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }],
        edges: [{ id: 1, sourceId: 1, targetId: 2, type: "related", createdAt: "2024-01-01T00:00:00Z" }],
        documents: [{ id: 1, title: "Doc", format: "markdown", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }],
      },
    });

    expect(result.nodes).toBe(1);
    expect(result.edges).toBe(1);
    expect(result.documents).toBe(1);
    expect(db.insert).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid backup data", async () => {
    const { importKnowledgeBase } = await import("./lib/kb-backup");
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);

    await expect(importKnowledgeBase({ version: "1.0" })).rejects.toBeInstanceOf(Error);
  });

  // 2026-11-12 碧霄（B1 修）：备份 schema 缺 deletedAt/deletedReason/mergedIntoId，
  // 而 zod 对未声明键**默认剥离** → 恢复时 deletedAt 落 NULL → 已归档文档复活、合并关系丢失。
  // 生产库当时软删文档 0 条 → 属潜伏缺陷（不是正在流血），但恢复路径本就该有测试保护。
  it("恢复不复活已删文档：软删三列必须随备份往返", async () => {
    const { importKnowledgeBase } = await import("./lib/kb-backup");
    const db = createFakeDb({ insertAffectedRows: 1 });
    vi.mocked(getDb).mockReturnValue(db as never);

    await importKnowledgeBase({
      version: "1.0",
      data: {
        nodes: [],
        edges: [],
        documents: [
          {
            id: 7,
            title: "已归档文档",
            format: "markdown",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
            deletedAt: "2024-02-02T00:00:00Z",
            deletedReason: "manual",
            mergedIntoId: 3,
          },
        ],
      },
    });

    const docInsert = db.inserted.find((x) => x.table === kbDocuments);
    expect(docInsert).toBeDefined();
    const row = docInsert!.rows[0] as Record<string, unknown>;
    // 软删标记与合并关系必须原样落库（复活 = deletedAt 丢成 NULL）
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.deletedReason).toBe("manual");
    expect(row.mergedIntoId).toBe(3);
  });

  it("旧备份（无软删三列）仍可导入 —— 向后兼容", async () => {
    const { importKnowledgeBase } = await import("./lib/kb-backup");
    const db = createFakeDb({ insertAffectedRows: 1 });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await importKnowledgeBase({
      version: "1.0",
      data: {
        nodes: [],
        edges: [],
        documents: [
          { id: 8, title: "老备份文档", format: "markdown", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
        ],
      },
    });

    expect(result.documents).toBe(1);
    const docInsert = db.inserted.find((x) => x.table === kbDocuments);
    expect((docInsert!.rows[0] as Record<string, unknown>).deletedAt).toBeNull();
  });

  it("恢复不还原索引 → 明说有多少文档需要重建索引（不偷偷触发全量回填）", async () => {
    const { importKnowledgeBase } = await import("./lib/kb-backup");
    const db = createFakeDb({ insertAffectedRows: 1 });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await importKnowledgeBase({
      version: "1.0",
      data: {
        nodes: [],
        edges: [],
        documents: [
          { id: 9, title: "A", format: "markdown", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
          { id: 10, title: "B", format: "markdown", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
        ],
      },
    });

    // 恢复只还原 nodes/edges/documents（不含 chunks/向量/FTS）→ 这些文档还搜不到
    expect(result.documentsNeedingReindex).toBe(2);
  });
});

describe("kb-backup REST API", () => {
  it("rejects unauthenticated export", async () => {
    const { kbBackupRouter } = await import("./kb-backup-router");
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);

    const res = await kbBackupRouter.request("/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Authentication required" });
  });

  it("exports with knowledge:read scope", async () => {
    const { kbBackupRouter } = await import("./kb-backup-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    const node = sampleNode();
    vi.mocked(getDb).mockReturnValue(createFakeDb({ nodes: [node] }) as never);

    const res = await kbBackupRouter.request("/export", { method: "POST" });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { nodes: unknown[] } };
    expect(json.data.nodes).toEqual([
      { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() },
    ]);
  });

  it("forbids import without knowledge:write", async () => {
    const { kbBackupRouter } = await import("./kb-backup-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);

    const res = await kbBackupRouter.request("/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "1.0", data: { nodes: [], edges: [], documents: [] } }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("imports with knowledge:write scope", async () => {
    const { kbBackupRouter } = await import("./kb-backup-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb({ insertAffectedRows: 1 }) as never);

    const res = await kbBackupRouter.request("/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0",
        data: {
          nodes: [{ id: 1, title: "Node", type: "concept", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }],
          edges: [],
          documents: [],
        },
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { nodes: number };
    expect(json.nodes).toBe(1);
  });

  it("returns 400 for invalid import body", async () => {
    const { kbBackupRouter } = await import("./kb-backup-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);

    const res = await kbBackupRouter.request("/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "1.0" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });
});
