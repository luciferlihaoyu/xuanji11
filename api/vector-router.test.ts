import { describe, expect, it, vi } from "vitest";
import type { User } from "@db/schema";
import { vectorRouter } from "./vector-router";
import type { TrpcContext } from "./context";
import { sessionAuth } from "./lib/auth";
import { getStats } from "./lib/vector-service";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./lib/vector-service", () => ({
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

function fakeContext(): TrpcContext {
  const user = fakeUser();
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    auth: sessionAuth(user),
  };
}

describe("vector.stats", () => {
  it("returns ZVec health and dimension configuration", async () => {
    // Given: the vector service has loaded the 2048-dimension ZVec configuration.
    vi.mocked(getStats).mockResolvedValue({
      ok: true,
      engine: "zvec",
      size: 0,
      mode: "empty",
      provider: "https://ark.cn-beijing.volces.com/api/plan/v3",
      model: "doubao-embedding-vision",
      dimension: 2048,
      zvecEnabled: true,
      zvecDataDir: "/data/app/zvec",
      zvecDimension: 2048,
      collectionName: "document_chunks",
      error: "path validate failed: path[/data/app/zvec/document_chunks] exists",
    });

    // When: the settings UI requests vector engine status.
    const result = await vectorRouter.createCaller(fakeContext()).stats();

    // Then: the response includes both embedding probe and ZVec index dimensions.
    expect(result.ok).toBe(true);
    expect(result.dimension).toBe(2048);
    expect(result.zvecDimension).toBe(2048);
    expect(result.error).toContain("document_chunks");
  });
});
