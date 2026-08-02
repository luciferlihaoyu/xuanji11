import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey } from "./lib/auth";
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
