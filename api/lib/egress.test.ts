import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assertEgressAllowed,
  isBlockedAddress,
  setResolveHostForTests,
  setEgressPolicyForTests,
  isPrivateNetAllowed,
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
    // —— 2026-10-01 补：此前漏判的网段（PLAN-出口校验TOCTOU §2.1）——
    ["feb0::1", true], // 链路本地是 fe80::/10（fe80–febf），旧实现只匹配 "fe80" 前缀
    ["febf::1", true], // 同上边界
    ["192.0.0.9", true], // 192.0.0.0/24 IETF 协议分配
    ["198.18.0.5", true], // 198.18.0.0/15 基准测试保留段
    ["198.19.255.255", true], // /15 上边界
    ["224.0.0.1", true], // 组播 224.0.0.0/4
    ["240.0.0.1", true], // 保留 240.0.0.0/4
    ["255.255.255.255", true], // /4 内
    ["64:ff9b::7f00:1", true], // NAT64 64:ff9b::/96（译回 127.0.0.1）
    ["2002:7f00:1::", true], // 6to4 2002::/16（封装 127.0.0.1）
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["2606:4700::1111", false],
    // 不许误伤的对照项：
    ["fec0::1", false], // fec0::/10 是已废弃的站点本地，不是链路本地，旧 startsWith("fe80") 本来就不拦它
    ["198.20.0.1", false], // 刚好落在 198.18.0.0/15 之外
    ["192.0.1.1", false], // 刚好落在 192.0.0.0/24 之外
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

describe("isPrivateNetAllowed 策略来源", () => {
  afterEach(() => {
    // 重置为默认 provider：env=false 兜底
    setEgressPolicyForTests(async () => false);
  });

  it("默认（注入 false provider）拒绝内网出网", async () => {
    setEgressPolicyForTests(async () => false);
    expect(await isPrivateNetAllowed()).toBe(false);
  });

  it("管理员在系统设置开启后放行（注入 true provider）", async () => {
    setEgressPolicyForTests(async () => true);
    expect(await isPrivateNetAllowed()).toBe(true);
  });

  it("setEgressPolicyForTests 切换后立即生效（清缓存）", async () => {
    setEgressPolicyForTests(async () => true);
    expect(await isPrivateNetAllowed()).toBe(true);
    setEgressPolicyForTests(async () => false);
    expect(await isPrivateNetAllowed()).toBe(false);
  });
});
