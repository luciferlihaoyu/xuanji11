import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User, KbDocument, KnowledgeNode, KnowledgeEdge } from "@db/schema";
import { kbDocuments, knowledgeNodes, knowledgeEdges } from "@db/schema";
import type { SearchResult } from "./lib/vector-service";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";
import { searchVectors } from "./lib/vector-service";

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
  searchVectors: vi.fn(),
}));

import { relationRouter } from "./relation-router";
import { discoverRelations } from "./lib/relation-analyzer";
import type { AuthInfo } from "./lib/auth";

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

function createFakeDb(overrides: {
  readonly documents?: readonly KbDocument[];
  readonly nodes?: readonly KnowledgeNode[];
  readonly edges?: readonly KnowledgeEdge[];
} = {}) {
  const documents = overrides.documents ?? [];
  const nodes = overrides.nodes ?? [];
  const edges = overrides.edges ?? [];

  const chainable = (value: unknown) => {
    const promise = Promise.resolve(value);
    return {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
      limit: vi.fn(() => promise),
      orderBy: vi.fn(() => promise),
    };
  };

  const queryBuilder = (table: unknown) => ({
    where: vi.fn(() => {
      if (table === kbDocuments) return chainable(documents);
      if (table === knowledgeNodes) return chainable(nodes);
      if (table === knowledgeEdges) return chainable(edges);
      return chainable([]);
    }),
  });

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => queryBuilder(table)),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve([{ insertId: 1 }])),
    })),
  };
}

function sampleDocument(): KbDocument {
  return {
    id: 1,
    folderId: null,
    title: "Sample Doc",
    content: "doc content with [[AI]] link",
    format: "markdown",
    tags: null,
    metadata: null,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
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
    label: "related",
    type: "related",
    weight: 1,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function vectorResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "chunk-1-0",
    score: 0.85,
    metadata: { documentId: "2", title: "Doc 2", content: "related content" },
    ...overrides,
  };
}

describe("relation-analyzer core", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns co-occurrence suggestions from shared tag edges", async () => {
    const doc = sampleDocument();
    const docNode1: KnowledgeNode = { ...sampleNode(), id: 10, type: "document", title: "Doc 1", metadata: { documentId: 1 } };
    const docNode2: KnowledgeNode = { ...sampleNode(), id: 20, type: "document", title: "Doc 2", metadata: { documentId: 2 } };
    const tagNode: KnowledgeNode = { ...sampleNode(), id: 30, type: "tag", title: "AI" };
    const edgeToTarget: KnowledgeEdge = { ...sampleEdge(), id: 100, sourceId: 30, targetId: 10, label: "tag" };
    const edgeToRelated: KnowledgeEdge = { ...sampleEdge(), id: 101, sourceId: 30, targetId: 20, label: "tag" };

    vi.mocked(getDb).mockReturnValue(
      createFakeDb({
        documents: [doc],
        nodes: [docNode1, docNode2, tagNode],
        edges: [edgeToTarget, edgeToRelated],
      }) as never,
    );

    const result = await discoverRelations({ documentId: 1, strategies: ["co-occurrence"], limit: 10 });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      strategy: "co-occurrence",
      targetType: "document",
      targetId: 2,
      title: "Doc 2",
      score: 1,
    });
  });

  it("returns vector suggestions above the cosine threshold", async () => {
    const doc = sampleDocument();
    vi.mocked(getDb).mockReturnValue(createFakeDb({ documents: [doc] }) as never);
    vi.mocked(searchVectors).mockResolvedValue([
      vectorResult({ id: "chunk-2-0", score: 0.85, metadata: { documentId: "2", title: "Doc 2" } }),
      vectorResult({ id: "chunk-1-0", score: 0.95, metadata: { documentId: "1", title: "Sample Doc" } }),
      vectorResult({ id: "chunk-3-0", score: 0.65, metadata: { documentId: "3", title: "Doc 3" } }),
    ]);

    const result = await discoverRelations({ documentId: 1, strategies: ["vector"], limit: 10 });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      strategy: "vector",
      targetType: "document",
      targetId: 2,
      score: 0.85,
    });
  });

  it("returns reference suggestions for unlinked wiki-links", async () => {
    const doc: KbDocument = { ...sampleDocument(), content: "See [[AI]] and [[ML]] for more." };
    const aiNode: KnowledgeNode = { ...sampleNode(), id: 40, title: "AI", type: "concept" };
    const mlNode: KnowledgeNode = { ...sampleNode(), id: 50, title: "ML", type: "concept" };
    const docNode: KnowledgeNode = { ...sampleNode(), id: 10, type: "document", title: "Doc 1", metadata: { documentId: 1 } };

    vi.mocked(getDb).mockReturnValue(
      createFakeDb({
        documents: [doc],
        nodes: [docNode, aiNode, mlNode],
        edges: [],
      }) as never,
    );

    const result = await discoverRelations({ documentId: 1, strategies: ["reference"], limit: 10 });

    const referenceSuggestions = result.suggestions.filter((s) => s.strategy === "reference");
    expect(referenceSuggestions.length).toBeGreaterThanOrEqual(2);
    expect(referenceSuggestions.map((s) => s.targetId).sort()).toContain(40);
    expect(referenceSuggestions.map((s) => s.targetId).sort()).toContain(50);
  });

  it("excludes already linked wiki-link references", async () => {
    const doc: KbDocument = { ...sampleDocument(), content: "See [[AI]] and [[ML]] for more." };
    const aiNode: KnowledgeNode = { ...sampleNode(), id: 40, title: "AI", type: "concept" };
    const mlNode: KnowledgeNode = { ...sampleNode(), id: 50, title: "ML", type: "concept" };
    const docNode: KnowledgeNode = { ...sampleNode(), id: 10, type: "document", title: "Doc 1", metadata: { documentId: 1 } };
    const existingEdge: KnowledgeEdge = { ...sampleEdge(), id: 200, sourceId: 10, targetId: 40, label: "references" };

    vi.mocked(getDb).mockReturnValue(
      createFakeDb({
        documents: [doc],
        nodes: [docNode, aiNode, mlNode],
        edges: [existingEdge],
      }) as never,
    );

    const result = await discoverRelations({ documentId: 1, strategies: ["reference"], limit: 10 });

    const referenceSuggestions = result.suggestions.filter((s) => s.strategy === "reference");
    expect(referenceSuggestions.some((s) => s.targetId === 40)).toBe(false);
    expect(referenceSuggestions.some((s) => s.targetId === 50)).toBe(true);
  });

  it("throws when the target document does not exist", async () => {
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);
    await expect(discoverRelations({ documentId: 999, strategies: ["reference"], limit: 10 })).rejects.toThrow(
      "Document not found",
    );
  });

  it("applies the limit across all strategies", async () => {
    const doc: KbDocument = { ...sampleDocument(), content: "See [[AI]] and [[ML]]." };
    const aiNode: KnowledgeNode = { ...sampleNode(), id: 40, title: "AI", type: "concept" };

    vi.mocked(getDb).mockReturnValue(
      createFakeDb({
        documents: [doc],
        nodes: [aiNode],
        edges: [],
      }) as never,
    );
    vi.mocked(searchVectors).mockResolvedValue([
      vectorResult({ id: "chunk-2-0", score: 0.85, metadata: { documentId: "2", title: "Doc 2" } }),
    ]);

    const result = await discoverRelations({ documentId: 1, strategies: ["reference", "vector"], limit: 1 });

    expect(result.suggestions).toHaveLength(1);
  });
});

describe("relation-router REST API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await relationRouter.request("/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: 1 }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Authentication required" });
  });

  it("forbids discover without knowledge:read scope", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({
      user,
      auth: { type: "apiKey", userId: 1, agentId: 2, scopes: ["zvec:read"] },
    });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await relationRouter.request("/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: 1 }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("returns 400 for invalid request body", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await relationRouter.request("/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: "not-a-number" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });

  it("returns 404 when the document is not found", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);

    const res = await relationRouter.request("/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: 999 }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Document not found" });
  });

  it("discovers relations with knowledge:read scope", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: writeAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    const docNode: KnowledgeNode = { ...sampleNode(), id: 10, type: "document", title: "Doc 1", metadata: { documentId: 1 } };

    vi.mocked(getDb).mockReturnValue(
      createFakeDb({
        documents: [sampleDocument()],
        nodes: [docNode],
        edges: [],
      }) as never,
    );
    vi.mocked(searchVectors).mockResolvedValue([]);

    const res = await relationRouter.request("/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: 1, strategies: ["reference"], limit: 10 }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      documentId: number;
      strategies: string[];
      suggestions: unknown[];
    };
    expect(json.documentId).toBe(1);
    expect(json.strategies).toEqual(["reference"]);
    expect(Array.isArray(json.suggestions)).toBe(true);
  });
});

describe("relation MCP tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("includes the relations.discover tool definition", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      new Headers({ Authorization: "Bearer test-key" }),
    );

    expect(res).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(res).toHaveProperty("result");
    const result = res as { result: { tools: Array<{ name: string }> } };
    expect(result.result.tools.some((tool) => tool.name === "relations.discover")).toBe(true);
  });

  it("executes relations.discover with knowledge:read scope", async () => {
    const { handleMcpRequest } = await import("./mcp-server");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);
    vi.mocked(getDb).mockReturnValue(createFakeDb({ documents: [sampleDocument()] }) as never);
    vi.mocked(searchVectors).mockResolvedValue([]);

    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "relations.discover", arguments: { documentId: 1, strategies: ["reference"], limit: 10 } },
      },
      new Headers({ Authorization: "Bearer test-key" }),
    );

    expect(res).toMatchObject({ jsonrpc: "2.0", id: 2 });
    expect(res).toHaveProperty("result");
  });
});
