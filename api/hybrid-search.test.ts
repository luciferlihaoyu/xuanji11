import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User } from "@db/schema";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import * as vectorService from "./lib/vector-service";
import * as hybridSearch from "./lib/hybrid-search";
import { searchRouter } from "./search-router";

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
  searchVectors: vi.fn(),
  embedTexts: vi.fn(),
  getStats: vi.fn(),
  listCollections: vi.fn(),
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  getCollectionStats: vi.fn(),
  addDocumentsToCollection: vi.fn(),
  searchByVector: vi.fn(),
}));

vi.mock("./queries/connection", () => {
  const createChain = (finalValue: unknown) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(finalValue));
    return chain;
  };
  return {
    getDb: vi.fn(() => createChain([])),
  };
});

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

function keywordHit(id: string, rank: number, content = "keyword content") {
  return {
    id,
    title: `Keyword ${id}`,
    content,
    type: "document",
    tags: [] as string[],
    folderId: null,
    source: "keyword" as const,
    rank,
  };
}

function vectorHit(id: string, rank: number, content = "vector content") {
  return {
    id,
    title: `Vector ${id}`,
    content,
    type: "document",
    tags: [] as string[],
    folderId: null,
    source: "vector" as const,
    rank,
  };
}

describe("Hybrid search core logic", () => {
  describe("makeSnippet", () => {
    it("highlights the query in the snippet", () => {
      const result = hybridSearch.makeSnippet("Hello world query", "query", 100);
      expect(result).toContain("<mark>query</mark>");
    });

    it("truncates raw content before highlighting", () => {
      const content = `start ${"x".repeat(500)}`;
      const result = hybridSearch.makeSnippet(content, "start", 10);
      expect(result).toContain("<mark>start</mark>");
      expect(result).not.toContain("x".repeat(100));
    });

    it("escapes HTML before highlighting", () => {
      const result = hybridSearch.makeSnippet("<script>query</script>", "query", 200);
      expect(result).toContain("&lt;script&gt;");
      expect(result).toContain("<mark>query</mark>");
    });
  });

  describe("rrfScore", () => {
    it("uses k=60 for the RRF formula", () => {
      expect(hybridSearch.rrfScore(1)).toBeCloseTo(1 / 61, 6);
      expect(hybridSearch.rrfScore(2)).toBeCloseTo(1 / 62, 6);
      expect(hybridSearch.rrfScore(10)).toBeCloseTo(1 / 70, 6);
    });
  });

  describe("mergeResults", () => {
    it("deduplicates by id and sums RRF scores", () => {
      const merged = hybridSearch.mergeResults(
        [keywordHit("1", 1), keywordHit("2", 2)],
        [vectorHit("1", 1), vectorHit("3", 3)],
      );

      expect(merged).toHaveLength(3);
      const hit1 = merged.find((h) => h.id === "1");
      expect(hit1).toBeDefined();
      expect(hit1?.sources).toEqual(expect.arrayContaining(["keyword", "vector"]));
      expect(hit1?.score).toBeCloseTo(1 / 61 + 1 / 61, 6);
      expect(merged[0].id).toBe("1");
    });

    it("prefers vector content when merging both sources", () => {
      const merged = hybridSearch.mergeResults(
        [keywordHit("1", 1, "keyword summary")],
        [vectorHit("1", 2, "vector chunk")],
      );
      expect(merged[0].content).toBe("vector chunk");
    });
  });

  describe("applyFilters", () => {
    const hits = [
      { id: "1", title: "A", content: "", type: "document", tags: ["ai"], folderId: 10, sources: ["keyword" as const], ranks: {}, score: 0 },
      { id: "2", title: "B", content: "", type: "concept", tags: [], folderId: null, sources: ["keyword" as const], ranks: {}, score: 0 },
    ];

    it("filters by type", () => {
      const filtered = hybridSearch.applyFilters(hits, { type: "document" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("1");
    });

    it("filters by tags", () => {
      const filtered = hybridSearch.applyFilters(hits, { tags: ["ai"] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("1");
    });

    it("filters by folder", () => {
      const filtered = hybridSearch.applyFilters(hits, { folder: 10 });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("1");
    });
  });

  describe("buildFacets", () => {
    it("counts types, tags and folders", () => {
      const hits = [
        { id: "1", title: "A", content: "", type: "document", tags: ["ai", "search"], folderId: 1, sources: ["keyword" as const], ranks: {}, score: 0 },
        { id: "2", title: "B", content: "", type: "concept", tags: ["ai"], folderId: null, sources: ["keyword" as const], ranks: {}, score: 0 },
      ];
      const facets = hybridSearch.buildFacets(hits);
      expect(facets.types).toEqual({ document: 1, concept: 1 });
      expect(facets.tags).toEqual({ ai: 2, search: 1 });
      expect(facets.folders).toEqual({ "1": 1 });
    });
  });
});

describe("executeHybridSearch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns vector results in vector-only mode", async () => {
    vi.mocked(vectorService.searchVectors).mockResolvedValue([
      {
        id: "chunk-1-0",
        score: 0.9,
        metadata: {
          documentId: "doc-1",
          title: "Doc",
          content: "content with QUERY",
          type: "document",
        },
      },
    ]);

    const result = await hybridSearch.executeHybridSearch({ query: "QUERY", mode: "vector", limit: 10 });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("doc-1");
    expect(result.results[0].snippet).toContain("<mark>QUERY</mark>");
    expect(result.metadata.vectorResults).toBe(1);
    expect(result.metadata.keywordResults).toBe(0);
    expect(result.facets.types).toEqual({ document: 1 });
  });
});

describe("Search REST router", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await searchRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Authentication required" });
  });

  it("forbids requests without knowledge:read scope", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: { type: "apiKey", userId: 1, agentId: 2, scopes: ["zvec:read"] } });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await searchRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("returns 400 for invalid request body", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await searchRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "", limit: 0 }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });

  it("returns 400 for empty search query", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await searchRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });

  it("returns 400 for query exceeding max length", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await searchRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "a".repeat(501) }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });

  it("returns 400 for null/undefined inputs", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await searchRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: null }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });

  it("handles concurrent search requests", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);
    vi.spyOn(hybridSearch, "executeHybridSearch").mockResolvedValue({
      results: [],
      facets: { types: {}, tags: {}, folders: {} },
      metadata: {
        mode: "hybrid",
        query: "test",
        limit: 10,
        total: 0,
        keywordResults: 0,
        vectorResults: 0,
      },
    });

    const requests = Array.from({ length: 5 }, () =>
      searchRouter.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      })
    );

    const responses = await Promise.all(requests);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(hybridSearch.executeHybridSearch).toHaveBeenCalledTimes(5);
  });
});
