/**
 * t15 —— `ingestion.getItemsByUploadedFileId` 的 JSON 数字 vs TEXT 比较缺陷。
 *
 * 背景（与 t14 的同款事故，见 api/datasource-router.ts:294 的注释与
 * api/lib/document-node-match.ts 的 2026-09-22 线上实录）：
 *   `api/lib/ingestion.ts` 落库时写的是 `metadata: { ..., uploadedFileId: uploadedFileId ?? null }`，
 *   `uploadedFileId` 是 **JS number** → `JSON.stringify` 出来是 **JSON 数字**。
 *   SQLite 3.38+ 的 `->>`（以及 `json_extract`）会把 JSON 值转成**对应存储类**的 SQL 值
 *   （JSON number → SQL INTEGER），而查询侧写的是 `${String(id)}`（better-sqlite3 按 TEXT 绑定）。
 *   SQLite **不做 INTEGER↔TEXT 的隐式相等** → 这条 where 对任何真实入库行**恒为假** →
 *   查询永远返回空数组（"这个上传文件入库过吗"永远是"没有"）。
 *
 * 为什么用真内存 SQLite 而不是脚本化桩（仓库既有范式：api/lib/fts-search.test.ts、
 * api/lib/graph-maintenance.test.ts、api/datasource-router.test.ts 的 t14 组）：
 *   桩是"我告诉它命中它就命中"，看不见**"查了但没命中"**——而这个 bug 的全部症状
 *   就是"查询执行了、SQL 合法、返回 0 行"，桩测不出来（这也是它藏了这么久的原因）。
 *   这里落库走真实 drizzle `mode:"json"` 序列化器（与 ingestion.ts 同一口径），
 *   查询走 router 里的真实 SQL 文本，两边都是真 SQLite 语义。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { User } from "@db/schema";
import * as fullSchema from "@db/schema";
import { ingestionItems } from "@db/schema";
import type { TrpcContext } from "./context";
import { getDb } from "./queries/connection";
import { sessionAuth } from "./lib/auth";
import { ingestionRouter } from "./ingestion-router";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

// ingestion-router 唯一的依赖是连接模块，注入内存库（同 datasource-router.test.ts 惯例）。
vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));

const DDL = `
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
`;

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

function fakeContext(authed = true): TrpcContext {
  const user = authed ? fakeUser() : undefined;
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    auth: user ? sessionAuth(user) : undefined,
  };
}

type Seed = {
  /** 落进 metadata 的 uploadedFileId 原值（number → JSON 数字，与生产一致） */
  uploadedFileId?: unknown;
  /** true = metadata 里根本不写 uploadedFileId 这个键（其它入库通路就是这样） */
  omitKey?: boolean;
  name?: string;
  createdAt?: Date;
};

/** 照抄 api/lib/ingestion.ts:185 的落库映射，用真实 drizzle `mode:"json"` 序列化。 */
function seedItem(seed: Seed): Promise<void> {
  const metadata: Record<string, unknown> = seed.omitKey
    ? { source: "manual" }
    : { uploadedFileId: seed.uploadedFileId ?? null };
  const createdAt = seed.createdAt ?? new Date("2026-01-01T00:00:00Z");
  return getDb()
    .insert(ingestionItems)
    .values({
      jobId: 1,
      externalId: null,
      name: seed.name ?? "note.md",
      mimeType: "text/markdown",
      size: 10,
      status: "completed",
      error: null,
      sourceUrl: null,
      storagePath: null,
      documentId: null,
      metadata,
      createdAt,
      updatedAt: createdAt,
    })
    .then(() => undefined);
}

function jsonType(name: string, key: string): string | null {
  return (
    raw
      .prepare(`SELECT json_type(metadata, '$.${key}') t FROM ingestion_items WHERE name = ?`)
      .get(name) as { t: string | null }
  ).t;
}

let raw: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  raw = new Database(":memory:");
  raw.exec(DDL);
  raw.exec(
    `INSERT INTO ingestion_jobs (id, sourceType, status, createdAt, updatedAt)
     VALUES (1, 'upload', 'completed', 0, 0)`,
  );
  vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
});

describe("getItemsByUploadedFileId 必须真的命中（t15：JSON 数字 vs TEXT 存储类）", () => {
  it("上传文件已入库过 → 查询必须命中那条记录（修复前恒返回空数组）", async () => {
    // Given: 一个上传文件（uploaded_files.id = 7）已经按生产口径入过库。
    await seedItem({ uploadedFileId: 7, name: "已入库.md" });

    // 先钉住"落库形态"确实与生产一致：metadata 里的 uploadedFileId 是 **JSON 数字**（integer），
    // 不是字符串。这一行如果被改成 "7"，下面的用例会因为类型漂移而假绿。
    expect(jsonType("已入库.md", "uploadedFileId")).toBe("integer");

    // When / Then: 按数字 id 查这个上传文件的入库记录，必须查得到。
    const caller = ingestionRouter.createCaller(fakeContext());
    const items = await caller.getItemsByUploadedFileId({ uploadedFileId: 7 });

    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("已入库.md");
    expect(items[0]?.metadata).toMatchObject({ uploadedFileId: 7 });
  });

  it("根因锚点（真 SQLite）：同一行数据，裸比较 0 命中，CAST AS TEXT 命中", async () => {
    // 把 SQLite 的存储类语义直接在测试里钉死：将来有人把 CAST 拆掉，
    // 上一条用例会红；有人误以为"数字比数字就行"，这一条会告诉他为什么不行。
    await seedItem({ uploadedFileId: 7, name: "锚点.md" });
    const stmt = (where: string) =>
      (raw.prepare(`SELECT COUNT(*) n FROM ingestion_items WHERE ${where}`).get() as { n: number }).n;

    // 旧写法：->> 取出 INTEGER，比较值是 TEXT '7' → SQLite 不认相等
    expect(stmt(`metadata->>'$.uploadedFileId' = '7'`)).toBe(0);
    // 对照：与原生数字比才命中（但代码里传的是 String(id)，做不到）
    expect(stmt(`metadata->>'$.uploadedFileId' = 7`)).toBe(1);
    // 仓库约定口径
    expect(stmt(`CAST(metadata->>'$.uploadedFileId' AS TEXT) = '7'`)).toBe(1);
  });

  it("历史行把 uploadedFileId 存成 JSON 字符串也必须命中（CAST 对两种形态都成立）", async () => {
    await seedItem({ uploadedFileId: "7", name: "旧数据-字符串.md" });
    expect(jsonType("旧数据-字符串.md", "uploadedFileId")).toBe("text");

    const caller = ingestionRouter.createCaller(fakeContext());
    const items = await caller.getItemsByUploadedFileId({ uploadedFileId: 7 });
    expect(items.map((i) => i.name)).toEqual(["旧数据-字符串.md"]);
  });

  it("其它通路（uploadedFileId 为 JSON null / 无此键）绝不允许被误命中", async () => {
    // datasource 通路每条入库行都带 uploadedFileId: null（ingestion.ts:185），
    // 修 CAST 时如果写成"字符串化的 null 也相等"，这些行会全部串进来。
    await seedItem({ uploadedFileId: 7, name: "目标文件.md" });
    await seedItem({ uploadedFileId: null, name: "网盘条目-1.md" });
    await seedItem({ uploadedFileId: null, name: "网盘条目-2.md" });
    await seedItem({ omitKey: true, name: "手工条目-无此键.md" });

    const caller = ingestionRouter.createCaller(fakeContext());
    const items = await caller.getItemsByUploadedFileId({ uploadedFileId: 7 });
    expect(items.map((i) => i.name)).toEqual(["目标文件.md"]);
  });

  it("不同的 uploadedFileId 不得串味", async () => {
    await seedItem({ uploadedFileId: 7, name: "七号.md" });
    await seedItem({ uploadedFileId: 8, name: "八号.md" });

    const caller = ingestionRouter.createCaller(fakeContext());
    expect((await caller.getItemsByUploadedFileId({ uploadedFileId: 8 })).map((i) => i.name)).toEqual(["八号.md"]);
    expect((await caller.getItemsByUploadedFileId({ uploadedFileId: 9 })).map((i) => i.name)).toEqual([]);
  });

  it("同一文件多次入库：全部返回且按 createdAt 倒序", async () => {
    await seedItem({ uploadedFileId: 7, name: "第一次.md", createdAt: new Date("2026-01-01T00:00:00Z") });
    await seedItem({ uploadedFileId: 7, name: "第三次.md", createdAt: new Date("2026-03-01T00:00:00Z") });
    await seedItem({ uploadedFileId: 7, name: "第二次.md", createdAt: new Date("2026-02-01T00:00:00Z") });

    const caller = ingestionRouter.createCaller(fakeContext());
    const items = await caller.getItemsByUploadedFileId({ uploadedFileId: 7 });
    expect(items.map((i) => i.name)).toEqual(["第三次.md", "第二次.md", "第一次.md"]);
  });

  it("未登录仍然被 authedQuery 拦住（改动没有绕过鉴权）", async () => {
    await seedItem({ uploadedFileId: 7 });
    const caller = ingestionRouter.createCaller(fakeContext(false));
    await expect(caller.getItemsByUploadedFileId({ uploadedFileId: 7 })).rejects.toThrow(/Authentication required/);
  });

  it("源码守卫：uploadedFileId 的 JSON 比较必须被 CAST 包住（防第三次复发）", async () => {
    // 与 api/mcp-document-delete.test.ts:194 同一手法：行为用例之外再钉一条文本口径，
    // 免得后来人在这个文件里另写一套裸 `->>'$.uploadedFileId' = String(id)`。
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./ingestion-router.ts", import.meta.url), "utf8"),
    );
    expect(source).toMatch(/CAST\(\$\{ingestionItems\.metadata\}->>'\$\.uploadedFileId' AS TEXT\)/);
    expect(source).not.toMatch(/\$\{ingestionItems\.metadata\}->>'\$\.uploadedFileId' = /);
  });
});
