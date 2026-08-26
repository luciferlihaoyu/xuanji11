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

  it("同一 id+secret 生成稳定 token 且可验证", () => {
    const a = webhookToken(7, secret);
    const b = webhookToken(7, secret);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyWebhookToken(7, a, secret)).toBe(true);
  });

  it("不同 id/token 不匹配", () => {
    expect(webhookToken(7, secret)).not.toBe(webhookToken(8, secret));
    expect(verifyWebhookToken(7, "0".repeat(32), secret)).toBe(false);
  });

  it("secret 不同则 token 不同", () => {
    expect(webhookToken(7, secret)).not.toBe(webhookToken(7, "other"));
  });
});
