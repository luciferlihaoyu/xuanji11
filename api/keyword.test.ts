import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User, KbDocument } from "@db/schema";
import { kbDocuments } from "@db/schema";
import { authenticateApiKey } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";

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

import { keywordRouter } from "./keyword-router";
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

function createFakeDb(overrides: { doc?: KbDocument; insertId?: number } = {}) {
  const insertId = overrides.insertId ?? 100;
  const chainableQuery = (finalValue: unknown) => {
    const promise = Promise.resolve(finalValue);
    return {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
      limit: vi.fn(() => Promise.resolve(finalValue)),
      orderBy: vi.fn(() => Promise.resolve(finalValue)),
    };
  };
  const queryBuilder = (finalValue: unknown) => ({
    where: vi.fn(() => chainableQuery(finalValue)),
  });
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        if (table === kbDocuments) {
          return queryBuilder(overrides.doc ? [overrides.doc] : []);
        }
        return queryBuilder([]);
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve([{ insertId }])),
    })),
  };
}

function sampleDoc(): KbDocument {
  return {
    id: 1,
    folderId: null,
    title: "人工智能与机器学习",
    content: "人工智能和机器学习是计算机科学的重要领域。机器学习是人工智能的一个分支。",
    format: "markdown",
    tags: [],
    metadata: null,
    createdBy: 1,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
}

describe("Keyword extraction core logic", () => {
  it("extracts Chinese bigram keywords and normalizes scores", () => {
    const result = keywordExtractor.extractKeywordsInternal(
      "人工智能和机器学习是计算机科学的重要领域。机器学习是人工智能的一个分支。",
      5,
    );
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result[0].score).toBeGreaterThan(0);
    expect(result[0].score).toBeLessThanOrEqual(1);
    expect(result.every((r) => r.word.length >= 2)).toBe(true);
  });

  it("extracts English word keywords", () => {
    const result = keywordExtractor.extractKeywordsInternal(
      "machine learning and artificial intelligence are important fields in computer science",
      5,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((r) => ["machine", "learning", "artificial", "intelligence"].includes(r.word))).toBe(true);
  });

  it("returns empty array for stopword-only text", () => {
    const result = keywordExtractor.extractKeywordsInternal("the of and a an in", 5);
    expect(result).toEqual([]);
  });

  it("respects maxKeywords limit", () => {
    const text = "人工智能 机器学习 深度学习 神经网络 自然语言处理 计算机视觉";
    const result = keywordExtractor.extractKeywordsInternal(text, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe("Keyword REST router", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await keywordRouter.request("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "test" }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Authentication required" });
  });

  it("forbids extract without knowledge:read scope", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: { type: "apiKey", userId: 1, agentId: 2, scopes: ["zvec:read"] } });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await keywordRouter.request("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "test" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("returns 400 for invalid extract request", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await keywordRouter.request("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });

  it("extracts keywords when authenticated with knowledge:read", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await keywordRouter.request("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "machine learning artificial intelligence", maxKeywords: 3 }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { keywords: Array<{ word: string; score: number }> };
    expect(json.keywords.length).toBeGreaterThan(0);
    expect(json.keywords.length).toBeLessThanOrEqual(3);
    expect(json.keywords[0]).toHaveProperty("word");
    expect(json.keywords[0]).toHaveProperty("score");
  });

  it("forbids auto-tag without knowledge:write scope", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await keywordRouter.request("/auto-tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: 1 }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("returns 404 when auto-tag document is not found", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);

    const res = await keywordRouter.request("/auto-tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: 999 }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Document not found" });
  });

  it("auto-tags a document when authenticated with knowledge:write", async () => {
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);
    vi.mocked(getDb).mockReturnValue(createFakeDb({ doc: sampleDoc(), insertId: 200 }) as never);

    const res = await keywordRouter.request("/auto-tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: 1 }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { tags: string[]; created: number; edges: number };
    expect(Array.isArray(json.tags)).toBe(true);
    expect(json.created).toBeGreaterThanOrEqual(0);
    expect(json.edges).toBeGreaterThanOrEqual(0);
  });
});

describe("Auto-tag core logic", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws when document is not found", async () => {
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);
    await expect(keywordAutoTag.autoTagDocument(999, 5, 1)).rejects.toThrow("Document not found");
  });

  it("creates tags and edges for a document", async () => {
    vi.mocked(getDb).mockReturnValue(createFakeDb({ doc: sampleDoc(), insertId: 300 }) as never);
    const result = await keywordAutoTag.autoTagDocument(1, 5, 1);
    expect(result.tags.length).toBeGreaterThan(0);
    expect(result.created).toBeGreaterThanOrEqual(0);
    expect(result.edges).toBeGreaterThanOrEqual(0);
  });

  it("returns empty result when no keywords are extracted", async () => {
    const doc: KbDocument = { ...sampleDoc(), title: "", content: "the of and a an in" };
    vi.mocked(getDb).mockReturnValue(createFakeDb({ doc }) as never);
    const result = await keywordAutoTag.autoTagDocument(1, 5, 1);
    expect(result.tags).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.edges).toBe(0);
  });
});
