import { describe, it, expect } from "vitest";
import {
  isFullyExemptPath,
  isInternalRestPath,
  isTrustedMutationRequest,
  webhookToken,
  verifyWebhookToken,
} from "./csrf";

describe("isFullyExemptPath", () => {
  it.each([
    ["/api/mcp", true],
    ["/api/mcp/sse", true],
    ["/api/workflows/5/webhook", true],
    ["/api/workflows/12/webhook", true],
    ["/api/zvec/collections", false],
    ["/api/search", false],
    ["/api/trpc/agent.list", false],
  ])("%s → %j", (path, expected) => {
    expect(isFullyExemptPath(path)).toBe(expected);
  });
});

describe("isInternalRestPath", () => {
  it.each([
    ["/api/search", true],
    ["/api/search/", true],
    ["/api/zvec/collections", true],
    ["/api/kb/import", true],
    ["/api/keywords/auto-tag", true],
    ["/api/relations/discover", true],
    ["/api/zvec", false], // 必须带子路径前缀
    ["/api/upload/list", false],
    ["/api/trpc/ping", false],
  ])("%s → %j", (path, expected) => {
    expect(isInternalRestPath(path)).toBe(expected);
  });
});

describe("isTrustedMutationRequest", () => {
  const req = (headers: Record<string, string>, url = "https://xuanji.example.com/api/kb/import") =>
    new Request(url, { method: "POST", headers });

  it("X-Requested-With: XMLHttpRequest 通过", () => {
    expect(isTrustedMutationRequest(req({ "x-requested-with": "XMLHttpRequest" }))).toBe(true);
  });

  it("同源 Origin 通过", () => {
    expect(isTrustedMutationRequest(req({ origin: "https://xuanji.example.com" }))).toBe(true);
  });

  it("跨站 Origin 拒绝", () => {
    expect(isTrustedMutationRequest(req({ origin: "https://evil.example.net" }))).toBe(false);
  });

  it("无任何信任标记拒绝", () => {
    expect(isTrustedMutationRequest(req({}))).toBe(false);
  });
});

describe("webhookToken / verifyWebhookToken", () => {
  const secret = "unit-test-secret";
  const updatedAtMs = 1_700_000_000_000;

  it("同一 id+updatedAt+secret 生成稳定 token 且可验证", () => {
    const a = webhookToken(7, updatedAtMs, secret);
    const b = webhookToken(7, updatedAtMs, secret);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyWebhookToken(7, a, updatedAtMs, secret)).toBe(true);
  });

  it("不同 id/token 不匹配", () => {
    expect(webhookToken(7, updatedAtMs, secret)).not.toBe(webhookToken(8, updatedAtMs, secret));
    expect(verifyWebhookToken(7, "0".repeat(32), updatedAtMs, secret)).toBe(false);
  });

  it("secret 不同则 token 不同", () => {
    expect(webhookToken(7, updatedAtMs, secret)).not.toBe(webhookToken(7, updatedAtMs, "other"));
  });

  it("t6/M2：改 updatedAtMs（改工作流）即换 token，旧 token 验证失败", () => {
    // 同一工作流，模拟"用户改了工作流后"
    const before = webhookToken(7, updatedAtMs, secret);
    const after = webhookToken(7, updatedAtMs + 1, secret);
    expect(after).not.toBe(before);
    // 旧 token 用旧 updatedAtMs 仍能过（向后兼容：持有旧 token 的系统在过期前可用）
    expect(verifyWebhookToken(7, before, updatedAtMs, secret)).toBe(true);
    // 旧 token 用新 updatedAtMs 拒绝（这是 M2 修复目标：工作流改了就该让旧 token 失效）
    expect(verifyWebhookToken(7, before, updatedAtMs + 1, secret)).toBe(false);
  });

  it("t6/M2：不同工作流 id 即使 updatedAt 相同也互不信任", () => {
    const t7 = webhookToken(7, updatedAtMs, secret);
    expect(verifyWebhookToken(8, t7, updatedAtMs, secret)).toBe(false);
  });

  it("非 32 位 hex 的 token 永远拒绝（防 type confusion）", () => {
    expect(verifyWebhookToken(7, "short", updatedAtMs, secret)).toBe(false);
    expect(verifyWebhookToken(7, "z".repeat(32), updatedAtMs, secret)).toBe(false);
    expect(verifyWebhookToken(7, "", updatedAtMs, secret)).toBe(false);
  });
});
