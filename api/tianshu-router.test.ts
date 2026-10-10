/**
 * L2 修复闭环：tianshu fetch 走 safeFetch，验证
 *   - 默认路径用 safeFetch 而非 global fetch（spy 验证）
 *   - scope="admin" 传透
 *   - EgressError 抛错时返回友好消息（不泄露内部细节）
 *   - HTTP 5xx / 4xx 仍按原逻辑返回
 *   - payload 中异常 data 形态仍被 .filter 兜住
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 必须先 vi.hoisted 设置 env（safeFetch 内部走 egress/egress 读 EGRESS_ALLOW_PRIVATE_NET）
vi.hoisted(() => {
  process.env.JWT_SECRET = "test-jwt-secret-at-least-32-chars-long!!";
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-chars-long!!!";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  // 天枢测试环境：公网 URL（不会被 egress 拒）+ API key 已配置
  process.env.TIANSHU_BASE_URL = "https://tianshu.example.com";
  process.env.TIANSHU_API_KEY = "test-api-key";
});

import { setSafeFetchTransportForTests, type SafeFetchInit, type SafeFetchResponse } from "./lib/safe-fetch";
import { EgressError } from "./lib/egress";

let callLog: Array<{ url: string; init: SafeFetchInit | undefined }> = [];

function mockResponse(status: number, body: unknown): SafeFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: { get: () => null },
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  } as unknown as SafeFetchResponse;
}

function authedCtx(): unknown {
  // authedQuery 强制 ctx.user 存在（middleware.ts:18），传个 admin 即可
  return { user: { id: 1, role: "admin" }, req: undefined, res: undefined };
}

beforeEach(() => {
  callLog = [];
  setSafeFetchTransportForTests(async (url, init) => {
    callLog.push({ url, init });
    return mockResponse(200, { data: [{ id: "gpt-4" }, { id: "claude-3" }] });
  });
});

afterEach(() => {
  setSafeFetchTransportForTests(null);
});

describe("tianshu listModels (L2 safeFetch 闭环)", () => {
  it("L2 修复：走 safeFetch 而非 global fetch（spy 验证 transport 被调用）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { tianshuRouter } = await import("./tianshu-router");
    const caller = (tianshuRouter as unknown as {
      createCaller: (ctx: unknown) => { listModels: () => Promise<unknown> };
    }).createCaller(authedCtx());
    const result = await caller.listModels() as { ok: boolean; models: string[] };

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["claude-3", "gpt-4"]);
    expect(callLog.length).toBe(1);
    expect(callLog[0].url).toBe("https://tianshu.example.com/v1/models");
    expect(callLog[0].init?.scope).toBe("admin"); // L2 关键：scope=admin
    expect(callLog[0].init?.headers?.authorization).toBe("Bearer test-api-key");
    // 关键：global fetch **没**被调用
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("EgressError（如 SSRF 防御命中）→ 友好消息返回，不抛", async () => {
    setSafeFetchTransportForTests(async () => {
      throw new EgressError("tianshu.example.com → 10.0.0.5 被内网策略拒绝");
    });
    const { tianshuRouter } = await import("./tianshu-router");
    const caller = (tianshuRouter as unknown as {
      createCaller: (ctx: unknown) => { listModels: () => Promise<unknown> };
    }).createCaller(authedCtx());
    const result = await caller.listModels() as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/天枢地址被出口策略拒绝/);
    expect(result.error).toMatch(/被内网策略拒绝/);
  });

  it("天枢返回 HTTP 500 → 友好消息", async () => {
    setSafeFetchTransportForTests(async () => mockResponse(500, { error: "down" }));
    const { tianshuRouter } = await import("./tianshu-router");
    const caller = (tianshuRouter as unknown as {
      createCaller: (ctx: unknown) => { listModels: () => Promise<unknown> };
    }).createCaller(authedCtx());
    const result = await caller.listModels() as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("天枢返回 HTTP 500");
  });

  it("payload 中含异常 data（id 不是 string / 空）→ filter 兜住", async () => {
    setSafeFetchTransportForTests(async () => mockResponse(200, {
      data: [
        { id: "valid-1" },
        { id: "" },          // 空串被 filter
        { id: 123 },         // 非 string 被 filter
        { id: "x".repeat(300) }, // 超过 255 字符被 filter
        {},                  // 无 id 字段被 filter
        { id: "valid-2" },
      ],
    }));
    const { tianshuRouter } = await import("./tianshu-router");
    const caller = (tianshuRouter as unknown as {
      createCaller: (ctx: unknown) => { listModels: () => Promise<unknown> };
    }).createCaller(authedCtx());
    const result = await caller.listModels() as { ok: boolean; models: string[] };

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["valid-1", "valid-2"]);
  });

  it("无 TIANSHU_API_KEY → 立即返回，不发请求", async () => {
    process.env.TIANSHU_API_KEY = "";
    const { tianshuRouter } = await import("./tianshu-router");
    const caller = (tianshuRouter as unknown as {
      createCaller: (ctx: unknown) => { listModels: () => Promise<unknown> };
    }).createCaller(authedCtx());
    const result = await caller.listModels() as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("TIANSHU_API_KEY 未配置");
    expect(callLog.length).toBe(0); // 没调 safeFetch
  });
});
