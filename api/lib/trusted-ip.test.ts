import { describe, expect, it } from "vitest";
import { getTrustedClientIp } from "./trusted-ip";

function makeHeaders(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("getTrustedClientIp", () => {
  // 说明：PLAN t1 verify 原文此用例期望 "1.2.3.4"，与其自身标注「最右非内网」
  // 及 change 字段「从右往左找第一个非内网」矛盾（左段恰是可伪造攻击面），
  // 故按 change 字段实现，期望取最右公网段 "5.6.7.8"。
  it("returns the rightmost public entry from x-forwarded-for", () => {
    expect(getTrustedClientIp(makeHeaders({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe(
      "5.6.7.8",
    );
  });

  it("skips private hops and returns the first non-internal candidate (right to left)", () => {
    // 10.0.0.5 为 RFC1918 私有段，跳过；"fake" 非 IP 字面量，不属于任何内网段
    expect(getTrustedClientIp(makeHeaders({ "x-forwarded-for": "fake, 10.0.0.5" }))).toBe("fake");
  });

  it("ignores the spoofed leftmost entry when the proxy appended the real client", () => {
    expect(getTrustedClientIp(makeHeaders({ "x-forwarded-for": "fake, 5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("skips loopback and link-local hops", () => {
    expect(
      getTrustedClientIp(makeHeaders({ "x-forwarded-for": "198.51.100.7, 169.254.1.1" })),
    ).toBe("198.51.100.7");
    expect(getTrustedClientIp(makeHeaders({ "x-forwarded-for": "198.51.100.7, 127.0.0.1" }))).toBe(
      "198.51.100.7",
    );
  });

  it("skips link-local IPv6 hops using the shared blocked-address logic", () => {
    expect(getTrustedClientIp(makeHeaders({ "x-forwarded-for": "2001:db8::1, fe80::1" }))).toBe(
      "2001:db8::1",
    );
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(getTrustedClientIp(makeHeaders({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("falls back to x-real-ip when every xff hop is internal", () => {
    expect(
      getTrustedClientIp(
        makeHeaders({ "x-forwarded-for": "10.0.0.5, 192.168.1.1, 127.0.0.1", "x-real-ip": "9.9.9.9" }),
      ),
    ).toBe("9.9.9.9");
  });

  it("returns unknown when neither xff nor x-real-ip yields a client", () => {
    expect(getTrustedClientIp(makeHeaders({}))).toBe("unknown");
    expect(
      getTrustedClientIp(makeHeaders({ "x-forwarded-for": "10.0.0.5, 192.168.1.1" })),
    ).toBe("unknown");
  });

  it("trims whitespace around xff entries", () => {
    expect(getTrustedClientIp(makeHeaders({ "x-forwarded-for": "  1.2.3.4 ,  10.0.0.5 " }))).toBe(
      "1.2.3.4",
    );
  });
});
