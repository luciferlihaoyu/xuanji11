import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";
import { tryIndexDocumentById } from "./lib/document-indexer";
import { vectorEngine } from "./lib/vector";
import { deleteDocumentCascade } from "./lib/document-removal";

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

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/vector", () => ({
  vectorEngine: { deleteByDocumentId: vi.fn().mockResolvedValue(3) },
}));

vi.mock("./lib/document-indexer", () => ({
  tryIndexDocumentById: vi.fn().mockResolvedValue({ chunks: 2 }),
  indexDocumentById: vi.fn(),
  startReindexAll: vi.fn(),
  getReindexProgress: vi.fn(),
}));

// document_delete 测试 mock document-removal
vi.mock("./lib/document-removal", () => ({
  deleteDocumentCascade: vi.fn(),
}));

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

function readOnlyAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["documents:read"] };
}

function writeAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["documents:read", "documents:write"] };
}

function authHeaders(): Headers {
  return new Headers({ Authorization: "Bearer test-key" });
}

function resultText(res: { result: unknown }): string {
  const result = res.result as { content: Array<{ type: string; text: string }> };
  return result.content[0]?.text ?? "";
}

describe("MCP document_delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
  });

  it("exposes document_delete in tools/list", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const tools = (res.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toContain("document_delete");
    }
  });

  it("returns the four cascade counters on success", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(deleteDocumentCascade).mockResolvedValue({
      deletedChunks: 3,
      deletedVectors: 3,
      deletedNodes: 1,
      deletedEdges: 2,
      deletedVersions: 0,
      deletedIngestionKeys: 0,
    });

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "document_delete", arguments: { id: 42 } },
      },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(resultText(res as { result: unknown }));
      expect(payload).toEqual({
        success: true,
        id: 42,
        deletedChunks: 3,
        deletedVectors: 3,
        deletedNodes: 1,
        deletedEdges: 2,
        deletedVersions: 0,
        deletedIngestionKeys: 0,
      });
    }
    expect(deleteDocumentCascade).toHaveBeenCalled();
  });

  it("reports Document not found as isError", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(deleteDocumentCascade).mockRejectedValue(new Error("Document not found: 999"));

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "document_delete", arguments: { id: 999 } },
      },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Document not found");
    }
  });

  it("rejects without documents:write scope", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: readOnlyAuth() });

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "document_delete", arguments: { id: 1 } },
      },
      authHeaders(),
    );

    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error.message).toBeTruthy();
      // 走 catch 后的 -32603
      expect(res.error.code).toBe(-32603);
    }
  });
});

describe("MCP document_delete 走的是同一套判据（数字形态 documentId 也删得到）", () => {
  it("级联复用的就是 document-removal 的实现，不是自己一套匹配", async () => {
    // 这条测的是「MCP 层没有独立匹配点」：它必须直接调用 lib 层的 deleteDocumentCascade。
    // 一旦有人在 MCP 层另写一套 json_extract 字符串比较，就会绕开 CAST 容错（审查缺口）。
    const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./mcp-server.ts", import.meta.url), "utf8"));
    expect(source).toContain('from "./lib/document-removal"');
    expect(source).not.toMatch(/json_extract\([^)]*documentId/);
  });
});
