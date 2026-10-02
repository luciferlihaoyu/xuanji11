/**
 * safeFetch 的验收测试：把「出网校验」与「实际连接」钉成一次动作。
 *
 * 核心回归场景（对应 PLAN-出口校验TOCTOU）：
 * - T0 竞态：assertEgressAllowed 校验用的 DNS 与 fetch 连接用的 DNS 是**两次独立解析**，
 *   攻击者可控的 DNS 在两次之间换答案即可穿透 → safeFetch 结构上消除（解析一次、按判定地址连接）。
 * - T1 60s passCache：assertEgressAllowed 对同一 host 60 秒内免检 → 本文件"记录缺陷·现状"用例固化这一事实
 *   （assertEgressAllowed 本轮不改动；safeFetch 调用方不再依赖它做安全判定）。
 *
 * 测试网络：本机临时 http 服务器当靶机；DNS 用 setResolveHostForTests 注入假解析器。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  assertEgressAllowed,
  EgressError,
  setEgressPolicyForTests,
  setResolveHostForTests,
} from "./egress";
import { safeFetch } from "./safe-fetch";

let server: http.Server;
let baseUrl = ""; // http://127.0.0.1:<随机端口>
const hits = new Map<string, number>();

function hitCount(path: string): number {
  return hits.get(path) ?? 0;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/redirect") {
      // manual 用例：同 host 的 3xx
      res.writeHead(302, { location: `${baseUrl}/final` });
      res.end();
      return;
    }
    if (path === "/hop-redirect") {
      // follow 用例：下一跳指向一个"假域名 + 靶机端口"，验证第二跳会走注入的解析器并被钉住
      const port = (server.address() as AddressInfo).port;
      res.writeHead(302, { location: `http://hop.test:${port}/final` });
      res.end();
      return;
    }
    if (path === "/redirect-blocked") {
      // follow 用例：模拟攻击者在两跳之间改配置 —— 第一跳放行私网（否则到不了本靶机），
      // 响应 302 的**同时**把策略翻成拒绝；第二跳必须被拦（safeFetch 每跳重读策略）
      setEgressPolicyForTests(async () => false);
      res.writeHead(302, { location: "http://private.test/x" });
      res.end();
      return;
    }
    if (path === "/hang") {
      // 超时用例：故意拖住不断开
      const t = setTimeout(() => res.end("late"), 3000);
      res.on("close", () => clearTimeout(t));
      return;
    }
    res.writeHead(200, { "content-type": "application/xml", "content-length": "7" });
    res.end("<feed/>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  (server as unknown as { closeAll?: () => void }).closeAll?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setEgressPolicyForTests(async () => false);
  setResolveHostForTests(async () => {
    throw new Error("测试结束，不应再解析 DNS");
  });
});

describe("safeFetch", () => {
  it("拒绝非 http(s) 协议", async () => {
    await expect(safeFetch("ftp://example.com/file")).rejects.toBeInstanceOf(EgressError);
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/protocol/i);
  });

  it("拒绝无法解析的 URL", async () => {
    await expect(safeFetch("not a url")).rejects.toThrow(/invalid url/i);
  });

  it("【D3 后已修复】user 口径的复查是真复核：换 DNS 后当场暴露，不再被 60s 缓存短路", async () => {
    // D3 细分后 user 口径不读 passCache：每次校验（含 RSS 缓存复核）都是实时解析+实时判定。
    // 攻击者中途换 DNS 会被第二次校验当场拦下（此前的缺陷用例已随修复改写为本用例）。
    let resolveCalls = 0;
    setEgressPolicyForTests(async () => true);
    setResolveHostForTests(async () => {
      resolveCalls += 1;
      return resolveCalls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    });
    await expect(assertEgressAllowed("http://cachetest.invalid/feed", "user")).resolves.toBeUndefined();
    // 攻击者此刻把 DNS 换成内网地址；user 口径同一 host 再查一次 → 真复核，当场拦截
    await expect(assertEgressAllowed("http://cachetest.invalid/feed", "user")).rejects.toThrow(/private or blocked/i);
    expect(resolveCalls).toBe(2); // 两次都是真解析
  });

  it("【记录现状】admin 口径仍有 60s passCache：换 DNS 后复查直接通过（实际连接由 safeFetch 钉住兜底）", async () => {
    // admin 口径面向管理员配置的固定服务端点，保留 60s host 缓存换性能；
    // 其安全性由 safeFetch 的"解析一次→钉住连接"兜底，不依赖复查新鲜度。
    let resolveCalls = 0;
    setEgressPolicyForTests(async () => false);
    setResolveHostForTests(async () => {
      resolveCalls += 1;
      return resolveCalls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    });
    await expect(assertEgressAllowed("http://admincachetest.invalid/feed", "admin")).resolves.toBeUndefined();
    await expect(assertEgressAllowed("http://admincachetest.invalid/feed", "admin")).resolves.toBeUndefined();
    expect(resolveCalls).toBe(1); // 第二次被 passCache 短路（记录在案的设计取舍）
  });

  it("IP 字面量指内网 → 直接拒绝（不查 DNS），靶机零访问", async () => {
    setEgressPolicyForTests(async () => false);
    let dnsCalls = 0;
    setResolveHostForTests(async () => {
      dnsCalls += 1;
      return ["127.0.0.1"];
    });
    await expect(safeFetch(`${baseUrl}/feed`)).rejects.toThrow(/private or blocked/i);
    expect(dnsCalls).toBe(0); // 字面量不走解析器
    expect(hitCount("/feed")).toBe(0);
  });

  it("DNS 解析出内网地址 → 拒绝连接，靶机零访问", async () => {
    setEgressPolicyForTests(async () => false);
    setResolveHostForTests(async () => ["127.0.0.1"]);
    // 假域名 + 靶机端口：若实现有洞（没拦住），连接会真打到靶机上
    const port = (server.address() as AddressInfo).port;
    await expect(safeFetch(`http://blocked.test:${port}/feed`)).rejects.toThrow(/private or blocked/i);
    expect(hitCount("/feed")).toBe(0);
  });

  it("钉住连接：解析一次、连到判定的同一地址（用允许策略放行内网靶机来观察'连上'）", async () => {
    setEgressPolicyForTests(async () => true); // 允许私网 ⇒ 靶机(127.0.0.1)可达，用来观察"真的连上了"
    let resolveCalls = 0;
    setResolveHostForTests(async () => {
      resolveCalls += 1;
      return ["127.0.0.1"];
    });
    const port = (server.address() as AddressInfo).port;
    // host 是假域名（真 DNS 查不到），唯一能连上靶机的路径就是"按判定地址连接"
    const res = await safeFetch(`http://pin.test:${port}/feed`, { scope: "admin" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<feed/>");
    expect(resolveCalls).toBe(1); // 只解析一次（解析与连接同源）
    expect(hitCount("/feed")).toBe(1);
  });

  it("redirect:'manual'：3xx 原样返回，由调用方逐跳处理（RSS 现有语义）", async () => {
    setEgressPolicyForTests(async () => true);
    setResolveHostForTests(async () => ["127.0.0.1"]);
    const res = await safeFetch(`${baseUrl}/redirect`, { redirect: "manual", scope: "admin" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${baseUrl}/final`);
  });

  it("follow 模式：每一跳重新解析并钉住（第二跳走假域名）", async () => {
    setEgressPolicyForTests(async () => true);
    let resolveCalls = 0;
    setResolveHostForTests(async () => {
      resolveCalls += 1;
      return ["127.0.0.1"];
    });
    const res = await safeFetch(`${baseUrl}/hop-redirect`, { scope: "admin" }); // 默认 follow
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<feed/>");
    // 第一跳 host 是 IP 字面量（不查 DNS），第二跳 hop.test 查了一次 ⇒ 共 1 次解析
    expect(resolveCalls).toBe(1);
    expect(hitCount("/hop-redirect")).toBe(1);
    expect(hitCount("/final")).toBe(1);
  });

  it("follow 模式：下一跳解析到内网 → 在第二跳被拦，且不再访问", async () => {
    // 第一跳放行私网（到得了本靶机）；靶机应 302 时把策略翻成拒绝（模拟两跳之间配置被改），
    // safeFetch 每跳重读策略，第二跳解析出 10.9.9.9（内网）必须拦截
    setEgressPolicyForTests(async () => true);
    setResolveHostForTests(async (host) => (host === "private.test" ? ["10.9.9.9"] : ["127.0.0.1"]));
    await expect(safeFetch(`${baseUrl}/redirect-blocked`, { scope: "admin" })).rejects.toThrow(/private or blocked/i);
    expect(hitCount("/redirect-blocked")).toBe(1); // 第一跳已发生
    expect(hitCount("/x")).toBe(0); // 第二跳没有发生
  });

  it("【D3 核心用例】管理员开了内网，默认 scope=user 仍拦内网靶机（配置开不了用户的门）", async () => {
    setEgressPolicyForTests(async () => true);
    setResolveHostForTests(async () => ["127.0.0.1"]);
    const port = (server.address() as AddressInfo).port;
    const before = hitCount("/feed"); // 计数器全文件累计，用差值断言"本轮请求零到达"
    // 不传 scope —— 默认 user：RSS 订阅这类用户/上游可控 URL，任何配置都不许进内网
    await expect(safeFetch(`http://user.test:${port}/feed`)).rejects.toThrow(/private or blocked/i);
    expect(hitCount("/feed")).toBe(before);
  });

  it("arrayBuffer() 可读二进制响应体（ingestion 下载用）", async () => {
    setEgressPolicyForTests(async () => true);
    setResolveHostForTests(async () => ["127.0.0.1"]);
    const port = (server.address() as AddressInfo).port;
    const res = await safeFetch(`http://bin.test:${port}/feed`, { scope: "admin" });
    const ab = await res.arrayBuffer();
    expect(new TextDecoder().decode(ab)).toBe("<feed/>");
  });

  it("调用方传入的 AbortSignal 超时生效", async () => {
    setEgressPolicyForTests(async () => true);
    setResolveHostForTests(async () => ["127.0.0.1"]);
    await expect(
      safeFetch(`${baseUrl}/hang`, { signal: AbortSignal.timeout(250), scope: "admin" }),
    ).rejects.toThrow();
  });
});
