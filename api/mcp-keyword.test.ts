import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User } from "@db/schema";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";

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

import * as keywordExtractor from "./lib/keyword-extractor";
import * as keywordAutoTag from "./lib/keyword-auto-tag";

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

function readAuth() {
  return { type: "apiKey" as const, userId: 1, agentId: 2, scopes: ["knowledge:read"] };
}

function writeAuth() {
  return { type: "apiKey" as const, userId: 1, agentId: 2, scopes: ["knowledge:read", "knowledge:write"] };
}

describe("Keyword MCP tools", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lists keywords.extract and keywords.autoTag in tools/list", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      new Headers({ Authorization: "Bearer test" }),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const tools = (res.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toContain("keywords.extract");
      expect(tools.map((t) => t.name)).toContain("keywords.autoTag");
    }
  });

  it("extracts keywords via MCP with knowledge:read", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.spyOn(keywordExtractor, "extractKeywords").mockResolvedValue([{ word: "test", score: 1 }]);

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "keywords.extract", arguments: { text: "test" } } },
      new Headers({ Authorization: "Bearer test" }),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const result = res.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.keywords).toEqual([{ word: "test", score: 1 }]);
    }
  });

  it("rejects keywords.autoTag without knowledge:write", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "keywords.autoTag", arguments: { documentId: 1 } } },
      new Headers({ Authorization: "Bearer test" }),
    );

    expect("error" in res).toBe(true);
    expect("error" in res && res.error.code).toBe(-32603);
  });

  it("auto-tags via MCP with knowledge:write", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.spyOn(keywordAutoTag, "autoTagDocument").mockResolvedValue({ tags: ["ai"], created: 1, edges: 1 });

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "keywords.autoTag", arguments: { documentId: 1 } } },
      new Headers({ Authorization: "Bearer test" }),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const result = res.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tags).toEqual(["ai"]);
    }
  });
});
