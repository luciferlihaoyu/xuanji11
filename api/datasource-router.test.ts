import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@db/schema";
import { dataSources } from "@db/schema";
import type { TrpcContext } from "./context";
import { getDb } from "./queries/connection";
import { sessionAuth } from "./lib/auth";
import { getConnector } from "./connectors";
import { ingestFile } from "./lib/ingestion";
import { logAudit } from "./lib/audit";
import type { CloudConnector } from "./connectors/base";
import { datasourceRouter } from "./datasource-router";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
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

function createFakeDb(seed: readonly DataSourceRow[] = []) {
  const rows = seed.map((row) => ({ ...row }));
  const readRows = () => rows.map((row) => ({ ...row }));

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() =>
          table === dataSources
            ? Promise.resolve(readRows())
            : { orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) },
        ),
        orderBy: vi.fn(() => Promise.resolve(table === dataSources ? readRows() : [])),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve([{ insertId: 1 }])),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  };
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

function callerWith(seed: readonly DataSourceRow[]) {
  const db = createFakeDb(seed);
  vi.mocked(getDb).mockReturnValue(db as never);
  return { db, caller: datasourceRouter.createCaller(fakeContext()) };
}

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
      expect(result.message).toContain("1 处理");
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
