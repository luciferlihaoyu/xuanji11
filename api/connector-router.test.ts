import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { User } from "@db/schema";
import * as fullSchema from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";
import {
  searchContext,
  writeTaskMemory,
  linkArtifact,
  getMemoryDigest,
  startIngestion,
} from "./lib/connector-actions";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

// 完全 mock connector-actions：5 个动作用 vi.fn，schema 用宽松 passthrough。
// 这样 router 模块加载时不会真实引入 connector-actions 的传递依赖
// （hybrid-search / vector / document-indexer / ingestion → vector-service），
// 从而避免本容器无 ld-linux 时 Zvec 原生二进制加载崩溃。
vi.mock("./lib/connector-actions", () => {
  const loose = () => z.object({}).passthrough();
  return {
    searchContext: vi.fn(),
    writeTaskMemory: vi.fn(),
    linkArtifact: vi.fn(),
    getMemoryDigest: vi.fn(),
    startIngestion: vi.fn(),
    searchContextInputSchema: loose(),
    writeTaskMemoryInputSchema: loose(),
    linkArtifactInputSchema: loose(),
    getMemoryDigestInputSchema: loose(),
    startIngestionInputSchema: loose(),
  };
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

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

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

// t2 补测：saveConfig 会调 logAudit（审计第二落点），mock 掉以便直接断言其入参。
vi.mock("./lib/audit", () => ({ logAudit: vi.fn(), logAction: vi.fn() }));

// ingestFiles 的用例需要把「连接器」和「入库」两头都换成桩：
//   · ./connectors：getDownloadUrl 真实现要发网络请求；
//   · ./lib/ingestion：真实现会连锁加载 document-indexer → vector-service（Zvec 原生二进制），
//     本容器加载不了。router 里是 `await import("./lib/ingestion")` 动态导入，vitest 的模块
//     注册表对动态导入同样生效，故此处静态 vi.mock 即可拦住。
vi.mock("./connectors", () => ({ getConnector: vi.fn(), listConnectors: vi.fn() }));
vi.mock("./lib/ingestion", () => ({ ingestFile: vi.fn() }));

import { logAudit } from "./lib/audit";
import { MASK } from "./lib/setting-mask";
import { getConnector } from "./connectors";
import { ingestFile } from "./lib/ingestion";
import { connectorRouter } from "./connector-router";

const runSearchContext = vi.mocked(searchContext);
const runWriteTaskMemory = vi.mocked(writeTaskMemory);
const runLinkArtifact = vi.mocked(linkArtifact);
const runGetMemoryDigest = vi.mocked(getMemoryDigest);
const runStartIngestion = vi.mocked(startIngestion);

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

function makeContext(auth: AuthInfo) {
  return {
    req: new Request("http://localhost:3000/"),
    resHeaders: new Headers(),
    user: fakeUser(),
    auth,
  } as never;
}

function authWith(...scopes: string[]): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes };
}

const noScope = authWith("zvec:read");
const knowledgeRead = authWith("knowledge:read");
const knowledgeWrite = authWith("knowledge:read", "knowledge:write");
const artifactLink = authWith("artifact:link");
const ingestionWrite = authWith("ingestion:write");
const allScopes = authWith("knowledge:read", "knowledge:write", "artifact:link", "ingestion:write");

const trace = { taskId: "t-1", traceId: "tr-1", agentId: "a-1", originSystem: "tiangong" };

describe("connectorRouter scoped integration procedures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue({} as never);
  });

  describe("searchContext (knowledge:read)", () => {
    it("rejects when knowledge:read scope is missing", async () => {
      const caller = connectorRouter.createCaller(makeContext(noScope));
      await expect(caller.searchContext({ query: "q", trace })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(runSearchContext).not.toHaveBeenCalled();
    });

    it("delegates to the action when the scope is present", async () => {
      const caller = connectorRouter.createCaller(makeContext(knowledgeRead));
      runSearchContext.mockResolvedValue({ results: [], graphHints: [], memoryDigest: "", trace });
      const result = await caller.searchContext({ query: "不动产登记", limit: 8, trace });
      expect(runSearchContext).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ results: [] });
    });
  });

  describe("writeTaskMemory (knowledge:write)", () => {
    it("rejects without knowledge:write", async () => {
      const caller = connectorRouter.createCaller(makeContext(knowledgeRead));
      await expect(
        caller.writeTaskMemory({ task: { taskId: "t-1", name: "n", type: "analysis", status: "done" }, memory: { project: "p", title: "m", contentMarkdown: "c" } }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(runWriteTaskMemory).not.toHaveBeenCalled();
    });

    it("delegates to the action when the scope is present", async () => {
      const caller = connectorRouter.createCaller(makeContext(knowledgeWrite));
      runWriteTaskMemory.mockResolvedValue({ documentId: 1, nodeIds: [2, 3], edgeIds: [4], chunkCount: 2, vectorized: true });
      const input = {
        task: { taskId: "t-1", traceId: "tr-1", name: "分析任务", type: "analysis" as const, status: "done" as const, agentId: "a-1" },
        memory: { project: "不动产", title: "记忆", summary: "s", contentMarkdown: "c", tags: ["x"], decisions: [], artifacts: [] },
        trace,
      };
      const result = await caller.writeTaskMemory(input);
      expect(runWriteTaskMemory).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ documentId: 1, vectorized: true });
    });
  });

  describe("linkArtifact (artifact:link)", () => {
    it("rejects without artifact:link", async () => {
      const caller = connectorRouter.createCaller(makeContext(knowledgeWrite));
      await expect(
        caller.linkArtifact({ taskId: "t-1", traceId: "tr-1", documentId: 1, artifact: { artifactRef: "ref", downloadUrl: "u" } }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(runLinkArtifact).not.toHaveBeenCalled();
    });

    it("delegates to the action when the scope is present", async () => {
      const caller = connectorRouter.createCaller(makeContext(artifactLink));
      runLinkArtifact.mockResolvedValue({ linked: true, nodeId: 9, edgeId: 10 });
      const input = {
        taskId: "t-1",
        traceId: "tr-1",
        documentId: 1,
        artifact: { artifactRef: "art-1", downloadUrl: "https://x/1", mimeType: "application/pdf", sha256: "abc", size: 10 },
        trace,
      };
      const result = await caller.linkArtifact(input);
      expect(runLinkArtifact).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ linked: true });
    });
  });

  describe("getMemoryDigest (knowledge:read)", () => {
    it("rejects without knowledge:read", async () => {
      const caller = connectorRouter.createCaller(makeContext(noScope));
      await expect(caller.getMemoryDigest({ project: "p", trace })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(runGetMemoryDigest).not.toHaveBeenCalled();
    });

    it("delegates to the action when the scope is present", async () => {
      const caller = connectorRouter.createCaller(makeContext(knowledgeRead));
      runGetMemoryDigest.mockResolvedValue({ digest: "d", keyDecisions: [], openRisks: [], sourceDocumentIds: [1] });
      const result = await caller.getMemoryDigest({ project: "不动产", scope: "project", maxTokens: 1000, trace });
      expect(runGetMemoryDigest).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ digest: "d" });
    });
  });

  describe("startIngestion (ingestion:write)", () => {
    it("rejects without ingestion:write", async () => {
      const caller = connectorRouter.createCaller(makeContext(artifactLink));
      await expect(
        caller.startIngestion({ sourceType: "upload", source: { kind: "path", path: "/tmp/x.pdf" }, trace }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(runStartIngestion).not.toHaveBeenCalled();
    });

    it("delegates to the action when the scope is present", async () => {
      const caller = connectorRouter.createCaller(makeContext(ingestionWrite));
      runStartIngestion.mockResolvedValue({ jobId: 7, status: "pending", itemCount: 0, trace });
      const result = await caller.startIngestion({
        sourceType: "upload",
        source: { kind: "path", path: "/tmp/x.pdf" },
        options: { project: "不动产", vectorize: true },
        trace,
      });
      expect(runStartIngestion).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ jobId: 7, status: "pending" });
    });
  });

  it("allows each procedure with a fully-scoped auth", async () => {
    const caller = connectorRouter.createCaller(makeContext(allScopes));
    runSearchContext.mockResolvedValue({ results: [], graphHints: [], memoryDigest: "", trace });
    runWriteTaskMemory.mockResolvedValue({ documentId: 1, nodeIds: [], edgeIds: [], chunkCount: 0, vectorized: false });
    runLinkArtifact.mockResolvedValue({ linked: true, nodeId: 1, edgeId: 2 });
    runGetMemoryDigest.mockResolvedValue({ digest: "", keyDecisions: [], openRisks: [], sourceDocumentIds: [] });
    runStartIngestion.mockResolvedValue({ jobId: 1, status: "pending", itemCount: 0, trace });

    await expect(caller.searchContext({ query: "q" })).resolves.toBeDefined();
    await expect(
      caller.writeTaskMemory({ task: { taskId: "t", name: "n", type: "analysis", status: "done" }, memory: { project: "p", title: "m", contentMarkdown: "c" } }),
    ).resolves.toBeDefined();
    await expect(
      caller.linkArtifact({ taskId: "t", traceId: "tr", documentId: 1, artifact: { artifactRef: "r", downloadUrl: "u" } }),
    ).resolves.toBeDefined();
    await expect(caller.getMemoryDigest({ project: "p" })).resolves.toBeDefined();
    await expect(caller.startIngestion({ sourceType: "upload", source: { kind: "path", path: "/tmp/x" } })).resolves.toBeDefined();
  });
});

/**
 * t2 复核补测：连接器配置的掩码写侧语义（此前零覆盖）。
 *
 * 威胁/事故模型：getConfig 出参已掩码（maskConnectorConfig），编辑页原样回传时
 * ① 若不剥除 —— "***masked***" 作为真实密码落库，静默毁掉连接器；
 * ② 若只剥除不合并 —— 用户仅改 url（密码键缺席）时旧密码被清空，同样毁掉连接器。
 * 两条都是功能性事故，用真实内存 SQLite 断言落库形态（system_settings 表按 @db/schema 手写 DDL）。
 */
describe("connectorRouter config masking (t2)", () => {
  const DDL = `
    CREATE TABLE system_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT,
      category TEXT DEFAULT 'general',
      updatedBy INTEGER,
      updatedAt INTEGER NOT NULL DEFAULT 0
    );
  `;
  const CONFIG_KEY = "connector_115_config";

  function harness(seedValue: string | null) {
    const raw = new Database(":memory:");
    raw.exec(DDL);
    if (seedValue !== null) {
      raw.prepare(
        `INSERT INTO system_settings (key, value, category, updatedAt) VALUES (?, ?, 'connector', 0)`,
      ).run(CONFIG_KEY, seedValue);
    }
    vi.mocked(getDb).mockReturnValue(drizzle(raw, { schema: fullSchema }) as never);
    const caller = connectorRouter.createCaller(makeContext(sessionAuth(fakeUser())));
    return {
      caller,
      storedConfig: (): Record<string, unknown> | null => {
        const row = raw
          .prepare(`SELECT value FROM system_settings WHERE key = ?`)
          .get(CONFIG_KEY) as { value: string | null } | undefined;
        return row?.value ? (JSON.parse(row.value) as Record<string, unknown>) : null;
      },
      auditDetails: (): string =>
        vi.mocked(logAudit)
          .mock.calls.map((call) => JSON.stringify(call[4] ?? null))
          .join("\n"),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the stored password when the masked placeholder is submitted", async () => {
    const h = harness(JSON.stringify({ url: "https://pan.example.com", password: "real-password" }));

    await h.caller.saveConfig({
      platform: "115",
      config: { url: "https://pan.example.com", password: MASK },
    });

    const cfg = h.storedConfig();
    expect(cfg?.password).toBe("real-password"); // 掩码绝不落库
    expect(JSON.stringify(cfg)).not.toContain(MASK);
  });

  it("merges the untouched secret back when only a non-secret field changes", async () => {
    const h = harness(JSON.stringify({ url: "https://old.example.com", password: "real-password" }));

    // 用户只改了 url；密码键因前端置空剔除而不在提交里
    await h.caller.saveConfig({ platform: "115", config: { url: "https://new.example.com" } });

    const cfg = h.storedConfig();
    expect(cfg?.url).toBe("https://new.example.com");
    expect(cfg?.password).toBe("real-password"); // 只剥除不合并会在此清空密码
  });

  it("overwrites the stored secret with a newly submitted plaintext", async () => {
    const h = harness(JSON.stringify({ url: "https://pan.example.com", password: "old-password" }));

    await h.caller.saveConfig({ platform: "115", config: { password: "new-password" } });

    expect(h.storedConfig()?.password).toBe("new-password");
  });

  it("never writes plaintext secrets into the audit log", async () => {
    const h = harness(JSON.stringify({ password: "old-password" }));

    await h.caller.saveConfig({ platform: "115", config: { password: "brand-new-secret" } });

    const audit = h.auditDetails();
    expect(audit).not.toContain("brand-new-secret");
    expect(audit).not.toContain("old-password");
    expect(audit).toContain("115"); // 平台名保留，审计仍可追溯
  });
});

/**
 * 网盘导入（ingestFiles）的结果口径（2026-11）。
 *
 * 缺口：ingestFile 对「文档已入库但索引失败」不再抛错，而是回报 indexed:false + 原始原因。
 * 旧实现无条件 push `{ ok: true, documentId }`，于是这类**检索不到**的文档被报成完全成功。
 *
 * 口径裁决（不把 ok 改成 false）：ok:false 会让调用方（天宫 / openclaw 侧）重试，
 * 而 externalId 去重不覆盖 connector 导入路径 —— 重试会产生**重复文档**；但隐藏失败又不诚实。
 * 因此照实保留 ok:true（文档确实入库了），另加 indexed:false + warning 把失败信号露出来。
 */
describe("connectorRouter ingestFiles 的索引状态口径", () => {
  function harness() {
    const connectorStub = { getDownloadUrl: vi.fn(async () => "https://dl.example.test/f1") };
    vi.mocked(getConnector).mockReturnValue(connectorStub as never);
    const dbStub = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ value: JSON.stringify({ baseUrl: "https://pan.example.com" }) }]),
        }),
      }),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as never);
    return {
      caller: connectorRouter.createCaller(makeContext(sessionAuth(fakeUser()))),
      connectorStub,
    };
  }

  const file = { path: "/docs/a.md", name: "a.md", size: 10 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("文档入库但索引失败：ok 仍为 true（不诱发重试重复入库），但必须带 indexed:false + warning", async () => {
    // Given: ingestFile 正常返回，只是 indexed === false（嵌入服务不可用，文档已入库但检索不到）。
    const { caller } = harness();
    vi.mocked(ingestFile).mockResolvedValue({
      itemId: 5,
      documentId: 42,
      indexed: false,
      indexError: "嵌入服务不可用：已拒绝写入 hash 伪向量",
    });

    // When: 从网盘导入一个文件。
    const result = await caller.ingestFiles({ platform: "115", files: [file] });

    // Then: 不诱导重试，但失败信号必须可见。
    expect(result.success).toBe(true);
    expect(result.results[0]).toMatchObject({ path: "/docs/a.md", ok: true, documentId: 42, indexed: false });
    const warning = String(result.results[0]?.warning);
    expect(warning).toContain("索引失败");
    expect(warning).toContain("嵌入服务不可用");
  });

  it("索引成功时结果保持原样，不带 indexed/warning（不给日常成功加噪音）", async () => {
    // Given: 正常索引成功。
    const { caller } = harness();
    vi.mocked(ingestFile).mockResolvedValue({ itemId: 6, documentId: 43, indexed: true });

    // When: 导入同一个文件。
    const result = await caller.ingestFiles({ platform: "115", files: [file] });

    // Then: 出参与改动前一致（ok:true + documentId），没有多余字段。
    expect(result.results[0]).toEqual({ path: "/docs/a.md", ok: true, documentId: 43 });
  });

  it("ingestFile 抛错（压根没入库）维持 ok:false + error，不塞 warning", async () => {
    // Given: 下载/解析阶段直接炸掉 —— 文档根本没入库。
    const { caller } = harness();
    vi.mocked(ingestFile).mockRejectedValue(new Error("Download failed: 404"));

    // When: 导入同一个文件。
    const result = await caller.ingestFiles({ platform: "115", files: [file] });

    // Then: 既有失败形态保持不变（ok:false 会触发调用方重试，这里是对的：库中无脏文档）。
    expect(result.results[0]).toMatchObject({ path: "/docs/a.md", ok: false });
    expect(String(result.results[0]?.error)).toContain("Download failed");
    expect(result.results[0]).not.toHaveProperty("warning");
    expect(result.results[0]).not.toHaveProperty("indexed");
  });
});
