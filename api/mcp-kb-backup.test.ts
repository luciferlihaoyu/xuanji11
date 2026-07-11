import { describe, expect, it, vi } from "vitest";
import type { User, KnowledgeNode } from "@db/schema";
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

function resultText(res: { result: unknown }): string {
  const result = res.result as { content: Array<{ type: string; text: string }> };
  return result.content[0]?.text ?? "";
}

interface FakeDbOptions {
  readonly nodes?: readonly KnowledgeNode[];
  readonly insertAffectedRows?: number;
}

function createFakeDb(options: FakeDbOptions = {}) {
  const nodes = options.nodes ?? [];
  const insertAffectedRows = options.insertAffectedRows ?? 0;

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        if (table === knowledgeNodes) return Promise.resolve(nodes);
        if (table === knowledgeEdges) return Promise.resolve([]);
        if (table === kbDocuments) return Promise.resolve([]);
        return Promise.resolve([]);
      }),
    })),
    insert: vi.fn(() => ({
      ignore: vi.fn(() => ({
        values: vi.fn(() => Promise.resolve([{ affectedRows: insertAffectedRows }])),
      })),
    })),
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

describe("kb-backup MCP tools", () => {
  it("lists kb.export and kb.import in tools/list", async () => {
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
      expect(tools.map((t) => t.name)).toContain("kb.export");
      expect(tools.map((t) => t.name)).toContain("kb.import");
    }
  });

  it("exports with knowledge:read via MCP", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const node = sampleNode();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb({ nodes: [node] }) as never);

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kb.export", arguments: {} } },
      new Headers({ Authorization: "Bearer test" }),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const parsed = JSON.parse(resultText(res as { result: unknown }));
      expect(parsed.data.nodes).toEqual([
        { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString() },
      ]);
    }
  });

  it("rejects kb.import without knowledge:write", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "kb.import",
          arguments: { version: "1.0", data: { nodes: [], edges: [], documents: [] } },
        },
      },
      new Headers({ Authorization: "Bearer test" }),
    );

    expect("error" in res).toBe(true);
    expect("error" in res && res.error.code).toBe(-32603);
  });

  it("imports with knowledge:write via MCP", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    vi.mocked(authenticateApiKey).mockResolvedValue({ user: fakeUser(), auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb({ insertAffectedRows: 1 }) as never);

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "kb.import",
          arguments: {
            version: "1.0",
            data: {
              nodes: [{ id: 1, title: "Node", type: "concept", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }],
              edges: [],
              documents: [],
            },
          },
        },
      },
      new Headers({ Authorization: "Bearer test" }),
    );

    expect("result" in res).toBe(true);
    if ("result" in res) {
      const parsed = JSON.parse(resultText(res as { result: unknown }));
      expect(parsed.nodes).toBe(1);
    }
  });
});
