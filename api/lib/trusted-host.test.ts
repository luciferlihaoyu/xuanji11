/**
 * X-Forwarded-Host 白名单：宁可丢失 header 也不被伪造劫持。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTrustedForwardedHost } from "./trusted-host";

const REQ = (xff: string | null): Request => new Request("https://origin.test/path", {
  headers: xff ? { "x-forwarded-host": xff } : {},
});

describe("getTrustedForwardedHost (Reviewer B 闭环)", () => {
  const ORIGINAL_ENV = process.env.TRUSTED_FORWARDED_HOSTS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TRUSTED_FORWARDED_HOSTS;
    else process.env.TRUSTED_FORWARDED_HOSTS = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it("未配置白名单 → XFF 完全不被信任（即使攻击者构造）", () => {
    delete process.env.TRUSTED_FORWARDED_HOSTS;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getTrustedForwardedHost(REQ("evil.com"))).toBeNull();
    // 未配置时不打 warn（无白名单谈不上"不在白名单"）
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("白名单命中 → 返回 XFF 原值", () => {
    process.env.TRUSTED_FORWARDED_HOSTS = "app.example.com,www.example.com";
    expect(getTrustedForwardedHost(REQ("app.example.com"))).toBe("app.example.com");
    expect(getTrustedForwardedHost(REQ("www.example.com"))).toBe("www.example.com");
  });

  it("白名单大小写不敏感", () => {
    process.env.TRUSTED_FORWARDED_HOSTS = "App.Example.com";
    expect(getTrustedForwardedHost(REQ("app.example.com"))).toBe("app.example.com");
  });

  it("XFF 不在白名单 → null + warn", () => {
    process.env.TRUSTED_FORWARDED_HOSTS = "app.example.com";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getTrustedForwardedHost(REQ("evil.com"))).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/evil\.com/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/白名单/);
  });

  it("XFF 多段（链路式代理）只取首段", () => {
    process.env.TRUSTED_FORWARDED_HOSTS = "app.example.com";
    expect(getTrustedForwardedHost(REQ("app.example.com,internal.proxy"))).toBe("app.example.com");
  });

  it("XFF 首段两端空白被 trim", () => {
    process.env.TRUSTED_FORWARDED_HOSTS = "app.example.com";
    expect(getTrustedForwardedHost(REQ("  app.example.com  "))).toBe("app.example.com");
  });

  it("XFF 缺失 → null（无 warn）", () => {
    process.env.TRUSTED_FORWARDED_HOSTS = "app.example.com";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getTrustedForwardedHost(REQ(null))).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("白名单配置含空段（如末尾逗号 / 连续逗号）→ 忽略空段", () => {
    process.env.TRUSTED_FORWARDED_HOSTS = "app.example.com,, ,www.example.com,";
    expect(getTrustedForwardedHost(REQ("app.example.com"))).toBe("app.example.com");
    expect(getTrustedForwardedHost(REQ("www.example.com"))).toBe("www.example.com");
  });
});
