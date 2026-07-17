import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@db/schema";
import { agentRouter } from "./agent-router";
import type { TrpcContext } from "./context";
import { sessionAuth } from "./lib/auth";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
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

function fakeContext(): TrpcContext {
  const user = fakeUser();
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    auth: sessionAuth(user),
  };
}

async function testLlmConnection() {
  return agentRouter.createCaller(fakeContext()).testLlmConnection({
    apiUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "kimi-test",
  });
}

describe("agent.testLlmConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a structured failure when the provider returns HTTP 500", async () => {
    // Given: the upstream provider returns a structured internal-service error.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "InternalServiceError",
            message: "The service encountered an unexpected internal error",
          },
        }),
        { status: 500 },
      ),
    );

    // When: the agent LLM connection is tested.
    const result = await testLlmConnection();

    // Then: the failure stays inside the procedure result instead of surfacing as a tRPC error.
    expect(result.success).toBe(false);
    expect(result.message).toContain("HTTP 500");
    expect(result.message).toContain("InternalServiceError");
    expect(result.message).toContain("The service encountered an unexpected internal error");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns success when the provider responds with an id", async () => {
    // Given: the upstream provider returns an OpenAI-compatible response id.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl-test" }), { status: 200 }),
    );

    // When: the agent LLM connection is tested.
    const result = await testLlmConnection();

    // Then: the connection is accepted.
    expect(result).toEqual({ success: true, message: "连接成功" });
  });

  it("returns a structured failure when the network request fails", async () => {
    // Given: the fetch call fails before an HTTP response is available.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));

    // When: the agent LLM connection is tested.
    const result = await testLlmConnection();

    // Then: the error is converted into a readable result.
    expect(result.success).toBe(false);
    expect(result.message).toContain("连接测试失败：socket hang up");
  });

  it("returns a timeout failure when the request is aborted", async () => {
    // Given: the request is aborted by the timeout controller.
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError);

    // When: the agent LLM connection is tested.
    const result = await testLlmConnection();

    // Then: the user sees the timeout message.
    expect(result).toEqual({ success: false, message: "请求超时（15秒）" });
  });
});
