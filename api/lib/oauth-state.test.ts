import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetForTests,
  consumeOAuthState,
  issueOAuthState,
} from "./oauth-state";

beforeEach(() => {
  __resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("oauth-state（H4：OAuth state 一次性签发/消费）", () => {
  it("签发后一次消费成功，重复消费同值返回 false", () => {
    const state = issueOAuthState();

    expect(consumeOAuthState(state)).toBe(true);
    // 一次性：同一 state 第二次消费必须失败（防重放）
    expect(consumeOAuthState(state)).toBe(false);
  });

  it("TTL 过期：签发 10min+1ms 后消费返回 false", () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(now);
    const state = issueOAuthState();

    nowSpy.mockReturnValue(now + 10 * 60 * 1000 + 1); // 超过 10 分钟
    expect(consumeOAuthState(state)).toBe(false);
  });

  it("边界内有效：恰好 10min 仍可消费", () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(now);
    const state = issueOAuthState();

    nowSpy.mockReturnValue(now + 10 * 60 * 1000); // 恰好 TTL 边界
    expect(consumeOAuthState(state)).toBe(true);
  });

  it("未签发的伪造 state 不命中", () => {
    expect(consumeOAuthState("fake")).toBe(false);
    expect(consumeOAuthState("")).toBe(false);
  });

  it("上限 1000：第 1001 条触发 LRU 驱逐最旧条目", () => {
    const first = issueOAuthState();
    for (let i = 1; i < 1000; i++) issueOAuthState();
    const latest = issueOAuthState(); // 第 1001 条

    // 最旧的 first 被驱逐
    expect(consumeOAuthState(first)).toBe(false);
    // 第 1001 条本身有效
    expect(consumeOAuthState(latest)).toBe(true);
  });

  it("签发值为 32B base64url（43 字符，高熵）", () => {
    const state = issueOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
