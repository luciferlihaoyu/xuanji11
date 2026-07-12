import { describe, expect, it, vi } from "vitest";
import type { User } from "@db/schema";
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
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
  listCollections: vi.fn(),
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  getCollectionStats: vi.fn(),
  addDocumentsToCollection: vi.fn(),
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

describe("ZVec REST API", () => {
  it("rejects unauthenticated requests", async () => {
    const { zvecRouter } = await import("./zvec-router");
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await zvecRouter.request("/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: ["hello"] }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Authentication required" });
  });

  it("forbids write endpoints with only read scope", async () => {
    const { zvecRouter } = await import("./zvec-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: readOnlyAuth() });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await zvecRouter.request("/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-collection" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("embeds texts when authenticated with read scope", async () => {
    const { zvecRouter } = await import("./zvec-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);
    vi.mocked(vectorService.embedTexts).mockResolvedValue([[0.1, 0.2, 0.3]]);

    const res = await zvecRouter.request("/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: ["hello"] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ vectors: [[0.1, 0.2, 0.3]] });
    expect(vectorService.embedTexts).toHaveBeenCalledWith(["hello"]);
  });

  it("returns collection stats when authenticated with read scope", async () => {
    const { zvecRouter } = await import("./zvec-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);
    vi.mocked(vectorService.getCollectionStats).mockResolvedValue({ name: "test-collection", count: 42, dimension: 1536 });

    const res = await zvecRouter.request("/collections/test-collection/stats", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ name: "test-collection", count: 42, dimension: 1536 });
    expect(vectorService.getCollectionStats).toHaveBeenCalledWith("test-collection");
  });

  it("forbids collection stats with only write scope", async () => {
    const { zvecRouter } = await import("./zvec-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue({ user, auth: { type: "apiKey", userId: 1, agentId: 2, scopes: ["zvec:write"] } });
    vi.mocked(authenticateLocalRequest).mockResolvedValue(undefined);

    const res = await zvecRouter.request("/collections/test-collection/stats", {
      method: "GET",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("returns 400 for empty search query", async () => {
    const { zvecRouter } = await import("./zvec-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await zvecRouter.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });

  it("returns 400 for query exceeding max length", async () => {
    const { zvecRouter } = await import("./zvec-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await zvecRouter.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "a".repeat(501) }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });

  it("returns 500 for invalid JSON body", async () => {
    const { zvecRouter } = await import("./zvec-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await zvecRouter.request("/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(500);
  });

  it("returns 400 for null/undefined inputs", async () => {
    const { zvecRouter } = await import("./zvec-router");
    const user = fakeUser();
    vi.mocked(authenticateApiKey).mockResolvedValue(undefined);
    vi.mocked(authenticateLocalRequest).mockResolvedValue(user);

    const res = await zvecRouter.request("/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: null }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request" });
  });
});
