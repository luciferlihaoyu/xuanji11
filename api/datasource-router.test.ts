import * as fs from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { User } from "@db/schema";
import * as fullSchema from "@db/schema";
import { dataSources, ingestionJobs } from "@db/schema";
import type { TrpcContext } from "./context";
import { getDb } from "./queries/connection";
import { sessionAuth } from "./lib/auth";
import { env } from "./lib/env";
import { getConnector } from "./connectors";
import { ingestFile } from "./lib/ingestion";
import { logAudit } from "./lib/audit";
import type { CloudConnector, CloudFile } from "./connectors/base";
import { datasourceRouter } from "./datasource-router";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
  // getContent 内联正文会写临时文件到 env.uploadDir，测试指向独立 tmp 子目录
  process.env.UPLOAD_DIR = `${process.env.TMPDIR || "/tmp"}/xuanji-ds-test-${process.pid}`;
});

// datasource-router 依赖的连接/副作用模块全部 mock，遵循仓库既有测试惯例
//（参见 connector-router.test.ts / mcp-client-router.test.ts）。
vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));

vi.mock("./connectors", () => ({
  getConnector: vi.fn(),
  listConnectors: vi.fn(),
}));

vi.mock("./lib/audit", () => ({ logAudit: vi.fn() }));

// ingestFile → vector-service（Zvec 原生二进制），本容器无法加载，整体 mock。
vi.mock("./lib/ingestion", () => ({ ingestFile: vi.fn() }));

vi.mock("./lib/vector", () => ({
  vectorEngine: { size: 0 },
  initializeZvec: vi.fn(),
}));

vi.mock("./lib/vector-service", () => ({
  listCollections: vi.fn(),
  addDocumentsToCollection: vi.fn(),
  deleteCollection: vi.fn(),
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
  getStats: vi.fn(),
  initializeZvec: vi.fn(),
  vectorEngine: { size: 0 },
}));

type DataSourceRow = typeof dataSources.$inferSelect;

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

function fakeContext(): TrpcContext {
  const user = fakeUser();
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    auth: sessionAuth(user),
  };
}

function seedRow(overrides: Partial<DataSourceRow> = {}): DataSourceRow {
  return {
    id: 1,
    name: "测试数据源",
    type: "cloud_drive",
    config: { platform: "115" },
    status: "disconnected",
    lastSyncAt: null,
    lastError: null,
    createdBy: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** sync 循环里"是否已同步过"的去重命中行（只用到 metadata.remoteModifiedAt 一个字段）。 */
type ExistingItemRow = { metadata?: Record<string, unknown> | null };

function createFakeDb(
  seed: readonly DataSourceRow[] = [],
  // 按 sync 循环发起去重查询的先后顺序，依次给出每次查询的命中结果（空数组 = 未同步过）。
  // 注意：只有 type === "file" 的条目才会发起去重查询，folder 不消耗队列槽位。
  existingQueue: readonly (readonly ExistingItemRow[])[] = [],
) {
  const rows = seed.map((row) => ({ ...row }));
  const readRows = () => rows.map((row) => ({ ...row }));
  // 捕获每次 update(...).set(data) 的 data，供断言落库状态（critical-1 复核要求）。
  const updates: Record<string, unknown>[] = [];
  // 同一条链路会先写 ingestionJobs 再写 dataSources，两者字段名相同（status 等），
  // 必须按表分开捕获，否则无法断言"数据源状态"与"作业状态"各自的判定。
  const dsUpdates: Record<string, unknown>[] = [];
  const jobUpdates: Record<string, unknown>[] = [];
  let existingLookup = 0;

  return {
    updates,
    dsUpdates,
    jobUpdates,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() =>
          table === dataSources
            ? Promise.resolve(readRows())
            : {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => Promise.resolve(existingQueue[existingLookup++] ?? [])),
                })),
                // kb_folders 的归档查询走的是 `.where(...).limit(1)`（无 orderBy）——
                // 这一档返回"空夹"，即"还没有建过夹"（本文件的 fake-db 用例不关心夹的落库，
                // 建夹行为由文件末尾的真库 harness 专门钉住）。
                limit: vi.fn(() => Promise.resolve([])),
              },
        ),
        orderBy: vi.fn(() => Promise.resolve(table === dataSources ? readRows() : [])),
      })),
    })),
    insert: vi.fn(() => ({
      // better-sqlite3 的真实返回形态是 { lastInsertRowid, changes }（非数组），
      // 与 router 里 Number(result.lastInsertRowid) 对齐。
      values: vi.fn(() => Promise.resolve({ lastInsertRowid: 1 })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: Record<string, unknown>) => {
        updates.push(data);
        if (table === dataSources) dsUpdates.push(data);
        if (table === ingestionJobs) jobUpdates.push(data);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  };
}

/** 取最后一次落库的 set() 数据（数据源终态 / 作业终态都是链路末尾各写一次）。 */
function lastOf(updates: Record<string, unknown>[]): Record<string, unknown> {
  const last = updates[updates.length - 1];
  if (!last) throw new Error("expected at least one captured update, got none");
  return last;
}

function cloudConnector(overrides: Partial<CloudConnector> = {}): CloudConnector {
  return {
    name: "115",
    authType: "apikey",
    testConnection: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    listFiles: vi.fn().mockResolvedValue([]),
    getDownloadUrl: vi.fn().mockResolvedValue(null),
    uploadFile: vi.fn().mockResolvedValue({ success: true, path: "/x" }),
    syncFiles: vi.fn().mockResolvedValue({ downloaded: 0, failed: 0 }),
    ...overrides,
  };
}

/** 按平台名精确应答的连接器桩：只有"真注册了的名字"才返回连接器，
 *  以此区分「类型名恰好有连接器」与「根本没有可用连接器」两种情形。
 *  （t11 与 t12 两条链路都要用它——testConnection 与 sync 必须共用同一套解析口径，
 *  测试里也用同一个桩，保证两个入口看到的世界完全一致。） */
function connectorByName(connectors: Record<string, CloudConnector>) {
  vi.mocked(getConnector).mockImplementation((name: string) => connectors[name]);
}

function callerWith(
  seed: readonly DataSourceRow[] = [],
  existingQueue: readonly (readonly ExistingItemRow[])[] = [],
) {
  const db = createFakeDb(seed, existingQueue);
  vi.mocked(getDb).mockReturnValue(db as never);
  return { db, caller: datasourceRouter.createCaller(fakeContext()) };
}

/** t8 计数口径用例的网盘文件。带上 modifiedAt 是沿用既有用例的形态（去重命中 + 时间戳不新 → 跳过）；
 *  t14 M-3 之后，"缺 modifiedAt"同样会走跳过分支（无法比较新旧 = 判无变化），
 *  见下面的 "sync cross-run dedup on real sqlite (t14 M-2/M-3)"。 */
function driveFile(id: string, modifiedAtIso = "2026-01-02T00:00:00Z"): CloudFile {
  return {
    id,
    name: `${id}.md`,
    type: "file",
    mimeType: "text/markdown",
    size: 10,
    modifiedAt: new Date(modifiedAtIso),
    downloadUrl: `https://dl.example.test/${id}`,
  };
}

/** 让一次去重查询命中"上次入库记录的 remoteModifiedAt 晚于远端条目"→ 该条目应被跳过。 */
function alreadySynced(remoteModifiedAtIso = "2026-06-01T00:00:00Z"): ExistingItemRow[] {
  return [{ metadata: { remoteModifiedAt: remoteModifiedAtIso } }];
}

/** 未同步过（去重查询落空）。 */
const FRESH: ExistingItemRow[] = [];

describe("datasourceRouter sync honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ingestFile).mockResolvedValue({ itemId: 1 });
    vi.mocked(logAudit).mockResolvedValue();
  });

  describe("sync", () => {
    it("returns an unsupported result for an unimplemented type without touching status", async () => {
      // Given: a database-type datasource has no real connector.
      const { db, caller } = callerWith([seedRow({ id: 1, type: "database", config: { url: "https://x" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: the result is honest and no status/connector/ingestion side effects occur.
      expect(result).toEqual({
        success: false,
        synced: false,
        reason: "unsupported",
        type: "database",
        message: "该数据源类型尚未实现同步",
      });
      expect(db.update).not.toHaveBeenCalled();
      expect(getConnector).not.toHaveBeenCalled();
      expect(ingestFile).not.toHaveBeenCalled();
    });

    it("keeps the original connector + ingestion path for an implemented type", async () => {
      // Given: a cloud_drive datasource backed by the 115 connector exposing one file.
      const file = {
        id: "f1",
        name: "doc.md",
        type: "file" as const,
        mimeType: "text/markdown",
        size: 42,
        modifiedAt: new Date("2026-01-02T00:00:00Z"),
        downloadUrl: "https://dl.example.test/1",
      };
      const connector = cloudConnector({ listFiles: vi.fn().mockResolvedValue([file]) });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { db, caller } = callerWith([seedRow({ id: 1, type: "cloud_drive" })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: the original pipeline runs and reports success.
      expect(getConnector).toHaveBeenCalledWith("115");
      expect(connector.listFiles).toHaveBeenCalledTimes(1);
      expect(ingestFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: true });
      // t8：消息口径改为"成功 N"（旧 "N 处理" 会把跳过项也算进处理数）。
      expect(result.message).toContain("成功 1");
      expect(db.update).toHaveBeenCalled();
    });

    it("reports a missing datasource", async () => {
      // Given: no datasource with that id exists.
      const { caller } = callerWith([]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 999 });

      // Then: the router reports the missing datasource.
      expect(result).toEqual({ success: false, message: "数据源不存在" });
    });
  });

  describe("sync with inline connector content (getContent)", () => {
    const entryUrl = "https://feed.example.test/posts/1";
    const inlineContent = "# 文章标题\n\n正文内容";

    function feedFile() {
      return {
        id: "entry-1",
        name: "Entry One",
        type: "file" as const,
        mimeType: "text/html",
        size: 1234,
        downloadUrl: entryUrl,
      };
    }

    function inlineResult() {
      return { fileName: "entry-one.md", mimeType: "text/markdown", content: inlineContent };
    }

    function inlineConnector(overrides: Partial<CloudConnector> = {}): CloudConnector {
      return cloudConnector({
        name: "rss",
        listFiles: vi.fn().mockResolvedValue([feedFile()]),
        getContent: vi.fn().mockResolvedValue(inlineResult()),
        ...overrides,
      });
    }

    beforeEach(() => {
      fs.rmSync(env.uploadDir, { recursive: true, force: true });
    });

    it("hands ingestFile a storagePath (and no downloadUrl) when getContent returns content", async () => {
      // Given: a connector that provides the document body inline.
      const connector = inlineConnector();
      vi.mocked(getConnector).mockReturnValue(connector);
      const { caller } = callerWith([seedRow({ id: 1, type: "rss", config: { platform: "rss" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: getContent is consulted and ingestion uses the written temp file.
      expect(connector.getContent).toHaveBeenCalledTimes(1);
      expect(connector.getDownloadUrl).not.toHaveBeenCalled();
      expect(ingestFile).toHaveBeenCalledTimes(1);
      const opts = vi.mocked(ingestFile).mock.calls[0][0];
      expect(typeof opts.storagePath).toBe("string");
      expect(opts.storagePath).toContain("ds-feed-");
      expect(opts.storagePath).toMatch(/\.md$/);
      expect("downloadUrl" in opts).toBe(false);
      expect(opts.sourceUrl).toBe(entryUrl); // 去重键必须保持稳定
      expect(opts.externalId).toBe("entry-1");
      expect(opts.fileName).toBe("entry-one.md");
      expect(opts.mimeType).toBe("text/markdown");
      expect(opts.size).toBe(Buffer.byteLength(inlineContent));
      // minor-2：临时文件入库后即删，storagePath 是悬空路径——靠 inlineContent 标记区分。
      expect(opts.metadata).toMatchObject({ inlineContent: true, dataSourceId: 1, platform: "rss" });
      expect(result).toMatchObject({ success: true });
    });

    it("writes the temp file before ingestion and removes it afterwards", async () => {
      // Given: a probe that checks the temp file exists while ingestFile is running.
      let existedDuringIngest = false;
      vi.mocked(ingestFile).mockImplementation(async (opts) => {
        existedDuringIngest = typeof opts.storagePath === "string" && fs.existsSync(opts.storagePath);
        return { itemId: 1 };
      });
      const connector = inlineConnector();
      vi.mocked(getConnector).mockReturnValue(connector);
      const { caller } = callerWith([seedRow({ id: 1, type: "rss", config: { platform: "rss" } })]);

      // When: the user requests a sync.
      await caller.sync({ id: 1 });

      // Then: the temp file existed for the ingest and nothing is left behind.
      expect(existedDuringIngest).toBe(true);
      const leftovers = fs.existsSync(env.uploadDir)
        ? fs.readdirSync(env.uploadDir).filter((n) => n.startsWith("ds-feed-"))
        : [];
      expect(leftovers).toEqual([]);
    });

    it("skips an entry whose inline content is absent instead of fetching the article page", async () => {
      // Given: a connector whose entry has no inline body.
      const connector = inlineConnector({ getContent: vi.fn().mockResolvedValue(null) });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { caller } = callerWith([seedRow({ id: 1, type: "rss", config: { platform: "rss" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: 决策 A — 实现了 getContent 的连接器返回 null 视为"该条目无正文"，
      // 计入 skipped 并记日志，绝不回退去抓文章网页（避免 HTML 脏数据入库）。
      expect(connector.getContent).toHaveBeenCalledTimes(1);
      expect(connector.getDownloadUrl).not.toHaveBeenCalled();
      expect(ingestFile).not.toHaveBeenCalled();
      // t8：口径为"跳过 N"；同一条目不得再算进"成功"（详见 sync counting honesty (t8) 用例）。
      expect(result.message).toContain("跳过 1");
      expect(result).toMatchObject({ success: true });
    });

    it("counts an entry with empty inline content as failed, not silent success", async () => {
      // Given: a connector returning a bodyless document (content is empty string).
      const connector = inlineConnector({
        getContent: vi.fn().mockResolvedValue({ fileName: "empty.md", mimeType: "text/markdown", content: "" }),
      });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { caller } = callerWith([seedRow({ id: 1, type: "rss", config: { platform: "rss" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: empty body is dirty data — counted as failed, ingestion untouched, no temp file.
      expect(ingestFile).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: false });
      // t8：口径为"失败 N"（旧 "N 失败" 同格式串改）。
      expect(result.message).toContain("失败 1");
      const leftovers = fs.existsSync(env.uploadDir)
        ? fs.readdirSync(env.uploadDir).filter((n) => n.startsWith("ds-feed-"))
        : [];
      expect(leftovers).toEqual([]);
    });

    it("keeps the pre-existing behaviour for connectors without getContent", async () => {
      // Given: a classic cloud-drive connector (no getContent at all).
      const file = feedFile();
      const connector = cloudConnector({ listFiles: vi.fn().mockResolvedValue([file]) });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { caller } = callerWith([seedRow({ id: 1, type: "cloud_drive" })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: nothing changed — downloadUrl path, file metadata preserved, no temp files.
      expect(ingestFile).toHaveBeenCalledTimes(1);
      const opts = vi.mocked(ingestFile).mock.calls[0][0];
      expect(opts.downloadUrl).toBe(entryUrl);
      expect(opts.storagePath).toBeUndefined();
      expect(opts.fileName).toBe("Entry One");
      expect(opts.size).toBe(1234);
      const leftovers = fs.existsSync(env.uploadDir)
        ? fs.readdirSync(env.uploadDir).filter((n) => n.startsWith("ds-feed-"))
        : [];
      expect(leftovers).toEqual([]);
      expect(result).toMatchObject({ success: true });
    });

    it("defaults the platform to rss when an rss datasource config has no platform", async () => {
      // Given: an rss datasource — the UI never picks a "platform" for feeds.
      const connector = inlineConnector();
      vi.mocked(getConnector).mockReturnValue(connector);
      const { caller } = callerWith([seedRow({ id: 1, type: "rss", config: { url: "https://rss.example.test/feed" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: the connector is resolved via the "rss" fallback instead of a silent no-op.
      expect(getConnector).toHaveBeenCalledWith("rss");
      expect(connector.listFiles).toHaveBeenCalledTimes(1);
      expect(result).not.toEqual({ success: true, message: "同步完成" });
      expect(result).toMatchObject({ success: true });
      // t8：消息口径改为"成功 N"（旧 "N 处理" 会把跳过项也算进处理数）。
      expect(result.message).toContain("成功 1");
    });

    it("treats a blank platform string as missing and still resolves the rss connector", async () => {
      // Given: an rss datasource whose config carries a whitespace-only platform.
      const connector = inlineConnector();
      vi.mocked(getConnector).mockReturnValue(connector);
      const { caller } = callerWith([
        seedRow({ id: 1, type: "rss", config: { platform: "   ", url: "https://rss.example.test/feed" } }),
      ]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: "" must not slip past the fallback (||, not ??) — the connector still runs.
      expect(getConnector).toHaveBeenCalledWith("rss");
      expect(connector.listFiles).toHaveBeenCalledTimes(1);
      // t8：消息口径改为"成功 N"（旧 "N 处理" 会把跳过项也算进处理数）。
      expect(result.message).toContain("成功 1");
    });
  });

  describe("sync platform fallback (t11)", () => {
    // t11 问题 A：sync 里 `if (!platform) { 盖 connected + lastSyncAt; return success:"同步完成" }`
    // 与上一轮修掉的「testConnection 零出网宣告连接成功」是同一类缺陷——什么都没同步却报成功。
    // 修法：resolvePlatform 在类型名下已有注册连接器时兜底为该类型名（nas → "nas"、rss → "rss"）；
    // 最终仍解析不出可用连接器时明确失败（success:false + 状态 error + 可读 lastError）。
    // 连接器桩 connectorByName 已提到模块作用域：t12 的 testConnection 用例要共用同一个"注册表世界"。

    it("resolves the nas connector from the type name when config has no platform", async () => {
      // Given: a nas datasource — the UI shows the platform picker only for cloud_drive,
      // so a NAS source's config never carries platform, yet a "nas" connector is registered.
      const connector = cloudConnector({
        name: "NAS / 本地存储",
        listFiles: vi.fn().mockResolvedValue([driveFile("f1")]),
      });
      connectorByName({ nas: connector });
      const { db, caller } = callerWith([seedRow({ id: 1, type: "nas", config: { path: "/mnt/data" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: the type name resolves to the registered nas connector and it really runs —
      // not the old silent no-op that answered "同步完成" without touching a single entry.
      expect(getConnector).toHaveBeenCalledWith("nas");
      expect(connector.listFiles).toHaveBeenCalledTimes(1);
      expect(ingestFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: true });
      expect(result.message).toContain("成功 1");
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 1, failedItems: 0, status: "completed" });
      expect(lastOf(db.dsUpdates)).toMatchObject({ status: "connected", lastError: null });
    });

    it("fails honestly when neither config.platform nor the type name has a connector", async () => {
      // Given: a cloud_drive datasource saved without a platform (the picker defaults to ""),
      // and no connector registered under "cloud_drive" either.
      connectorByName({});
      const { db, caller } = callerWith([seedRow({ id: 1, type: "cloud_drive", config: { url: "" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: honest failure — no fake success, no connected/lastSyncAt stamp, no empty job row.
      expect(result).toMatchObject({ success: false });
      expect(result).not.toEqual({ success: true, message: "同步完成" });
      expect(String(result.message)).toContain("无可用连接器");
      expect(String(result.message)).toContain("未执行同步");
      expect(ingestFile).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled(); // 不留下 totalItems=0 的"看起来同步过"的作业
      expect(lastOf(db.dsUpdates).status).toBe("error");
      expect(String(lastOf(db.dsUpdates).lastError)).toContain("未执行同步");
      // 回归护栏：绝不再出现"零同步却盖 connected / lastSyncAt"。
      expect(db.dsUpdates.some((u) => u.status === "connected")).toBe(false);
      expect(db.dsUpdates.some((u) => "lastSyncAt" in u)).toBe(false);
    });

    it("reports a readable reason when an explicit platform has no connector registered", async () => {
      // Given: config names a platform ("quark") no connector is registered under.
      connectorByName({});
      const { db, caller } = callerWith([seedRow({ id: 1, type: "cloud_drive", config: { platform: "quark" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: it still fails, but the recorded reason says which platform is missing
      // instead of the catch-all "Internal error" (which hides a pure config mistake).
      expect(result).toMatchObject({ success: false });
      expect(ingestFile).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(lastOf(db.dsUpdates).status).toBe("error");
      expect(String(lastOf(db.dsUpdates).lastError)).toContain("quark");
      expect(db.dsUpdates.some((u) => u.status === "connected")).toBe(false);
    });
  });

  describe("sync empty source honesty (t10)", () => {
    // t10：同一个空订阅源，testConnection 已明确说"当前没有任何条目，没有可同步的内容"，
    // sync 却回一句"同步完成: 成功 0, 跳过 0, 失败 0"——两个入口一个说没内容、一个像在报正常收工，
    // 用户无法判断到底有没有东西进来。修法：零条目时给出可区分、明说"没有任何内容入库"的消息。
    // 状态判定（写在这几条断言里，是有意的设计选择）：连接器 listFiles 正常返回空数组
    //   = 源可达且合法，只是没内容 → status 仍 connected、lastSyncAt 可盖（本轮确实跑过一次同步），
    //   但消息必须自己讲明白"零条"，绝不许写得像同步进了东西。

    /** 空源连接器：可达、合法、0 条目（rss 空 feed 与网盘空目录都走这个形状）。 */
    function emptySourceConnector(overrides: Partial<CloudConnector> = {}) {
      const connector = cloudConnector({
        name: "rss",
        listFiles: vi.fn().mockResolvedValue([]),
        ...overrides,
      });
      vi.mocked(getConnector).mockReturnValue(connector);
      return connector;
    }

    it("states that an empty source yielded nothing instead of a bare zero-count summary", async () => {
      // Given: a reachable, valid source that currently exposes zero entries.
      emptySourceConnector();
      const { db, caller } = callerWith([
        seedRow({ id: 1, type: "rss", config: { url: "https://feed.example.test/empty-feed" } }),
      ]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: nothing was ingested, and the message says so out loud.
      expect(ingestFile).not.toHaveBeenCalled();
      expect(String(result.message)).toContain("没有可同步的条目");
      expect(String(result.message)).toContain("0 条");
      // 旧口径（光秃秃的零计数，与 testConnection 打架）必须消失。
      expect(String(result.message)).not.toBe("同步完成: 成功 0, 跳过 0, 失败 0");
      // 绝不许虚报任何入库量。
      expect(String(result.message)).not.toMatch(/成功 [1-9]/);
      expect(String(result.message)).not.toMatch(/跳过 [1-9]/);
      // 作业如实记 0 条；源可达 → 数据源仍 connected、无 lastError。
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 0, failedItems: 0, status: "completed" });
      expect(lastOf(db.dsUpdates)).toMatchObject({ status: "connected", lastError: null });
      expect(result).toMatchObject({ success: true });
    });

    it("does not contradict testConnection about the same empty feed", async () => {
      // Given: an rss connector that (like the real one) fails the gate on an empty feed
      // and returns zero entries to sync.
      const emptyNotice =
        "该地址是合法 feed（《示例源》），但当前没有任何条目，没有可同步的内容 —— 请确认订阅地址是否正确，或源站是否已发布内容";
      const connector = emptySourceConnector({
        testConnection: vi.fn().mockResolvedValue({ success: false, message: emptyNotice }),
      });
      const { caller } = callerWith([
        seedRow({ id: 1, type: "rss", config: { url: "https://feed.example.test/empty-feed" } }),
      ]);

      // When: both entry points are asked about the very same datasource.
      const test = await caller.testConnection({ id: 1 });
      const sync = await caller.sync({ id: 1 });

      // Then: they tell one consistent story — both say "there is nothing to sync".
      expect(connector.testConnection).toHaveBeenCalledTimes(1);
      expect(test).toMatchObject({ success: false });
      expect(String(test.message)).toContain("没有可同步的内容");
      expect(String(sync.message)).toContain("没有可同步");
      expect(String(sync.message)).not.toMatch(/成功 [1-9]/);
      // 0 条目 = 一条都没尝试入库，不许把空跑说成有内容落地。
      expect(ingestFile).not.toHaveBeenCalled();
    });
  });

  describe("sync counting honesty (t8)", () => {
    // 口径（互斥，四者合计 === files.length）：
    //   processed 真正成功入库 | skipped 已同步过/无正文而跳过 | ignored 非 file 条目 | failed 入库抛错
    // 状态判定只看 processed / failed，不再让 skipped 掺进 processed 里冒充成功。
    // 消息格式：`<同步完成|部分成功|同步失败>: 成功 N, 跳过 N[, 忽略 N], 失败 N`（忽略仅在 >0 时出现）。

    /** 走网盘（无 getContent）通路：可按 id 精确指定哪些条目入库失败。 */
    function driveSync(
      files: readonly CloudFile[],
      existingQueue: readonly (readonly ExistingItemRow[])[] = [],
      failingIds: readonly string[] = [],
    ) {
      const connector = cloudConnector({ listFiles: vi.fn().mockResolvedValue([...files]) });
      vi.mocked(getConnector).mockReturnValue(connector);
      vi.mocked(ingestFile).mockImplementation(async (opts) => {
        if (failingIds.includes(String(opts.externalId))) throw new Error(`boom: ${String(opts.externalId)}`);
        return { itemId: 1 };
      });
      const { db, caller } = callerWith([seedRow({ id: 1, type: "cloud_drive" })], existingQueue);
      return { db, connector, caller };
    }

    it("reports all-skipped as success but never claims anything was ingested", async () => {
      // Given: two files that are both already synced (dedup hit with a newer remoteModifiedAt).
      const { db, caller } = driveSync([driveFile("f1"), driveFile("f2")], [alreadySynced(), alreadySynced()]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: nothing was ingested, yet the datasource stays connected — 全跳过是正常空跑。
      expect(ingestFile).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true });
      expect(result.message).toBe("同步完成: 成功 0, 跳过 2, 失败 0");
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 0, failedItems: 0, status: "completed" });
      expect(lastOf(db.dsUpdates)).toMatchObject({ status: "connected", lastError: null });
    });

    it("marks the datasource error when the only entry needing ingestion failed and the rest were skipped", async () => {
      // Given: 4 entries — 3 already synced (skipped), 1 fresh whose ingestion throws.
      // 旧实现把跳过也算进 processed（3 跳过 + 1 失败 = 4 处理），于是
      // `failed > 0 && processed === failed` 为假 → 数据源被写成 connected（假连接）。
      const { db, caller } = driveSync(
        [driveFile("skip-1"), driveFile("skip-2"), driveFile("skip-3"), driveFile("boom")],
        [alreadySynced(), alreadySynced(), alreadySynced(), FRESH],
        ["boom"],
      );

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: 一条都没成功入库 → 数据源 error、作业 failed、success false，且 lastError 有值。
      expect(result).toMatchObject({ success: false });
      expect(lastOf(db.dsUpdates).status).toBe("error");
      expect(typeof lastOf(db.dsUpdates).lastError).toBe("string");
      expect(String(lastOf(db.dsUpdates).lastError)).toContain("1 个文件入库失败");
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 0, failedItems: 1, status: "failed" });
      expect(result.message).toContain("成功 0");
      expect(result.message).toContain("失败 1");
      expect(result.message).toContain("跳过 3");
      // 一条都没落库 → 标题必须是"同步失败"，不许再写"同步完成"。
      expect(result.message.startsWith("同步失败:")).toBe(true);
    });

    it("counts real successes when every file ingests", async () => {
      // Given: three fresh files, all ingesting fine.
      const { db, caller } = driveSync([driveFile("f1"), driveFile("f2"), driveFile("f3")]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: counts are exact and the job/datasource both report success.
      expect(ingestFile).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ success: true });
      expect(result.message).toBe("同步完成: 成功 3, 跳过 0, 失败 0");
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 3, failedItems: 0, status: "completed" });
      expect(lastOf(db.dsUpdates)).toMatchObject({ status: "connected", lastError: null });
    });

    it("reports partial success honestly (connected + lastError, success false)", async () => {
      // Given: three fresh files, one of them fails to ingest.
      const { db, caller } = driveSync(
        [driveFile("ok-1"), driveFile("boom"), driveFile("ok-2")],
        [FRESH, FRESH, FRESH],
        ["boom"],
      );

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: some entries landed → datasource keeps connected + lastError, but the call is not a success
      // and the message says 部分成功 out loud.
      expect(ingestFile).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ success: false });
      expect(result.message).toBe("部分成功: 成功 2, 跳过 0, 失败 1");
      expect(lastOf(db.dsUpdates).status).toBe("connected");
      expect(String(lastOf(db.dsUpdates).lastError)).toContain("1 个文件入库失败");
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 2, failedItems: 1, status: "completed" });
    });

    it("does not count non-file entries as processed", async () => {
      // Given: two folders plus one real file.
      const folderA: CloudFile = { id: "dir-a", name: "docs", type: "folder" };
      const folderB: CloudFile = { id: "dir-b", name: "images", type: "folder" };
      const { db, caller } = driveSync([folderA, driveFile("f1"), folderB]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: only the one file counts as success; folders are reported separately as 忽略.
      expect(ingestFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: true });
      expect(result.message).toBe("同步完成: 成功 1, 跳过 0, 忽略 2, 失败 0");
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 1, failedItems: 0 });
    });

    it("keeps the four counters mutually exclusive when all categories appear at once", async () => {
      // Given: one success + one already-synced + one folder + one failure (4 entries).
      // 去重查询只对 file 条目发起，folder 不占队列槽位 → existingQueue 长度为 3。
      const { db, caller } = driveSync(
        [driveFile("ok"), driveFile("skip"), { id: "dir", name: "sub", type: "folder" }, driveFile("boom")],
        [FRESH, alreadySynced(), FRESH],
        ["boom"],
      );

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: 1/1/1/1 — each entry lands in exactly one bucket, none double counted.
      expect(ingestFile).toHaveBeenCalledTimes(2); // ok + boom 尝试入库，skip 未触发
      expect(result).toMatchObject({ success: false });
      expect(result.message).toBe("部分成功: 成功 1, 跳过 1, 忽略 1, 失败 1");
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 1, failedItems: 1, status: "completed" });
      expect(lastOf(db.dsUpdates).status).toBe("connected");
    });

    it("counts a content-less rss entry as skipped, never as processed", async () => {
      // Given: an rss connector whose single entry has no inline body (getContent → null).
      const connector = cloudConnector({
        name: "rss",
        listFiles: vi.fn().mockResolvedValue([
          { id: "entry-1", name: "Entry One", type: "file" as const, downloadUrl: "https://feed.example.test/p/1" },
        ]),
        getContent: vi.fn().mockResolvedValue(null),
      });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { db, caller } = callerWith([seedRow({ id: 1, type: "rss", config: { platform: "rss" } })]);

      // When: the user requests a sync.
      const result = await caller.sync({ id: 1 });

      // Then: it is a skip, not a silent success — processedItems must stay 0.
      expect(ingestFile).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true });
      expect(result.message).toBe("同步完成: 成功 0, 跳过 1, 失败 0");
      expect(lastOf(db.jobUpdates)).toMatchObject({ processedItems: 0, failedItems: 0, status: "completed" });
      expect(lastOf(db.dsUpdates).status).toBe("connected");
    });
  });

  describe("testConnection", () => {
    it("returns failure for an unimplemented type without marking it connected", async () => {
      // Given: an api-type datasource has no real connector.
      const { db, caller } = callerWith([seedRow({ id: 1, type: "api", config: { url: "https://x" } })]);

      // When: the user tests the connection.
      const result = await caller.testConnection({ id: 1 });

      // Then: the result is an honest failure and no status is written.
      expect(result).toEqual({ success: false, reason: "unsupported", type: "api", message: "类型未实现" });
      expect(db.update).not.toHaveBeenCalled();
      expect(getConnector).not.toHaveBeenCalled();
    });

    it("uses the platform connector for an implemented type", async () => {
      // Given: a cloud_drive datasource on aliyundrive with a working connector.
      const connector = cloudConnector({ name: "aliyundrive" });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { db, caller } = callerWith([seedRow({ id: 1, config: { platform: "aliyundrive" } })]);

      // When: the user tests the connection.
      const result = await caller.testConnection({ id: 1 });

      // Then: the connector is used and status is written.
      expect(getConnector).toHaveBeenCalledWith("aliyundrive");
      expect(connector.testConnection).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, message: "ok" });
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("consults the rss connector for an rss datasource with no platform (no zero-egress fake success)", async () => {
      // Given: an rss datasource — the UI never picks a "platform" for feeds — and a reachable feed connector.
      const connector = cloudConnector({
        name: "rss",
        testConnection: vi.fn().mockResolvedValue({ success: true, message: "feed reachable" }),
      });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { db, caller } = callerWith([seedRow({ id: 1, type: "rss", config: { url: "https://rss.example.test/feed" } })]);

      // When: the user tests the connection.
      const result = await caller.testConnection({ id: 1 });

      // Then: the rss fallback applies here too — the connector is really consulted
      // and the reported/DB status comes from ITS result, not the generic no-egress shortcut.
      expect(getConnector).toHaveBeenCalledWith("rss");
      expect(connector.testConnection).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, message: "feed reachable" });
      expect(result).not.toEqual({ success: true, message: "连接成功" });
      expect(db.updates).toContainEqual({ status: "connected", lastError: null });
    });

    it("marks the datasource error from the rss connector failure result", async () => {
      // Given: an rss datasource whose feed endpoint is unreachable.
      const connector = cloudConnector({
        name: "rss",
        testConnection: vi.fn().mockResolvedValue({ success: false, message: "feed HTTP 403" }),
      });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { db, caller } = callerWith([seedRow({ id: 1, type: "rss", config: { platform: "  " } })]);

      // When: the user tests the connection.
      const result = await caller.testConnection({ id: 1 });

      // Then: whitespace platform also falls back to rss, and failure status/lastError come from the connector.
      expect(getConnector).toHaveBeenCalledWith("rss");
      expect(connector.testConnection).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: false, message: "feed HTTP 403" });
      expect(db.updates).toContainEqual({ status: "error", lastError: "feed HTTP 403" });
    });
  });

  describe("testConnection connector resolution (t12)", () => {
    // t12：testConnection 末尾的"通用连接测试"分支什么都没测，只写 status:"connected"
    // 就回"连接成功"（那个 try/catch 里只有一次 DB update，除 DB 挂了不会抛，是空壳）。
    // 触发面：resolvePlatform 解析不出可用连接器 —— ① cloud_drive 且 config.platform 留空
    //（前端保存时不校验平台是否已选，历史/异常数据确实存在）；② platform 写了注册表里没有的名字。
    // 于是 t11 之后出现新矛盾：同一个源 sync 诚实报失败，testConnection 仍报"连接成功"。
    // 修法：与 sync 共用同一套解析口径，解析不出连接器就明确失败（error + 可读原因）。

    it("fails honestly for a cloud_drive source with no platform and no connector (zero-check guardrail)", async () => {
      // Given: a cloud_drive datasource saved without a platform, and nothing registered under "cloud_drive".
      connectorByName({});
      const { db, caller } = callerWith([seedRow({ id: 1, type: "cloud_drive", config: { url: "" } })]);

      // When: the user tests the connection.
      const result = await caller.testConnection({ id: 1 });

      // Then: honest failure — 没做任何检查就不许宣告连接成功。
      expect(result).toMatchObject({ success: false });
      expect(result).not.toEqual({ success: true, message: "连接成功" });
      expect(String(result.message)).toContain("无可用连接器");
      expect(String(result.message)).toContain("无法测试连接");
      // 回归护栏：整条链路不得出现 connected，也不得清掉 lastError。
      expect(db.updates.some((u) => u.status === "connected")).toBe(false);
      expect(lastOf(db.dsUpdates).status).toBe("error");
      expect(String(lastOf(db.dsUpdates).lastError)).toContain("无可用连接器");
    });

    it("names the missing platform in the failure reason when config.platform has no connector", async () => {
      // Given: config names a platform ("quark") that has no registered connector.
      connectorByName({});
      const { db, caller } = callerWith([seedRow({ id: 1, type: "cloud_drive", config: { platform: "quark" } })]);

      // When: the user tests the connection.
      const result = await caller.testConnection({ id: 1 });

      // Then: it fails, and the reason says which platform is missing (same wording as sync).
      expect(result).toMatchObject({ success: false });
      expect(String(result.message)).toContain("quark");
      expect(String(result.message)).toContain("无法测试连接");
      expect(db.updates.some((u) => u.status === "connected")).toBe(false);
      expect(lastOf(db.dsUpdates).status).toBe("error");
      expect(String(lastOf(db.dsUpdates).lastError)).toContain("quark");
    });

    it("resolves testConnection and sync to the same conclusion for one unresolvable datasource", async () => {
      // Given: the exact same broken config both entry points see.
      connectorByName({});
      const { caller } = callerWith([seedRow({ id: 1, type: "cloud_drive", config: { platform: "quark" } })]);

      // When: both entry points are asked.
      const test = await caller.testConnection({ id: 1 });
      const sync = await caller.sync({ id: 1 });

      // Then: both fail, and the reason comes from one shared resolution —
      // 两个入口只允许差在动作尾巴（"无法测试连接" / "未执行同步"）上。
      const sharedReason = '未找到平台 "quark" 对应的连接器';
      expect(test).toMatchObject({ success: false });
      expect(sync).toMatchObject({ success: false });
      expect(String(test.message)).toContain(sharedReason);
      expect(String(sync.message)).toContain(sharedReason);
    });

    it("records an honest error instead of leaving a stale connected when the connector throws", async () => {
      // Given: a resolvable connector whose testConnection blows up (e.g. token refresh threw).
      const connector = cloudConnector({
        name: "rss",
        testConnection: vi.fn().mockRejectedValue(new Error("token refresh blew up")),
      });
      vi.mocked(getConnector).mockReturnValue(connector);
      const { db, caller } = callerWith([seedRow({ id: 1, type: "rss", config: {} })]);

      // When: the user tests the connection.
      const result = await caller.testConnection({ id: 1 });

      // Then: the failure is recorded instead of propagating raw / keeping the previous connected.
      expect(result).toMatchObject({ success: false });
      expect(String(result.message)).toContain("token refresh blew up");
      expect(db.updates.some((u) => u.status === "connected")).toBe(false);
      expect(lastOf(db.dsUpdates).status).toBe("error");
    });
  });

  describe("syncInterval honesty", () => {
    it("notices on create that auto-sync is not enabled for a non-manual interval", async () => {
      // Given: the user creates a datasource with an hourly sync interval.
      const { caller } = callerWith([]);

      // When: the create mutation runs.
      const result = await caller.create({
        name: "RSS 源",
        type: "rss",
        config: { url: "https://rss.example.test/feed", syncInterval: "hourly" },
      });

      // Then: the config is saved but the response honestly states scheduling is off.
      expect(result).toEqual({ id: 1, notice: "自动同步尚未启用，将仅保存配置" });
      expect(logAudit).toHaveBeenCalledTimes(1);
    });

    it("returns no notice for a manual sync interval on create", async () => {
      // Given: the user creates a datasource with a manual sync interval.
      const { caller } = callerWith([]);

      // When: the create mutation runs.
      const result = await caller.create({
        name: "手动源",
        type: "nas",
        config: { syncInterval: "manual" },
      });

      // Then: no notice is attached.
      expect(result).toEqual({ id: 1 });
    });

    it("notices on update that a non-manual interval is only saved as config", async () => {
      // Given: the user switches an existing datasource to daily sync.
      const { caller } = callerWith([]);

      // When: the update mutation runs.
      const result = await caller.update({
        id: 1,
        config: { url: "https://x", syncInterval: "daily" },
      });

      // Then: the update succeeds but honestly states scheduling is off.
      expect(result).toEqual({ success: true, notice: "自动同步尚未启用，将仅保存配置" });
    });

    it("returns no notice for a manual interval on update", async () => {
      // Given: the user keeps manual sync.
      const { caller } = callerWith([]);

      // When: the update mutation runs.
      const result = await caller.update({ id: 1, config: { syncInterval: "manual" } });

      // Then: no notice is attached.
      expect(result).toEqual({ success: true });
    });
  });
});

// ============================ t14：跨 sync 去重（重复入库）— 真 SQLite 复现 ============================

/**
 * M-2 / M-3 都是**跨 sync**的缺陷：只有"第一次入库真的按 ingestion.ts 的口径落了库、
 * 第二次的去重查询真的按 SQL 语义去查"，才测得出来。既有用例的去重命中是脚本化的
 * （existingQueue 直接给返回值），NULL ≠ "" 与"时间戳缺失"这两种"查了但没命中"它看不见。
 *
 * 所以这组用例让 router 跑在**真实内存 SQLite**（仓库既有范式：fts-search /
 * graph-maintenance 用真 better-sqlite3 实例）上，三张表按 @db/schema 手写 DDL；
 * 落库那一步照抄 api/lib/ingestion.ts 的真实映射（`externalId ?? null` / `sourceUrl ?? null`）
 * 写 ingestion_items —— M-2 的根因正是这条映射与查询键口径不一致。
 */
describe("sync cross-run dedup on real sqlite (t14 M-2/M-3)", () => {
  const DDL = `
    CREATE TABLE data_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, config TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      lastSyncAt INTEGER, lastError TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
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
    -- 归档文件夹（2026-10-01 按源归档）：sync 会 ensure「数据源/<源名>」
    CREATE TABLE kb_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, parentId INTEGER,
      icon TEXT DEFAULT 'folder', sortOrder INTEGER DEFAULT 0, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
  `;

  type SeedDs = { id: number; name: string; type: string; config: Record<string, unknown>; status: string };
  type ItemRow = { externalId: string | null; sourceUrl: string | null; metadata: string | null };

  /** 一轮 sync 的真实观测：结果消息 + 这一轮真的落到 ingestion_items 的行数。 */
  type Harness = {
    syncOnce: () => Promise<{ message: string; landed: number }>;
    rows: () => ItemRow[];
  };

  function harness(connector: CloudConnector, ds: SeedDs): Harness {
    const raw = new Database(":memory:");
    raw.exec(DDL);
    raw
      .prepare(
        `INSERT INTO data_sources (id, name, type, config, status, createdAt, updatedAt)
         VALUES (@id, @name, @type, @config, @status, 0, 0)`,
      )
      .run({ id: ds.id, name: ds.name, type: ds.type, config: JSON.stringify(ds.config), status: ds.status });

    // createdAt 单调递增：orderBy(desc(createdAt)).limit(1) 才能稳定取到"最近一次入库"那行
    let clock = 1000;
    let landedThisRun = 0;

    // 照抄 ingestion.ts 的落库映射：sourceUrl/externalId 走 `?? null`（undefined → 库里 NULL），
    // metadata 里的 undefined 字段被 JSON.stringify 直接丢掉（M-3 的"两侧都缺时间"就是这么来的）。
    vi.mocked(ingestFile).mockImplementation(async (opts) => {
      landedThisRun += 1;
      raw
        .prepare(
          `INSERT INTO ingestion_items (jobId, externalId, name, mimeType, size, status, error,
                                        sourceUrl, storagePath, documentId, metadata, createdAt, updatedAt)
           VALUES (1, @externalId, @name, @mimeType, @size, 'completed', NULL,
                   @sourceUrl, NULL, NULL, @metadata, @ts, @ts)`,
        )
        .run({
          externalId: opts.externalId ?? null,
          name: opts.fileName,
          mimeType: opts.mimeType ?? null,
          size: opts.size ?? null,
          sourceUrl: opts.sourceUrl ?? null,
          metadata: JSON.stringify({ ...(opts.metadata ?? {}), uploadedFileId: null }),
          ts: (clock += 1),
        });
      return { itemId: landedThisRun };
    });

    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
    vi.mocked(getConnector).mockReturnValue(connector);

    const caller = datasourceRouter.createCaller(fakeContext());
    return {
      async syncOnce() {
        landedThisRun = 0;
        const result = await caller.sync({ id: ds.id });
        return { message: String((result as { message?: unknown }).message ?? ""), landed: landedThisRun };
      },
      rows: () =>
        raw.prepare(`SELECT externalId, sourceUrl, metadata FROM ingestion_items ORDER BY createdAt`).all() as ItemRow[],
    };
  }

  /** 内联正文（rss 通路）的连接器桩：listFiles 每次现取，方便中途改条目内容/时间。 */
  function inlineConnector(files: () => CloudFile[]): CloudConnector {
    return cloudConnector({
      name: "rss",
      listFiles: vi.fn().mockImplementation(async () => files()),
      getContent: vi.fn().mockResolvedValue({ fileName: "e.md", mimeType: "text/markdown", content: "# body" }),
    });
  }

  const RSS_DS: SeedDs = { id: 1, name: "RSS", type: "rss", config: { platform: "rss" }, status: "disconnected" };
  const DRIVE_DS: SeedDs = { id: 1, name: "网盘", type: "cloud_drive", config: { platform: "115" }, status: "disconnected" };

  beforeEach(() => {
    // 本 describe 挂在顶层，拿不到 "datasourceRouter sync honesty" 里那个 beforeEach 的
    // clearAllMocks —— 不在这里清一次，ingestFile.mock.calls 会跨用例累积，
    // 用 calls[0] 断言"本轮传给 ingestion 的参数"就会读到上一轮的调用（测试隔离问题，非产品缺陷）。
    vi.clearAllMocks();
    fs.rmSync(env.uploadDir, { recursive: true, force: true });
  });

  describe("去重键必须真的命中（M-3 的前置实证：数字型 dataSourceId 与 TEXT 的比较）", () => {
    it("两条正常条目（有 link、有 pubDate）：第二轮整源全部跳过，一条都不重入", async () => {
      // 这是"最不该出问题"的形态：externalId 稳定、链接齐全、时间齐全。
      // 真库实测：修复前去重查询就**从未命中过** —— metadata 里的 dataSourceId 是 JSON 数字，
      // SQLite 的 `->>` 把它取出成 SQL INTEGER，而代码拿 String(ds.id)（TEXT）去比，
      // SQLite 里 INTEGER 1 = '1' 恒为假 → 每一轮 sync 把整个源重入一遍。
      // 这条用例就是把"查询键能不能命中"这件事本身钉住，M-2/M-3 都建立在它之上。
      const files = (): CloudFile[] => [
        {
          id: "k1", name: "one.md", type: "file", mimeType: "text/markdown", size: 2,
          downloadUrl: "https://feed.example.test/k/1", modifiedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          id: "k2", name: "two.md", type: "file", mimeType: "text/markdown", size: 2,
          downloadUrl: "https://feed.example.test/k/2", modifiedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ];
      const h = harness(inlineConnector(files), RSS_DS);

      const first = await h.syncOnce();
      expect(first.landed).toBe(2);
      expect(h.rows()).toHaveLength(2);

      const second = await h.syncOnce();
      expect(second.landed).toBe(0);
      expect(second.message).toBe("同步完成: 成功 0, 跳过 2, 失败 0");
      expect(h.rows()).toHaveLength(2);
    });
  });

  describe("M-2：downloadUrl 缺字段时，去重查询键与落库值必须同口径", () => {
    it("无 link 的 rss 条目：第二次同步必须 skipped，而不是又入库一份", async () => {
      // Given: 条目有 guid（externalId 稳定）但**没有 link** → CloudFile 不带 downloadUrl 字段；
      // 同时带 modifiedAt，把 M-3 排除在外，这一条只测 M-2 的键口径。
      const files = (): CloudFile[] => [
        {
          id: "r2", name: "no-link.md", type: "file", mimeType: "text/markdown", size: 2,
          modifiedAt: new Date("2026-01-02T00:00:00Z"),
        },
      ];
      const h = harness(inlineConnector(files), RSS_DS);

      // When: 同一个源连续同步两轮。
      const first = await h.syncOnce();
      const second = await h.syncOnce();

      // Then: 第一轮入库 1 行；第二轮命中去重 → skipped，绝不产生第二份文档。
      expect(first.landed).toBe(1);
      // 缺陷现场（修复前）：查询用 ""、落库是 NULL → 永不命中 → 第二轮又落一份。
      expect(second.landed).toBe(0);
      expect(second.message).toContain("跳过 1");
      expect(h.rows()).toHaveLength(1);
    });

    it("无 link 条目落库的 sourceUrl 必须与去重查询用同一个表示（把口径钉死，不只看结果）", async () => {
      // router 的去重查询写死 `file.downloadUrl ?? ""`。落库侧若仍传 undefined（→ NULL），
      // NULL ≠ "" 就是 M-2 根因；这两条断言直接钉住"两侧同口径"，而不是只钉现象。
      const files = (): CloudFile[] => [
        {
          id: "r9", name: "no-link.md", type: "file", mimeType: "text/markdown", size: 2,
          modifiedAt: new Date("2026-01-02T00:00:00Z"),
        },
      ];
      const h = harness(inlineConnector(files), RSS_DS);
      await h.syncOnce();

      expect(vi.mocked(ingestFile).mock.calls[0]![0].sourceUrl).toBe(""); // 交给 ingestion 的就得是 ""
      expect(h.rows()[0]!.sourceUrl).toBe(""); // 库里因此也是 ""，与查询键一致（历史行本来就是 ""）
    });

    it("带 link 的条目（对照组）两轮也只入一份：link 口径本就正确，不许改坏", async () => {
      const files = (): CloudFile[] => [
        {
          id: "r1", name: "with-link.md", type: "file", mimeType: "text/markdown", size: 2,
          downloadUrl: "https://feed.example.test/posts/1", modifiedAt: new Date("2026-01-02T00:00:00Z"),
        },
      ];
      const h = harness(inlineConnector(files), RSS_DS);

      expect((await h.syncOnce()).landed).toBe(1);
      expect((await h.syncOnce()).landed).toBe(0);
      expect(h.rows()).toHaveLength(1);
      // 有链接时 sourceUrl 存的就是链接本身（历史行的既有口径）
      expect(h.rows()[0]!.sourceUrl).toBe("https://feed.example.test/posts/1");
    });

    it("无 link 的网盘条目（链接靠 getDownloadUrl 现取）同样不得每轮重复入库", async () => {
      // Given: cloud_drive 文件 id 稳定、listFiles 不给 downloadUrl（115 就是这样）。
      const connector = cloudConnector({
        name: "115",
        listFiles: vi.fn().mockResolvedValue([
          { id: "fid-1", name: "a.md", type: "file", mimeType: "text/markdown", size: 5, modifiedAt: new Date("2026-01-02T00:00:00Z") },
        ]),
        getDownloadUrl: vi.fn().mockResolvedValue("https://dl.example.test/fid-1"),
      });
      const h = harness(connector, DRIVE_DS);

      expect((await h.syncOnce()).landed).toBe(1);
      expect((await h.syncOnce()).landed).toBe(0);
      expect(h.rows()).toHaveLength(1);
    });
  });

  describe("M-3：去重命中却无法比较新旧时必须跳过（没有发布日期 ≠ 永远重入）", () => {
    it("没有发布时间的 rss 条目：第二次同步必须 skipped（修复前每轮都重复入库）", async () => {
      // Given: 条目没有 pubDate → CloudFile.modifiedAt 为 undefined → 落库 metadata 里
      // 根本没有 remoteModifiedAt 这个键。
      const files = (): CloudFile[] => [
        {
          id: "u1", name: "undated.md", type: "file", mimeType: "text/markdown", size: 2,
          downloadUrl: "https://feed.example.test/u/1",
        },
      ];
      const h = harness(inlineConnector(files), RSS_DS);

      // When: 连续三轮同步（模拟"这个订阅源从来不写日期"的日常）。
      const first = await h.syncOnce();
      const second = await h.syncOnce();
      const third = await h.syncOnce();

      // Then: 只有第一轮入库。缺陷现场（修复前）：跳过要求两侧时间都有值，
      // newModifiedAt === undefined → 永远不跳 → 每轮都再入一份。
      expect(first.landed).toBe(1);
      expect(second.landed).toBe(0);
      expect(third.landed).toBe(0);
      expect(second.message).toContain("跳过 1");
      expect(h.rows()).toHaveLength(1);
    });

    it("有发布时间且没有变化 → 仍然跳过（既有正确行为不许退化）", async () => {
      const files = (): CloudFile[] => [
        {
          id: "d1", name: "dated.md", type: "file", mimeType: "text/markdown", size: 2,
          downloadUrl: "https://feed.example.test/d/1", modifiedAt: new Date("2026-05-05T00:00:00Z"),
        },
      ];
      const h = harness(inlineConnector(files), RSS_DS);
      expect((await h.syncOnce()).landed).toBe(1);
      expect((await h.syncOnce()).landed).toBe(0);
      expect(h.rows()).toHaveLength(1);
    });

    it("有发布时间且变新了 → 仍要重新入库（跳过规则不许把更新也吞掉）", async () => {
      let current: CloudFile[] = [
        {
          id: "d2", name: "updated.md", type: "file", mimeType: "text/markdown", size: 2,
          downloadUrl: "https://feed.example.test/d/2", modifiedAt: new Date("2026-05-05T00:00:00Z"),
        },
      ];
      const h = harness(inlineConnector(() => current), RSS_DS);

      expect((await h.syncOnce()).landed).toBe(1);
      // 源站原地更新了这条条目（同一 guid，发布时间变新）
      current = [
        {
          id: "d2", name: "updated.md", type: "file", mimeType: "text/markdown", size: 2,
          downloadUrl: "https://feed.example.test/d/2", modifiedAt: new Date("2026-06-06T00:00:00Z"),
        },
      ];
      const updated = await h.syncOnce();
      expect(updated.landed).toBe(1);
      expect(updated.message).toContain("成功 1");
      // 再同步一次（时间没再变）→ 回到跳过
      expect((await h.syncOnce()).landed).toBe(0);
      expect(h.rows()).toHaveLength(2);
    });

    it("历史行没有 remoteModifiedAt、条目现在有时间 → 也算无法比较：跳过并停止重复入库", async () => {
      // Given: 第一轮按"无发布时间"入库（metadata 里没有 remoteModifiedAt 键），
      // 第二轮源站补上了 pubDate —— 这正是"新条目后来才有时间"的现实形态。
      let current: CloudFile[] = [
        { id: "m1", name: "late-date.md", type: "file", mimeType: "text/markdown", size: 2, downloadUrl: "https://feed.example.test/m/1" },
      ];
      const h = harness(inlineConnector(() => current), RSS_DS);
      expect((await h.syncOnce()).landed).toBe(1);

      current = [
        {
          id: "m1", name: "late-date.md", type: "file", mimeType: "text/markdown", size: 2,
          downloadUrl: "https://feed.example.test/m/1", modifiedAt: new Date("2026-07-07T00:00:00Z"),
        },
      ];
      const second = await h.syncOnce();
      // 无法比较（历史侧缺值）→ 判无变化跳过。取舍见报告：宁可不重入，不再刷重复文档。
      expect(second.landed).toBe(0);
      expect(h.rows()).toHaveLength(1);
    });

    it("没有 mtime 的网盘文件（115 就是如此）：第二轮起跳过，不再每轮刷一份重复文档", async () => {
      // Given: 115 的 CloudFile 从来不填 modifiedAt（list115Files 只给 id/name/type/size/mime）。
      const connector = cloudConnector({
        name: "115",
        listFiles: vi.fn().mockResolvedValue([
          { id: "fid-2", name: "movie.md", type: "file", mimeType: "text/markdown", size: 9, downloadUrl: "https://dl.example.test/fid-2" },
        ]),
      });
      const h = harness(connector, DRIVE_DS);

      const first = await h.syncOnce();
      const second = await h.syncOnce();
      expect(first.landed).toBe(1);
      // 取舍（M-3）：无法比较新旧 → 判"无变化"跳过。宁可漏掉一次原地更新，
      // 也不再往知识库里刷重复文档；有 mtime 的源（alist/nas 正常文件）行为完全不变。
      expect(second.landed).toBe(0);
      expect(second.message).toContain("跳过 1");
      expect(h.rows()).toHaveLength(1);
    });
  });
});

// ═══ 内容流（2026-10-01）：数据源页「内容」按钮的后端 —— 按源聚合、跨批次、时间倒序 ═══
// 口径：metadata.dataSourceId 用 CAST AS TEXT 逐字比对（SQLite ->> 的 JSON 值与 TEXT 恒不等，
// 正是去重 bug 的根因——这里从第一天就按正确口径写，测试钉死）。
describe("datasourceRouter · getContentStream（按源聚合的文章流）", () => {
  const DDL = `
    CREATE TABLE data_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, config TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      lastSyncAt INTEGER, lastError TEXT, createdBy INTEGER,
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

  type SeedItem = {
    jobId?: number;
    name?: string;
    status?: string;
    sourceUrl?: string | null;
    documentId?: number | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: number;
  };

  function streamHarness(dsId: number, items: readonly SeedItem[]) {
    const raw = new Database(":memory:");
    raw.exec(DDL);
    raw
      .prepare(
        `INSERT INTO data_sources (id, name, type, config, status, createdAt, updatedAt)
         VALUES (?, '流测试源', 'rss', '{}', 'connected', 0, 0)`,
      )
      .run(dsId);
    const ins = raw.prepare(
      `INSERT INTO ingestion_items (jobId, externalId, name, mimeType, size, status, error,
                                    sourceUrl, storagePath, documentId, metadata, createdAt, updatedAt)
       VALUES (@jobId, NULL, @name, NULL, NULL, @status, NULL, @sourceUrl, NULL, @documentId, @metadata, @createdAt, @createdAt)`,
    );
    items.forEach((it, i) =>
      ins.run({
        jobId: it.jobId ?? 1,
        name: it.name ?? `条目${i}`,
        status: it.status ?? "completed",
        sourceUrl: it.sourceUrl ?? null,
        documentId: it.documentId ?? null,
        metadata: JSON.stringify(it.metadata ?? { dataSourceId: dsId, platform: "rss" }),
        createdAt: it.createdAt ?? 1000 + i,
      }),
    );
    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
    return datasourceRouter.createCaller(fakeContext());
  }

  it("只返回该数据源的条目：metadata.dataSourceId 按 CAST TEXT 逐字比对（源1 与 源2 不串）", async () => {
    const caller = streamHarness(1, [
      { name: "甲源文章A", metadata: { dataSourceId: 1, platform: "rss" } },
      { name: "乙源文章B", metadata: { dataSourceId: 2, platform: "rss" } },
      { name: "甲源文章C", metadata: { dataSourceId: 1, platform: "rss" } },
    ]);
    const stream = await caller.getContentStream({ dataSourceId: 1 });
    expect(stream.map((r) => r.name)).toEqual(["甲源文章C", "甲源文章A"]);
  });

  it("跨同步批次聚合（不同 jobId 的多轮同步都进来）且按时间倒序", async () => {
    const caller = streamHarness(7, [
      { jobId: 1, name: "第一轮旧文", createdAt: 1000 },
      { jobId: 2, name: "第二轮新文", createdAt: 2000 },
      { jobId: 3, name: "第三轮最新", createdAt: 3000 },
    ]);
    const stream = await caller.getContentStream({ dataSourceId: 7 });
    expect(stream.map((r) => r.name)).toEqual(["第三轮最新", "第二轮新文", "第一轮旧文"]);
  });

  it("只收 completed：解析失败的条目不进阅读流", async () => {
    const caller = streamHarness(3, [
      { name: "好文章", status: "completed" },
      { name: "坏文章", status: "failed" },
    ]);
    const stream = await caller.getContentStream({ dataSourceId: 3 });
    expect(stream.map((r) => r.name)).toEqual(["好文章"]);
  });

  it("返回阅读所需最小字段：标题/原文链接/文档指针/入库时间（timestamp_ms → Date）", async () => {
    const caller = streamHarness(9, [
      { name: "带文档的文章", sourceUrl: "https://example.test/a", documentId: 42 },
    ]);
    const [row] = await caller.getContentStream({ dataSourceId: 9 });
    expect(row).toMatchObject({
      name: "带文档的文章",
      sourceUrl: "https://example.test/a",
      documentId: 42,
    });
    expect(row!.createdAt).toBeInstanceOf(Date);
  });
});

// ═══ 按源归档（2026-10-01）：同步进知识库的文档落进「数据源/<源名>」文件夹 ═══
// 用户诉求：「根据对应的数据源新建一个文件夹…所有的数据源文件夹都在一个总的数据源文件夹里」。
describe("datasourceRouter · sync 按源归档到知识库文件夹", () => {
  const DDL = `
    CREATE TABLE data_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, config TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      lastSyncAt INTEGER, lastError TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
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
    CREATE TABLE kb_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, parentId INTEGER,
      icon TEXT DEFAULT 'folder', sortOrder INTEGER DEFAULT 0, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
  `;

  type SeedFolderDs = { id: number; name: string };

  function folderHarness(sources: readonly SeedFolderDs[], files: () => CloudFile[]) {
    const raw = new Database(":memory:");
    raw.exec(DDL);
    const insertDs = raw.prepare(
      `INSERT INTO data_sources (id, name, type, config, status, createdAt, updatedAt)
       VALUES (@id, @name, 'rss', '{"platform":"rss"}', 'disconnected', 0, 0)`,
    );
    for (const s of sources) insertDs.run({ id: s.id, name: s.name });

    let clock = 1000;
    // 记录每轮 ingestFile 拿到的 folderId（"文档归档到哪个夹"的观测点）
    const folderIds: Array<number | null | undefined> = [];
    vi.mocked(ingestFile).mockImplementation(async (opts) => {
      folderIds.push(opts.folderId);
      const itemId = folderIds.length;
      raw
        .prepare(
          `INSERT INTO ingestion_items (jobId, externalId, name, mimeType, size, status, error,
                                        sourceUrl, storagePath, documentId, metadata, createdAt, updatedAt)
           VALUES (1, @externalId, @name, 'text/markdown', 10, 'completed', NULL,
                   @sourceUrl, NULL, NULL, @metadata, @ts, @ts)`,
        )
        .run({
          externalId: opts.externalId ?? null,
          name: opts.fileName,
          sourceUrl: opts.sourceUrl ?? null,
          metadata: JSON.stringify({ ...(opts.metadata ?? {}), uploadedFileId: null }),
          ts: (clock += 1),
        });
      return { itemId };
    });

    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
    vi.mocked(getConnector).mockReturnValue(
      cloudConnector({
        name: "rss",
        listFiles: vi.fn().mockImplementation(async () => files()),
        getContent: vi.fn().mockResolvedValue({ fileName: "e.md", mimeType: "text/markdown", content: "# body" }),
      }),
    );

    return {
      caller: datasourceRouter.createCaller(fakeContext()),
      raw,
      folderIds,
      folders: () =>
        raw.prepare("SELECT id, name, parentId FROM kb_folders ORDER BY id").all() as Array<{
          id: number;
          name: string;
          parentId: number | null;
        }>,
    };
  }

  /** 每轮调用给出"更新一点"的条目时间，使第二轮真的会重新入库（幂等性才被测到）。 */
  function changingFiles(): () => CloudFile[] {
    let round = 0;
    return () => {
      round += 1;
      return [
        {
          id: "entry-1",
          name: "Entry One",
          type: "file",
          mimeType: "text/markdown",
          size: 10,
          downloadUrl: "https://feed.example.test/1",
          modifiedAt: new Date(Date.UTC(2026, 0, round)),
        },
      ];
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(env.uploadDir, { recursive: true, force: true });
  });

  it("首次同步：建「数据源」总夹 + 以源名命名的子夹，并把子夹 id 交给 ingestFile", async () => {
    const h = folderHarness([{ id: 1, name: "量子位" }], changingFiles());

    await h.caller.sync({ id: 1 });

    const folders = h.folders();
    const root = folders.find((f) => f.name === "数据源");
    const child = folders.find((f) => f.name === "量子位");
    expect(root).toBeDefined();
    expect(root!.parentId).toBeNull();
    expect(child).toBeDefined();
    expect(child!.parentId).toBe(root!.id);
    expect(h.folderIds).toEqual([child!.id]);
  });

  it("幂等：第二轮同步不重复建夹，且仍指向同一个子夹", async () => {
    const h = folderHarness([{ id: 1, name: "量子位" }], changingFiles());

    await h.caller.sync({ id: 1 });
    await h.caller.sync({ id: 1 });

    expect(h.folders()).toHaveLength(2); // 「数据源」+「量子位」，不重复
    const childId = h.folders().find((f) => f.name === "量子位")!.id;
    expect(h.folderIds).toEqual([childId, childId]);
  });

  it("多个源共用一个总夹，各有自己的子夹", async () => {
    const h = folderHarness(
      [
        { id: 1, name: "量子位" },
        { id: 2, name: "Solidot" },
      ],
      changingFiles(),
    );

    await h.caller.sync({ id: 1 });
    const firstChildId = h.folderIds[0];
    await h.caller.sync({ id: 2 });

    const folders = h.folders();
    const roots = folders.filter((f) => f.name === "数据源");
    const children = folders.filter((f) => f.parentId === roots[0]!.id);
    expect(roots).toHaveLength(1); // 总夹只有一个
    expect(children.map((c) => c.name).sort()).toEqual(["Solidot", "量子位"]);
    expect(h.folderIds[1]).not.toBe(firstChildId); // 两个源各进各的夹
  });

  it("空源不留空夹：没有内容入库就不建文件夹（懒创建）", async () => {
    const h = folderHarness([{ id: 1, name: "空源" }], () => []);

    await h.caller.sync({ id: 1 });

    expect(h.folders()).toEqual([]);
  });
});

// ═══ 历史内容归位（2026-10-01）：一键把早先悬空的文档挪进「数据源/<源名>」 ═══
// 取舍：**只归位尚未归档的文档**（folderId IS NULL），用户手动放好的位置不动。
describe("datasourceRouter · organizeExisting 历史内容归位", () => {
  const DDL = `
    CREATE TABLE data_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, config TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      lastSyncAt INTEGER, lastError TEXT, createdBy INTEGER,
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
      folderId INTEGER, title TEXT NOT NULL, content TEXT,
      format TEXT NOT NULL DEFAULT 'markdown', tags TEXT, metadata TEXT, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kb_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, parentId INTEGER,
      icon TEXT DEFAULT 'folder', sortOrder INTEGER DEFAULT 0, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
    );
  `;

  type HistoricalItem = { dataSourceId: number; documentId: number };

  function organizeHarness(dsName: string, items: readonly HistoricalItem[], manualFolderId?: number) {
    const raw = new Database(":memory:");
    raw.exec(DDL);
    raw
      .prepare(
        `INSERT INTO data_sources (id, name, type, config, status, createdAt, updatedAt)
         VALUES (1, ?, 'rss', '{"platform":"rss"}', 'connected', 0, 0)`,
      )
      .run(dsName);

    let clock = 1000;
    const insItem = raw.prepare(
      `INSERT INTO ingestion_items (jobId, externalId, name, mimeType, size, status, error,
                                    sourceUrl, storagePath, documentId, metadata, createdAt, updatedAt)
       VALUES (1, @externalId, @name, 'text/markdown', 10, 'completed', NULL,
               'https://feed.example.test/@n', NULL, @documentId, @metadata, @ts, @ts)`,
    );
    const insDoc = raw.prepare(
      `INSERT INTO kb_documents (id, folderId, title, content, format, tags, metadata, createdBy, createdAt, updatedAt)
       VALUES (@id, @folderId, @title, '正文', 'markdown', '[]', '{}', NULL, 0, 0)`,
    );
    for (const it of items) {
      insItem.run({
        externalId: `hist-${it.documentId}`,
        name: `历史条目 ${it.documentId}`,
        documentId: it.documentId,
        metadata: JSON.stringify({ dataSourceId: it.dataSourceId, platform: "rss" }),
        ts: (clock += 1),
      });
      insDoc.run({ id: it.documentId, folderId: manualFolderId ?? null, title: `历史文档 ${it.documentId}` });
    }

    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
    return {
      caller: datasourceRouter.createCaller(fakeContext()),
      raw,
      docFolder: (id: number) =>
        (raw.prepare("SELECT folderId FROM kb_documents WHERE id = ?").get(id) as { folderId: number | null }).folderId,
      folders: () => raw.prepare("SELECT id, name, parentId FROM kb_folders ORDER BY id").all() as Array<{
        id: number;
        name: string;
        parentId: number | null;
      }>,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("把历史悬空文档归位到「数据源/<源名>」，已手动归档的文档不动", async () => {
    // 文档 11 悬空（folderId = null）→ 应归位；文档 12 已手动放进夹 99 → 不许动
    const h = organizeHarness("量子位", [{ dataSourceId: 1, documentId: 11 }], undefined);
    h.raw
      .prepare(
        `INSERT INTO ingestion_items (jobId, externalId, name, mimeType, size, status, error,
                                      sourceUrl, storagePath, documentId, metadata, createdAt, updatedAt)
         VALUES (1, 'hist-12', '历史条目 12', 'text/markdown', 10, 'completed', NULL,
                 'https://feed.example.test/12', NULL, 12, '{"dataSourceId":1,"platform":"rss"}', 2000, 2000)`,
      )
      .run();
    h.raw
      .prepare(
        `INSERT INTO kb_documents (id, folderId, title, content, format, tags, metadata, createdBy, createdAt, updatedAt)
         VALUES (12, 99, '历史文档 12', '正文', 'markdown', '[]', '{}', NULL, 0, 0)`,
      )
      .run();

    const result = await h.caller.organizeExisting();

    const root = h.folders().find((f) => f.name === "数据源")!;
    const child = h.folders().find((f) => f.name === "量子位")!;
    expect(child.parentId).toBe(root.id);
    expect(h.docFolder(11)).toBe(child.id); // 悬空的归位了
    expect(h.docFolder(12)).toBe(99); // 手动归档的不动
    expect(result).toMatchObject({ moved: 1 });
  });

  it("可重复点击：第二轮不再建夹、也不再挪动（幂等）", async () => {
    const h = organizeHarness("量子位", [{ dataSourceId: 1, documentId: 11 }]);

    await h.caller.organizeExisting();
    const second = await h.caller.organizeExisting();

    expect(h.folders()).toHaveLength(2);
    expect(second).toMatchObject({ moved: 0 });
  });

  it("没有任何历史内容时：不建夹、不报错", async () => {
    const h = organizeHarness("空源", []);

    const result = await h.caller.organizeExisting();

    expect(h.folders()).toEqual([]);
    expect(result).toMatchObject({ moved: 0 });
  });
});
