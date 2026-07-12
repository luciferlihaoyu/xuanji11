import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User, VectorCollection } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import * as vectorService from "./lib/vector-service";

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
  listCollections: vi.fn(),
  addDocumentsToCollection: vi.fn(),
  deleteCollection: vi.fn(),
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
  getStats: vi.fn(),
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
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["zvec:read"] };
}

function writeAuth(): AuthInfo {
  return { type: "apiKey", userId: 1, agentId: 2, scopes: ["zvec:read", "zvec:write"] };
}

function authHeaders(): Headers {
  return new Headers({ Authorization: "Bearer test-key" });
}

function fakeCollection(name: string): VectorCollection {
  return {
    id: 1,
    name,
    description: null,
    model: "text-embedding-3-small",
    dimension: 1536,
    status: "ready",
    documentCount: 10,
    createdBy: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function resultText(res: { result: unknown }): string {
  const result = res.result as { content: Array<{ type: string; text: string }> };
  return result.content[0]?.text ?? "";
}

describe("MCP ZVec tools", () => {
  it("lists collections with read scope", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    const collections = [fakeCollection("docs")];
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readOnlyAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(vectorService.listCollections).mockResolvedValue(collections);

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "zvec.listCollections", arguments: {} } },
      authHeaders(),
    );

    expect(res).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual(JSON.parse(JSON.stringify({ collections })));
    expect(vectorService.listCollections).toHaveBeenCalled();
  });

  it("adds documents with write scope", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(vectorService.addDocumentsToCollection).mockResolvedValue({ added: 2 });

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "zvec.addDocuments",
          arguments: {
            name: "docs",
            documents: [{ content: "hello world" }, { content: "foo bar", metadata: { tag: "test" } }],
          },
        },
      },
      authHeaders(),
    );

    expect(res).toMatchObject({ jsonrpc: "2.0", id: 2 });
    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ added: 2 });
    expect(vectorService.addDocumentsToCollection).toHaveBeenCalledWith("docs", [
      { content: "hello world" },
      { content: "foo bar", metadata: { tag: "test" } },
    ]);
  });

  it("deletes a collection with write scope", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(vectorService.deleteCollection).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "zvec.deleteCollection", arguments: { name: "docs" } },
      },
      authHeaders(),
    );

    expect(res).toMatchObject({ jsonrpc: "2.0", id: 3 });
    expect("result" in res && JSON.parse(resultText(res as { result: unknown }))).toEqual({ success: true });
    expect(vectorService.deleteCollection).toHaveBeenCalledWith("docs");
  });

  it("rejects write tools without write scope", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readOnlyAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "zvec.addDocuments", arguments: { name: "docs", documents: [{ content: "x" }] } },
      },
      authHeaders(),
    );

    expect("error" in res && res.error.code).toBe(-32603);
  });

  it("exposes new tools in tools/list", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readOnlyAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      authHeaders(),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const tools = (res.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toContain("zvec.listCollections");
      expect(tools.map((t) => t.name)).toContain("zvec.addDocuments");
      expect(tools.map((t) => t.name)).toContain("zvec.deleteCollection");
      expect(tools.map((t) => t.name)).toContain("analytics.get");
    }
  });
});

describe("MCP edge cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects invalid JSON-RPC requests", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readOnlyAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      { jsonrpc: "1.0", id: 1, method: "tools/list" },
      authHeaders(),
    );

    expect("error" in res && res.error.code).toBe(-32600);
  });

  it("rejects tool calls with null/undefined arguments", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readOnlyAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "zvec.listCollections", arguments: null },
      },
      authHeaders(),
    );

    expect("error" in res && res.error.code).toBe(-32602);
  });

  it("handles concurrent tool calls", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readOnlyAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(vectorService.listCollections).mockResolvedValue([fakeCollection("docs")]);

    const requests = Array.from({ length: 5 }, (_, i) =>
      handleMcpRequest(
        { jsonrpc: "2.0", id: i + 10, method: "tools/call", params: { name: "zvec.listCollections", arguments: {} } },
        authHeaders(),
      )
    );

    const responses = await Promise.all(requests);
    expect(responses.every((r) => "result" in r)).toBe(true);
    expect(vectorService.listCollections).toHaveBeenCalledTimes(5);
  });
});

