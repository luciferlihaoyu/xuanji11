import { describe, it, expect, beforeEach } from "vitest";
import {
  assertEgressAllowed,
  isBlockedAddress,
  setResolveHostForTests,
  type ResolveHost,
} from "./egress";

const fakeResolve = (map: Record<string, string[]>): ResolveHost =>
  async (host) => map[host] ?? [];

describe("isBlockedAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.8.8.8", true],
    ["10.1.2.3", true],
    ["172.16.0.9", true],
    ["172.31.255.1", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    ["100.64.0.1", true],
    ["::1", true],
    ["fc00::1", true],
    ["fe80::1", true],
    ["::ffff:192.168.1.1", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["2606:4700::1111", false],
  ])("%s → blocked=%j", (ip, expected) => {
    expect(isBlockedAddress(ip)).toBe(expected);
  });
});

describe("assertEgressAllowed", () => {
  beforeEach(() => {
    setResolveHostForTests(async () => ["93.184.216.34"]);
  });

  it("拒绝非 http(s) 协议", async () => {
    await expect(assertEgressAllowed("ftp://example.com/file")).rejects.toThrow(/protocol/i);
    await expect(assertEgressAllowed("file:///etc/passwd")).rejects.toThrow(/protocol/i);
  });

  it("拒绝无法解析的 URL", async () => {
    await expect(assertEgressAllowed("not a url")).rejects.toThrow();
  });

  it("hostname 为 IP 字面量时直接判定，不查 DNS", async () => {
    let dnsQueried = false;
    setResolveHostForTests(async () => {
      dnsQueried = true;
      return [];
    });
    await expect(assertEgressAllowed("http://192.168.1.1/api")).rejects.toThrow(/private|blocked/i);
    await expect(assertEgressAllowed("http://10.0.0.5/")).rejects.toThrow();
    expect(dnsQueried).toBe(false);
    await assertEgressAllowed("http://8.8.8.8/");
  });

  it("DNS 解析到内网地址时拒绝（含多记录任一命中）", async () => {
    setResolveHostForTests(async () => ["93.184.216.34", "10.0.0.1"]);
    await expect(assertEgressAllowed("http://evil.example.com/api")).rejects.toThrow();

    setResolveHostForTests(async () => []);
    await expect(assertEgressAllowed("http://nx.example.com/api")).rejects.toThrow(/resolve/i);
  });

  it("公网地址放行", async () => {
    await expect(assertEgressAllowed("https://example.com/api/auth/login")).resolves.toBeUndefined();
    await expect(assertEgressAllowed("http://93.184.216.34:5244/d")).resolves.toBeUndefined();
  });
});
