/**
 * RSS 连接器单元测试
 * 范式参考 alist.test.ts：vi.hoisted 设环境变量 + setEgressPolicyForTests 放行 egress + vi.stubGlobal("fetch")。
 * 真实固件 api/connectors/__fixtures__/hn-rss2.xml 只读引用，绝不修改。
 *
 * 先写测试（RED）再实现（GREEN）。核心断言：
 * - testConnection 校验内容而非只看状态码（200 的 HTML 必须失败，绝不"0 条成功"）
 * - 连接器内短期缓存：listFiles 1 次 + N 次 getContent 合计只发 1 次 HTTP
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-characters-long!!";
});

// 放行 egress 让连接器测试可以走到 fetch mock 阶段（私网/重定向用例内单独改写策略与 DNS）
import { setEgressPolicyForTests, setResolveHostForTests } from "../lib/egress";
setEgressPolicyForTests(async () => true);

import { parseFeed } from "./feed-parse";
import { setSafeFetchTransportForTests } from "../lib/safe-fetch";
import {
  connectorRss,
  clearFeedCacheForTests,
  safeFileName,
  FEED_CACHE_TTL_MS,
  FEED_MAX_ENTRIES,
  FEED_MAX_BODY_BYTES,
  MAX_REDIRECTS,
} from "./rss";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const hnRss2 = readFileSync(path.join(FIXTURE_DIR, "hn-rss2.xml"), "utf-8");
const hnParsed = parseFeed(hnRss2);

/** 每个 it 用唯一 url，配合 beforeEach 清缓存，彻底隔离模块级缓存。 */
let testSeq = 0;
function freshUrl(): string {
  testSeq += 1;
  return `https://feed${testSeq}.example.test/rss`;
}

function config(url: string = freshUrl()): Record<string, unknown> {
  return { url, apiKey: "" };
}

function feedResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    status: init.status ?? 200,
    headers: { "Content-Type": "application/rss+xml; charset=utf-8", ...(init.headers ?? {}) },
  });
}

/**
 * 用工厂函数应答：每次 fetch 都产出全新的 Response。
 * （Response body 一次性消费，mockResolvedValue 复用同一实例会让第二次 fetch 读到空 body。）
 */
function mockFetch(factory: () => Response): void {
  fetchMock.mockImplementation(async () => factory());
}

/**
 * 合成 feed：覆盖标题安全化 / 无 pubDate / 空标题回退 / 超长标题。
 * 注意 title 里 `>` 写在 `<` 之前，避免被 parseFeed 的 toPlainText 当成 HTML 标签整段剥掉，
 * 从而真正考察连接器自己的文件名安全化。
 */
const EDGE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Edge Cases</title><link>https://edge.example.test/</link>
<item><title><![CDATA[Deep/a\\b: c*d?e"f >g <h |i   j]]></title>
<description><![CDATA[<p>Odd title body</p>]]></description>
<pubDate>Mon, 01 Sep 2026 08:00:00 +0000</pubDate>
<link>https://edge.example.test/odd</link>
<guid>odd-title-guid</guid></item>
<item><title></title>
<description><![CDATA[<p>No title at all</p>]]></description>
<pubDate>Tue, 02 Sep 2026 08:00:00 +0000</pubDate>
<link>https://edge.example.test/no-title</link>
<guid>no-title-guid</guid></item>
<item><title><![CDATA[Undated entry]]></title>
<description><![CDATA[<p>Published date missing on purpose</p>]]></description>
<link>https://edge.example.test/undated</link>
<guid>undated-guid</guid></item>
<item><title><![CDATA[${"超".repeat(200)}]]></title>
<description><![CDATA[<p>Very long title</p>]]></description>
<pubDate>Wed, 03 Sep 2026 08:00:00 +0000</pubDate>
<link>https://edge.example.test/long</link>
<guid>long-title-guid</guid></item>
</channel></rss>`;

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  // rss.ts 的出网已切到 safeFetch（钉连接）；这里把 safeFetch 的测试运输口接到同一个
  // fetchMock 上 —— 断言面（调用参数/次数/应答）与旧范式完全一致，82 个契约原样保留。
  setSafeFetchTransportForTests(
    async (url, init) => fetchMock(url as unknown as string, init as unknown as RequestInit),
  );
  // user 口径下 assertEgressAllowed 不再因放行开关跳过 DNS（2026-10-01 D3）：
  // 默认把假域名解析成公网 IP，个别用例如需内网/特定解析自行覆盖（重定向组用例已有自己的注入）。
  setResolveHostForTests(async () => ["93.184.216.34"]);
  clearFeedCacheForTests();
  setEgressPolicyForTests(async () => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RSS 连接器 · 配置校验与注册", () => {
  it("注册名 rss，name=RSS，authType=apikey", async () => {
    const { getConnector } = await import("./index");
    expect(getConnector("rss")).toBe(connectorRss);
    expect(connectorRss.name).toBe("RSS");
    expect(connectorRss.authType).toBe("apikey");
  });

  it("缺 url 时 testConnection 明确报错且不发请求", async () => {
    const r = await connectorRss.testConnection({});
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/缺少/);
    expect(r.message).toMatch(/url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺 url 时 listFiles / getContent / getDownloadUrl 都明确报错（不静默成功）", async () => {
    await expect(connectorRss.listFiles({})).rejects.toThrow(/缺少.*url/);
    await expect(connectorRss.getContent!({}, "x")).rejects.toThrow(/缺少.*url/);
    await expect(connectorRss.getDownloadUrl({}, "x")).rejects.toThrow(/缺少.*url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("非 http/https 的 url 被拒绝", async () => {
    const r = await connectorRss.testConnection({ url: "ftp://example.test/feed" });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/http/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RSS 连接器 · testConnection", () => {
  it("真实 RSS2.0 固件：成功且提示包含条数 20", async () => {
    mockFetch(() => feedResponse(hnRss2));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/连接成功/);
    expect(r.message).toMatch(/20/);
  });

  it("带固定 User-Agent / Accept / 超时 signal，且重定向交给自己手动处理", async () => {
    mockFetch(() => feedResponse(hnRss2));
    await connectorRss.testConnection(config());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\//);
    const headers = init!.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Xuanji/i);
    expect(headers["Accept"]).toMatch(/xml/i);
    // 必须 manual：交由连接器逐跳做 egress 校验，不能让 fetch 静默跟随
    expect(init!.redirect).toBe("manual");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("200 但返回 HTML 页面 → 失败且错误可读（绝不静默 0 条成功）", async () => {
    mockFetch(() =>
      feedResponse("<!DOCTYPE html><html><head><title>Just a webpage</title></head><body><h1>Hello</h1></body></html>"),
    );
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/不是 RSS\/Atom feed/);
    expect(r.message.length).toBeGreaterThan(10);
  });

  it("200 但返回空 body → 失败", async () => {
    mockFetch(() => feedResponse(""));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/不是 RSS\/Atom feed/);
  });

  it("合法 feed 但 0 条目 → 必须判为失败（不许当成「0 条也算连接成功」）", async () => {
    mockFetch(() => feedResponse(`<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>`));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/合法 feed/);
    expect(r.message).toMatch(/没有任何条目/);
    expect(r.message).not.toMatch(/不是 RSS\/Atom feed/);
    expect(r.message).not.toMatch(/连接成功/);
  });

  it("空 Atom feed 同样判失败（三种根形态口径一致）", async () => {
    mockFetch(() => feedResponse(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title></feed>`));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/合法 feed/);
    expect(r.message).toMatch(/没有任何条目/);
  });

  it("两种失败可区分：非 feed ≠ feed 但空", async () => {
    mockFetch(() => feedResponse("<!DOCTYPE html><html><body>webpage</body></html>"));
    const notFeed = await connectorRss.testConnection(config());
    mockFetch(() => feedResponse(`<rss version="2.0"><channel><title>T</title></channel></rss>`));
    const emptyFeed = await connectorRss.testConnection(config());

    expect(notFeed.success).toBe(false);
    expect(emptyFeed.success).toBe(false);
    expect(notFeed.message).toMatch(/不是 RSS\/Atom feed/);
    expect(notFeed.message).not.toMatch(/合法 feed/);
    expect(emptyFeed.message).toMatch(/合法 feed/);
    expect(emptyFeed.message).not.toMatch(/不是 RSS\/Atom feed/);
    expect(notFeed.message).not.toBe(emptyFeed.message);
  });

  it("HTTP 500 → 失败并带状态码", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/HTTP 500/);
  });

  it("HTTP 429 带 Retry-After → 失败且提示限流与重试时间", async () => {
    mockFetch(() => new Response("too many requests", { status: 429, headers: { "Retry-After": "120" } }));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/429/);
    expect(r.message).toMatch(/限流/);
    expect(r.message).toMatch(/120/);
  });

  it("网络层报错（fetch reject）→ 转成失败结果而不是抛给调用方", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/socket hang up|抓取失败/);
  });

  it("egress 被拒（私网地址）→ 失败且完全不发出 fetch", async () => {
    setEgressPolicyForTests(async () => false);
    const r = await connectorRss.testConnection({ url: "http://127.0.0.1/feed" });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/egress blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("egress 被拒时 listFiles / getContent / getDownloadUrl 同样拒绝且不发 fetch", async () => {
    setEgressPolicyForTests(async () => false);
    await expect(connectorRss.listFiles({ url: "http://127.0.0.1/feed" })).rejects.toThrow(/egress blocked/i);
    await expect(connectorRss.getContent!({ url: "http://10.0.0.8/feed" }, "x")).rejects.toThrow(/egress blocked/i);
    await expect(connectorRss.getDownloadUrl({ url: "http://169.254.169.254/latest" }, "x")).rejects.toThrow(/egress blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RSS 连接器 · listFiles", () => {
  it("真实固件映射为 20 条 CloudFile，字段齐全", async () => {
    mockFetch(() => feedResponse(hnRss2));
    const files = await connectorRss.listFiles(config());
    expect(files).toHaveLength(20);

    const first = files[0]!;
    const src = hnParsed.entries[0]!;
    expect(first.id).toBe(src.id);
    expect(first.id).toBe("https://news.ycombinator.com/item?id=49892721");
    expect(first.type).toBe("file");
    expect(first.mimeType).toBe("text/markdown");
    expect(first.name).toBe("The new Firefox design is here.md");
    expect(first.downloadUrl).toBe("https://blog.mozilla.org/en/firefox/new-firefox-design-is-here/");
    expect(first.modifiedAt).toBeInstanceOf(Date);
    expect(first.modifiedAt!.toISOString()).toBe("2026-09-29T13:16:10.000Z");
    // size = 正文字节数（content 缺失时回退 summary）
    expect(first.size).toBe(Buffer.byteLength(src.content, "utf8"));
    expect(first.size!).toBeGreaterThan(0);
  });

  it("每条文件名都以 .md 结尾且不含非法字符", async () => {
    mockFetch(() => feedResponse(hnRss2));
    const files = await connectorRss.listFiles(config());
    for (const f of files) {
      expect(f.name.endsWith(".md")).toBe(true);
      expect(f.name).not.toMatch(/[/\\:*?"<>|]/);
      expect(f.name).not.toMatch(/\p{Cc}/u);
    }
  });

  it("标题安全化：非法字符剔除、空白压缩、超长截断、空标题有回退名", async () => {
    mockFetch(() => feedResponse(EDGE_FEED));
    const files = await connectorRss.listFiles(config());
    expect(files).toHaveLength(4);

    const odd = files.find((f) => f.id === "odd-title-guid")!;
    expect(odd.name).toBe("Deep a b c d e f g h i j.md");

    const noTitle = files.find((f) => f.id === "no-title-guid")!;
    expect(noTitle.name).toMatch(/^untitled-[0-9a-z]{6}\.md$/);

    const long = files.find((f) => f.id === "long-title-guid")!;
    expect(long.name.length).toBeLessThanOrEqual(80 + ".md".length);
    expect(long.name).toBe("超".repeat(80) + ".md");
  });

  it("无 pubDate 的条目 modifiedAt 为 undefined", async () => {
    mockFetch(() => feedResponse(EDGE_FEED));
    const files = await connectorRss.listFiles(config());
    expect(files.find((f) => f.id === "undated-guid")!.modifiedAt).toBeUndefined();
  });

  it("合法 feed 但 0 条条目 → 返回空数组（不报错）", async () => {
    mockFetch(() => feedResponse(`<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`));
    expect(await connectorRss.listFiles(config())).toEqual([]);
  });

  it("非 feed 输入时 listFiles 抛可读错误（不静默空列表）", async () => {
    mockFetch(() => feedResponse("<html><body>nope</body></html>"));
    await expect(connectorRss.listFiles(config())).rejects.toThrow(/不是 RSS\/Atom feed/);
  });

  it("同 guid 的重复条目只保留一条（externalId 是下游去重键，不能重复占位）", async () => {
    const dup = `<?xml version="1.0"?><rss version="2.0"><channel><title>Dup</title>
<item><title>A</title><description>x</description><link>https://d.example.test/a</link><guid>dup-guid</guid></item>
<item><title>A again</title><description>y</description><link>https://d.example.test/a2</link><guid>dup-guid</guid></item>
</channel></rss>`;
    mockFetch(() => feedResponse(dup));
    const files = await connectorRss.listFiles(config());
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("dup-guid");
  });
});

describe("RSS 连接器 · getContent", () => {
  it("markdown 正文含标题 / 来源 / 链接 / 发布时间 / 内容", async () => {
    const url = freshUrl();
    mockFetch(() => feedResponse(hnRss2));
    const files = await connectorRss.listFiles(config(url));
    const md = await connectorRss.getContent!(config(url), files[0]!.id);
    expect(md).not.toBeNull();
    expect(md!.mimeType).toBe("text/markdown");
    expect(md!.fileName).toBe("The new Firefox design is here.md");
    expect(md!.content.split("\n")[0]).toBe("# The new Firefox design is here");
    expect(md!.content).toContain("- 来源: Hacker News: Front Page");
    expect(md!.content).toContain("- 链接: https://blog.mozilla.org/en/firefox/new-firefox-design-is-here/");
    expect(md!.content).toContain("- 发布时间: 2026-09-29T13:16:10.000Z");
    expect(md!.content).toContain(hnParsed.entries[0]!.content);
    expect(md!.content).not.toMatch(/<p>/);
  });

  it("缺失 pubDate 时省略「发布时间」行；正文回退 summary", async () => {
    const url = freshUrl();
    mockFetch(() => feedResponse(EDGE_FEED));
    const md = await connectorRss.getContent!(config(url), "undated-guid");
    expect(md).not.toBeNull();
    expect(md!.content).not.toMatch(/发布时间/);
    expect(md!.content).toContain("# Undated entry");
    expect(md!.content).toContain("Published date missing on purpose");
  });

  it("fileId 不存在时返回 null（不抛错、不额外发请求）", async () => {
    const url = freshUrl();
    mockFetch(() => feedResponse(hnRss2));
    await connectorRss.listFiles(config(url));
    const md = await connectorRss.getContent!(config(url), "https://news.ycombinator.com/item?id=NOPE");
    expect(md).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("RSS 连接器 · getDownloadUrl", () => {
  it("按 id 返回 entry.link", async () => {
    const url = freshUrl();
    mockFetch(() => feedResponse(hnRss2));
    const files = await connectorRss.listFiles(config(url));
    expect(await connectorRss.getDownloadUrl(config(url), files[3]!.id)).toBe("https://www.cbc.ca/lite/story/9.7361622");
  });

  it("未知 id 返回 null", async () => {
    const url = freshUrl();
    mockFetch(() => feedResponse(hnRss2));
    await connectorRss.listFiles(config(url));
    expect(await connectorRss.getDownloadUrl(config(url), "no-such-id")).toBeNull();
  });
});

describe("RSS 连接器 · 短期缓存（本任务最关键性能要求）", () => {
  it("1 次 listFiles + 20 次 getContent 合计只发 1 次 HTTP", async () => {
    const url = freshUrl();
    mockFetch(() => feedResponse(hnRss2));
    const files = await connectorRss.listFiles(config(url));
    expect(files).toHaveLength(20);
    for (const f of files) {
      expect(await connectorRss.getContent!(config(url), f.id)).not.toBeNull();
    }
    await connectorRss.getDownloadUrl(config(url), files[0]!.id);
    await connectorRss.testConnection(config(url));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("并发 getContent 也只发 1 次 HTTP（in-flight 去重）", async () => {
    const url = freshUrl();
    mockFetch(() => feedResponse(hnRss2));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        connectorRss.getContent!(config(url), `https://news.ycombinator.com/item?id=${49892720 + i}`),
      ),
    );
    expect(results.filter(Boolean).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("不同 feed URL 各自独立取（不串味）", async () => {
    const a = freshUrl();
    const b = freshUrl();
    mockFetch(() => feedResponse(hnRss2));
    await connectorRss.listFiles(config(a));
    await connectorRss.listFiles(config(b));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("超过 TTL 后缓存过期，重新取一次", async () => {
    vi.useFakeTimers();
    const started = Date.parse("2026-09-29T00:00:00Z");
    vi.setSystemTime(started);
    const url = freshUrl();
    mockFetch(() => feedResponse(hnRss2));
    await connectorRss.listFiles(config(url));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await connectorRss.getContent!(config(url), "https://news.ycombinator.com/item?id=49892721");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(started + FEED_CACHE_TTL_MS + 1000);
    await connectorRss.getContent!(config(url), "https://news.ycombinator.com/item?id=49892721");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("失败不写缓存：连续两次 testConnection 各发一次请求", async () => {
    const url = freshUrl();
    mockFetch(() => new Response("nope", { status: 500 }));
    await connectorRss.testConnection(config(url));
    await connectorRss.testConnection(config(url));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("TTL 取值在 30~60s，缓存条目数有上限", () => {
    expect(FEED_CACHE_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(FEED_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
    expect(FEED_MAX_ENTRIES).toBeGreaterThan(0);
  });

  it("超大 feed 只缓存前 FEED_MAX_ENTRIES 条（内存护栏）", async () => {
    const items = Array.from(
      { length: FEED_MAX_ENTRIES + 120 },
      (_, i) =>
        `<item><title>Item ${i}</title><description>d${i}</description><link>https://big.example.test/${i}</link><guid>big-${i}</guid></item>`,
    ).join("");
    mockFetch(() => feedResponse(`<rss version="2.0"><channel><title>Big</title>${items}</channel></rss>`));
    const files = await connectorRss.listFiles(config());
    expect(files).toHaveLength(FEED_MAX_ENTRIES);
  });
});

describe("RSS 连接器 · 文件名安全化规则（safeFileName 直测）", () => {
  it('非法字符 / \\ : * ? " < > | 逐个换成空格并压缩空白', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j', "id-1")).toBe("a b c d e f g h i j.md");
  });

  it("控制字符（U+0000/U+001F/U+007F/U+0007）清成空格并压缩", () => {
    const sep = String.fromCharCode(0) + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + String.fromCharCode(7);
    expect(safeFileName(["a", "b", "c", "d", "e"].join(sep), "id-2")).toBe("a b c d e.md");
  });

  it("首尾点剥掉、中间点保留，空白被压缩", () => {
    expect(safeFileName("  ..hidden.file..  ", "id-3")).toBe("hidden.file.md");
  });

  it("按码点截断到 80，不切碎代理对（emoji）", () => {
    const name = safeFileName("x".repeat(79) + "\u{1F600}tail", "id-4");
    expect(name).toBe("x".repeat(79) + "\u{1F600}.md");
    expect(Array.from(name.slice(0, -3))).toHaveLength(80);
  });

  it("空标题回退 untitled-<6 位哈希>：确定性、同 id 同名、异 id 异名", () => {
    const a = safeFileName("", "guid-a");
    const b = safeFileName("", "guid-b");
    const sameAgain = safeFileName("   ", "guid-a");
    expect(a).toMatch(/^untitled-[0-9a-z]{6}\.md$/);
    expect(sameAgain).toBe(a);
    expect(a).not.toBe(b);
  });

  it("撞上 Windows 保留名前缀 _ 避让", () => {
    expect(safeFileName("CON", "id-5")).toBe("_CON.md");
    expect(safeFileName("nul", "id-6")).toBe("_nul.md");
    expect(safeFileName("com1", "id-7")).toBe("_com1.md");
  });
});

// ============================ 复核追加要求（先 RED 后修复） ============================

describe("RSS 连接器 · 重定向 SSRF 逐跳门禁（阻塞项）", () => {
  /** 把 DNS 钉到公网 IP：让首跳合法、重定向目标非法，精确复现攻击面 */
  const PUBLIC_IP = "93.184.216.34";
  const defaultResolver = async (host: string): Promise<string[]> => {
    const dns = await import("node:dns");
    const records = await dns.promises.lookup(host, { all: true, verbatim: true });
    return records.map((r) => r.address);
  };

  function redirectResponse(location: string | null, status = 302): Response {
    const res = new Response(null, { status });
    if (location !== null) res.headers.set("location", location);
    return res;
  }

  afterEach(() => {
    setResolveHostForTests(defaultResolver);
  });

  it("302 → 环回地址：真实策略在下一跳发出前拦住，内网目标零请求", async () => {
    setEgressPolicyForTests(async () => false);
    setResolveHostForTests(async () => [PUBLIC_IP]);
    const url = freshUrl();
    fetchMock.mockImplementation(async (input) =>
      String(input) === url ? redirectResponse("http://127.0.0.1:8080/internal-secret") : feedResponse(hnRss2),
    );
    const r = await connectorRss.testConnection(config(url));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/egress blocked/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("127.0.0.1"))).toBe(false);
    expect(r.message).not.toMatch(/连接成功/);
  });

  it("302 → 云元数据 169.254.169.254：listFiles 同样被拒且不发出第二跳", async () => {
    setEgressPolicyForTests(async () => false);
    setResolveHostForTests(async () => [PUBLIC_IP]);
    const url = freshUrl();
    fetchMock.mockImplementation(async (input) =>
      String(input) === url ? redirectResponse("http://169.254.169.254/latest/meta-data/iam/") : feedResponse(hnRss2),
    );
    await expect(connectorRss.listFiles(config(url))).rejects.toThrow(/egress blocked/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("多跳内网也拦得住：公网→公网→内网（第 3 跳）", async () => {
    setEgressPolicyForTests(async () => false);
    setResolveHostForTests(async () => [PUBLIC_IP]);
    const url = freshUrl();
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u === url) return redirectResponse("https://ok1.example.test/a");
      if (u.includes("ok1.example.test")) return redirectResponse("http://10.0.0.9/admin");
      return feedResponse(hnRss2);
    });
    const r = await connectorRss.testConnection(config(url));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/egress blocked/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("10.0.0.9"))).toBe(false);
  });

  it("全公网多跳 302→301→200 正常跟随，相对 Location 正确解析为绝对地址", async () => {
    const base = freshUrl(); // https://feedN.example.test/rss
    const hop2 = new URL("/moved/feed.xml", base).toString();
    const hop3 = `https://cdn${testSeq}.example.test/final.xml`;
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u === base) return redirectResponse("/moved/feed.xml", 302); // 相对路径
      if (u === hop2) return redirectResponse(hop3, 301); // 绝对地址
      return feedResponse(hnRss2);
    });
    const r = await connectorRss.testConnection(config(base));
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/共 20 条/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![0])).toBe(hop2);
    expect(String(fetchMock.mock.calls[2]![0])).toBe(hop3);
  });

  it("跳数超过上限 → 明确拒绝，且不再发出下一跳", async () => {
    const base = freshUrl();
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n += 1;
      return redirectResponse(`${base}?hop=${n}`);
    });
    const r = await connectorRss.testConnection(config(base));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/重定向/);
    expect(r.message).toMatch(/上限/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("重定向到非 http(s) 协议一律拒绝（file/gopher/javascript），且不发请求", async () => {
    for (const loc of ["file:///etc/passwd", "gopher://127.0.0.1:70/x", "javascript:alert(1)"]) {
      const base = freshUrl();
      // 【测试自身修正，非放宽断言】三个协议各是一轮独立场景（url 也不同），但 vi.fn() 的调用
      // 计数在同一个 it 内部是累加的：不逐轮清零，第 2 轮起必是 2/3 次，"每轮只发 1 次请求"
      // 这条断言在结构上永远不可能满足。断言文本一字未改，只把计数口径摆正到「本轮」。
      fetchMock.mockClear();
      fetchMock.mockImplementation(async (input) =>
        String(input) === base ? redirectResponse(loc) : feedResponse(hnRss2),
      );
      const r = await connectorRss.testConnection(config(base));
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/协议/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("3xx 但没有 Location 头 → 明确报错（不静默当空 feed 成功）", async () => {
    mockFetch(() => redirectResponse(null));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Location/);
    expect(r.message).not.toMatch(/连接成功/);
  });

  it("跳转后的响应仍走同样的状态码/内容校验（跳到 429 要报限流）", async () => {
    const base = freshUrl();
    fetchMock.mockImplementation(async (input) =>
      String(input) === base
        ? redirectResponse("https://slow.example.test/feed")
        : new Response("too many", { status: 429, headers: { "Retry-After": "60" } }),
    );
    const r = await connectorRss.testConnection(config(base));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/429|限流/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("重定向不影响缓存语义：一条跳转链后逐条 getContent 不再发请求", async () => {
    const base = freshUrl();
    fetchMock.mockImplementation(async (input) =>
      String(input) === base ? redirectResponse("final.xml", 302) : feedResponse(hnRss2),
    );
    const files = await connectorRss.listFiles(config(base));
    expect(files).toHaveLength(20);
    for (const f of files) expect(await connectorRss.getContent!(config(base), f.id)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 跳 + 1 次正文，之后全走缓存
  });
});

describe("RSS 连接器 · 空源闸门必须与 listFiles 同口径（应修 1）", () => {
  // 只有 description、无 title/link/guid 的怪源：parseFeed 给 id:""，历史上被 listFiles 静默丢弃
  const WEIRD_FEED = `<rss version="2.0"><channel><title>Weird</title><item><description>裸正文</description></item></channel></rss>`;
  const TWIN_FEED = `<rss version="2.0"><channel><title>Twin</title><item><description>same</description></item><item><description>same</description></item></channel></rss>`;

  it("无 title/link/guid 的条目不被静默丢弃，而是拿到稳定合成 id", async () => {
    mockFetch(() => feedResponse(WEIRD_FEED));
    const url = freshUrl();
    const files = await connectorRss.listFiles(config(url));
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toMatch(/^entry-[0-9a-z]{8,}$/);
    expect(files[0]!.size).toBeGreaterThan(0);
  });

  it("testConnection 的条数 = listFiles 的条数（闸门用同一过滤口径）", async () => {
    mockFetch(() => feedResponse(WEIRD_FEED));
    const url = freshUrl();
    const files = await connectorRss.listFiles(config(url));
    const r = await connectorRss.testConnection(config(url));
    expect(files).toHaveLength(1);
    expect(r.success).toBe(true);
    expect(r.message).toContain(`共 ${files.length} 条`);
  });

  it("合成 id 可被 getContent 命中（有正文但没 id 的怪源也能入库）", async () => {
    mockFetch(() => feedResponse(WEIRD_FEED));
    const url = freshUrl();
    const files = await connectorRss.listFiles(config(url));
    const md = await connectorRss.getContent!(config(url), files[0]!.id);
    expect(md).not.toBeNull();
    expect(md!.content).toContain("裸正文");
    expect(await connectorRss.getDownloadUrl(config(url), files[0]!.id)).toBeNull(); // 无 link → null，不编造
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("合成 id 稳定：同一 feed 两次独立解析得到同一批 id（跨 sync 可去重）", async () => {
    mockFetch(() => feedResponse(WEIRD_FEED));
    const url = freshUrl();
    const first = await connectorRss.listFiles(config(url));
    clearFeedCacheForTests();
    const second = await connectorRss.listFiles(config(url));
    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("两条内容完全相同的无 id 条目：保留两条且 id 互不相同（不静默丢）", async () => {
    mockFetch(() => feedResponse(TWIN_FEED));
    const files = await connectorRss.listFiles(config());
    expect(files).toHaveLength(2);
    expect(new Set(files.map((f) => f.id)).size).toBe(2);
  });

  it("同 guid 的重复条目仍合并为一条（上游 id 语义不变）", async () => {
    const dup = `<rss version="2.0"><channel><title>Dup</title>
<item><title>A</title><description>x</description><guid>g1</guid></item>
<item><title>B</title><description>y</description><guid>g1</guid></item></channel></rss>`;
    mockFetch(() => feedResponse(dup));
    const files = await connectorRss.listFiles(config());
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("g1");
  });

  it("整个 feed 一条可用都没有 → 判失败（覆盖『有条目但全被过滤』）", async () => {
    // 上游把纯空壳条目解析掉，这里用「只有空壳 + 空 channel」两种形态各测一次
    mockFetch(() => feedResponse(`<rss version="2.0"><channel><title>T</title><item></item></channel></rss>`));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/合法 feed/);
    expect(r.message).toMatch(/没有任何条目/);
  });
});

describe("RSS 连接器 · 体积护栏按字节且边读边拦（应修 2）", () => {
  const enc = new TextEncoder();

  it("CJK 大 body：字符数未超上限但字节数超限，必须按字节拦住", async () => {
    // 每块 50,000 个 CJK 字符 = 150,000 字节；80 块 = 4,000,000 字符（< 4,194,304 字符口径）
    // 但字节数 12,000,000 > 4 MiB —— 旧实现按 body.length 判，会漏过
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulls += 1;
        if (pulls > 80) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(enc.encode("字".repeat(50_000)));
      },
    });
    fetchMock.mockImplementation(async () => new Response(stream, { status: 200 }));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/过大|超过上限/);
    expect(r.message).toMatch(/字节/);
    // 边读边拦：4 MiB / 150 KB ≈ 28 次 read，绝不能把 12 MB 全抽完
    expect(pulls).toBeLessThan(40);
  });

  it("流式读取阶段报错被包装成可读错误（不漏裸 TypeError）", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode(`<rss version="2.0"><channel><title>t</title>`));
      },
      pull(ctrl) {
        pulls += 1;
        ctrl.error(new TypeError("body stream terminated"));
      },
    });
    fetchMock.mockImplementation(async () => new Response(stream, { status: 200 }));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/读取|响应体|截断/);
    expect(r.message).toMatch(/terminated/);
  });

  it("content-length 超限仍然预检拦住（不必先读满）", async () => {
    const url = freshUrl();
    fetchMock.mockImplementation(async () => {
      throw new Error("must-not-read-body");
    });
    // 用带超长 content-length 的响应头先拦
    fetchMock.mockImplementation(async () => {
      const res = feedResponse(hnRss2);
      res.headers.set("content-length", String(FEED_MAX_BODY_BYTES * 3));
      return res;
    });
    const r = await connectorRss.testConnection(config(url));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/过大|超过上限/);
  });

  it("正常大小的 feed 不受护栏影响", async () => {
    mockFetch(() => feedResponse(hnRss2));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(true);
  });
});

describe("RSS 连接器 · 提示文案与 Retry-After 细节（应修 3/4）", () => {
  it("超长 feed 标题在提示里被截断，不撑爆日志", async () => {
    mockFetch(() =>
      feedResponse(`<rss version="2.0"><channel><title>${"T".repeat(30000)}</title></channel></rss>`),
    );
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/合法 feed/);
    expect(r.message.length).toBeLessThan(300);
    expect(r.message).toMatch(/…/);
  });

  it("RDF（rdf:RDF）空 feed 同样判失败（三种根形态口径一致）", async () => {
    mockFetch(() =>
      feedResponse(
        `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>T</title></channel></rdf:RDF>`,
      ),
    );
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/合法 feed/);
    expect(r.message).toMatch(/没有任何条目/);
  });

  it("Retry-After 为秒数：直接采用", async () => {
    mockFetch(() => new Response("x", { status: 429, headers: { "Retry-After": "120" } }));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/120 秒/);
  });

  it("Retry-After 为 HTTP 日期：换算成剩余秒数", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse("Tue, 29 Sep 2026 12:00:00 GMT")));
    mockFetch(() => new Response("x", { status: 429, headers: { "Retry-After": "Tue, 29 Sep 2026 12:02:30 GMT" } }));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/150 秒/);
  });

  it("Retry-After 是无法识别的值：不显示 NaN，也不假装知道时间", async () => {
    mockFetch(() => new Response("x", { status: 429, headers: { "Retry-After": "sometime soon" } }));
    const r = await connectorRss.testConnection(config());
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/429|限流/);
    expect(r.message).not.toMatch(/NaN/);
    expect(r.message).not.toMatch(/秒后重试/);
  });
});

describe("RSS 连接器 · safeFileName 收紧（应修 5）", () => {
  it("点与空白交替时迭代剥离到不动点", () => {
    expect(safeFileName("..  ..  hidden  ..  ..", "dot-1")).toBe("hidden.md");
    expect(safeFileName(".", "dot-2")).toMatch(/^untitled-/);
    expect(safeFileName("....", "dot-3")).toMatch(/^untitled-/);
  });

  it("Windows 设备名按首段判定（CON.txt 也要避让，CONE 不误伤）", () => {
    expect(safeFileName("CON.txt", "dev-1")).toBe("_CON.txt.md");
    expect(safeFileName("nul", "dev-2")).toBe("_nul.md");
    expect(safeFileName("com10.log", "dev-3")).toBe("com10.log.md");
    expect(safeFileName("CONE", "dev-4")).toBe("CONE.md");
  });

  it("清理 Cf 格式控制符（零宽、方向覆盖、BOM、软连字符）", () => {
    expect(safeFileName("a\u200Bb", "cf-1")).toBe("ab.md");
    expect(safeFileName("\u202Eabc", "cf-2")).toBe("abc.md");
    expect(safeFileName("x\uFEFFy\u00ADz", "cf-3")).toBe("xyz.md");
  });
});

describe("RSS 连接器 · 只读源的不支持语义", () => {
  it("uploadFile 诚实返回 success:false（不假装成功、不发请求）", async () => {
    const r = await connectorRss.uploadFile(config(), "a.md", Buffer.from("hi"));
    expect(r).toEqual({ success: false, path: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("syncFiles 明确抛错拒绝（绝不返回 0/0 假装同步过）", async () => {
    await expect(connectorRss.syncFiles(config(), "/tmp/x")).rejects.toThrow(/只读/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ============================ t14 复核：三处「重复入库」缺陷（先 RED 后修复） ============================

/**
 * M-1：合成 id 的种子含 `String(index)`（数组下标），而注释承诺「跨 sync 可继续去重」。
 * 订阅源每天都在顶部插新条目 → 同一条内容的 id 每次同步都变 → externalId（去重主键）失配
 * → 已入库条目被当新条目再入一遍，知识库出现重复文档。
 *
 * 验收核心：**同一内容条目在 feed 里位置变化后 id 必须不变**；
 * 同时**两条内容完全相同的无 id 条目仍必须得到不同 id**（不能互撞合并）。
 */
describe("RSS 连接器 · 合成 id 必须与条目在 feed 中的位置无关（M-1）", () => {
  /** 只有 <description> 的裸条目：parseFeed 给 id:"" → 连接器必须合成 id */
  const BARE = `<item><description>orphan-body</description></item>`;
  /** 有 guid 的正常条目：id 走真实 guid，不参与合成 */
  const normal = (n: number) =>
    `<item><title>N${n}</title><description>n${n}</description>` +
    `<link>https://m1.example.test/${n}</link><guid>m1-guid-${n}</guid></item>`;
  const wrap = (body: string) =>
    `<rss version="2.0"><channel><title>M1</title>${body}</channel></rss>`;

  /**
   * 在**同一个 feed 地址**上换不同的条目排布并重新解析（feedIdentity 参与种子，
   * 所以只有 url 固定、排布变化时，"位置无关"这条不变量才被测到）。
   * 返回本排布下所有合成 id（`entry-` 前缀），顺序无关。
   */
  async function syntheticIds(url: string, body: string): Promise<string[]> {
    mockFetch(() => feedResponse(wrap(body)));
    clearFeedCacheForTests(); // 同一 url 也要真的重新解析一遍（模拟"下一次同步"）
    const files = await connectorRss.listFiles(config(url));
    return files.map((f) => f.id).filter((id) => id.startsWith("entry-"));
  }

  it("只有 description 的裸条目：其它条目在顶部/中间/底部插入或删除后，它的 id 不变", async () => {
    const url = freshUrl();

    const alone = await syntheticIds(url, BARE);
    const afterOther = await syntheticIds(url, `${normal(1)}${BARE}`); // 正常条目在它上面
    const beforeOther = await syntheticIds(url, `${BARE}${normal(1)}`); // 正常条目在它下面
    const betweenTwo = await syntheticIds(url, `${normal(1)}${BARE}${normal(2)}`); // 夹在中间
    const twoOnTop = await syntheticIds(url, `${normal(2)}${normal(3)}${BARE}`); // 顶部插了两条

    for (const ids of [alone, afterOther, beforeOther, betweenTwo, twoOnTop]) {
      expect(ids).toHaveLength(1);
    }
    // 缺陷现场：这些全都是"同一条内容"，id 必须完全一致
    expect(afterOther).toEqual(alone);
    expect(beforeOther).toEqual(alone);
    expect(betweenTwo).toEqual(alone);
    expect(twoOnTop).toEqual(alone);
  });

  it("缺陷复现：顶部新增一条正常条目后，原裸条目 id 变了（M-1 的实测证据）", async () => {
    const url = freshUrl();
    const before = await syntheticIds(url, BARE);
    const after = await syntheticIds(url, `${normal(9)}${BARE}`);
    // 这条断言在修复前必须为红：种子含 index，before !== after。
    expect(after).toEqual(before);
  });

  it("两条内容完全相同的裸条目：仍得到两个不同 id（互撞合并被禁止）", async () => {
    const url = freshUrl();
    const twins = await syntheticIds(url, `${BARE}${BARE}`);
    expect(twins).toHaveLength(2);
    expect(new Set(twins).size).toBe(2);
  });

  it("同内容双胞胎：插入/删除其它内容的条目后，这一对 id 作为集合仍不变", async () => {
    const url = freshUrl();
    const pair = (await syntheticIds(url, `${BARE}${BARE}`)).slice().sort();
    const withOtherOnTop = (await syntheticIds(url, `${normal(4)}${BARE}${BARE}`)).slice().sort();
    const withOtherBetween = (await syntheticIds(url, `${BARE}${normal(4)}${BARE}`)).slice().sort();
    expect(withOtherOnTop).toEqual(pair);
    expect(withOtherBetween).toEqual(pair);
  });

  it("确定性：同一份输入两次解析得到完全相同的 id 序列（含真实 id 与合成 id 混排）", async () => {
    const url = freshUrl();
    const body = `${normal(1)}${BARE}${normal(2)}${BARE}`;
    const first = await syntheticIds(url, body);
    const second = await syntheticIds(url, body);
    expect(second).toEqual(first);
  });

  it("合成 id 仍被 getContent 命中，且不同 feed 的同内容条目 id 不同（feedIdentity 参与种子）", async () => {
    const a = freshUrl();
    const b = freshUrl();
    const idsA = await syntheticIds(a, BARE);
    const idsB = await syntheticIds(b, BARE);
    expect(idsB).not.toEqual(idsA);

    mockFetch(() => feedResponse(wrap(BARE)));
    clearFeedCacheForTests();
    const files = await connectorRss.listFiles(config(a));
    const md = await connectorRss.getContent!(config(a), files[0]!.id);
    expect(md).not.toBeNull();
    expect(md!.content).toContain("orphan-body");
  });
});

/**
 * N-4：`buildSnapshot` 里 `else if (byId.has(id)) return;` 对**真实 id** 一律"合并丢弃"。
 * 同 guid 重复条目合并是对的；但恶意（或只是古怪）的源站可以把某条 guid 写成
 * 另一条无 guid 条目**的合成 id**，让那条真条目被静默丢掉 —— 少一条内容，且日志里毫无痕迹。
 */
describe("RSS 连接器 · 真实 id 撞上合成 id 不得静默丢弃（N-4）", () => {
  const BARE = `<item><description>collision-victim</description></item>`;
  const wrap = (body: string) => `<rss version="2.0"><channel><title>N4</title>${body}</channel></rss>`;

  it("裸条目在前、guid 恰好写成它的合成 id：两条都必须保留", async () => {
    const url = freshUrl();
    // 第一步：单独解析裸条目，拿到它跨 sync 稳定的合成 id
    mockFetch(() => feedResponse(wrap(BARE)));
    const [only] = await connectorRss.listFiles(config(url));
    const syntheticId = only!.id;
    expect(syntheticId).toMatch(/^entry-[0-9a-z]{8,}$/);

    // 第二步：源站把一条"真条目"的 guid 写成这个合成 id，排在裸条目后面
    const hijack =
      `<item><title>hijacker</title><description>collide-body</description><guid>${syntheticId}</guid></item>`;
    mockFetch(() => feedResponse(wrap(`${BARE}${hijack}`)));
    clearFeedCacheForTests();
    const files = await connectorRss.listFiles(config(url));

    // 缺陷现场（修复前）：files 只剩 1 条 —— 后来那条被 `return` 静默丢掉
    expect(files).toHaveLength(2);
    expect(new Set(files.map((f) => f.id)).size).toBe(2);
    // 两条正文都必须还能取到（id 可用，不是占了坑却查无此人）
    const bodies = await Promise.all(
      files.map((f) => connectorRss.getContent!(config(url), f.id)),
    );
    const text = bodies.map((b) => b?.content ?? "").join("\n");
    expect(text).toContain("collision-victim");
    expect(text).toContain("collide-body");
  });

  it("反方向（真 guid 在前、裸条目在后）同样两条都保留，且顺序无关地互不覆盖", async () => {
    const url = freshUrl();
    mockFetch(() => feedResponse(wrap(BARE)));
    const [only] = await connectorRss.listFiles(config(url));
    const syntheticId = only!.id;

    const hijack =
      `<item><title>hijacker</title><description>collide-body</description><guid>${syntheticId}</guid></item>`;
    mockFetch(() => feedResponse(wrap(`${hijack}${BARE}`)));
    clearFeedCacheForTests();
    const files = await connectorRss.listFiles(config(url));
    expect(files).toHaveLength(2);
    // 先来者（真实 guid）保住原 id，后来者让路 —— 谁都不许消失
    expect(files[0]!.id).toBe(syntheticId);
    expect(files[1]!.id).not.toBe(syntheticId);
  });

  it("同 guid 的真重复条目仍合并为一条（本条修复不许扩大到改 guid 语义）", async () => {
    const url = freshUrl();
    mockFetch(() =>
      feedResponse(
        wrap(
          `<item><title>A</title><description>x</description><guid>same-guid</guid></item>` +
            `<item><title>B</title><description>y</description><guid>same-guid</guid></item>`,
        ),
      ),
    );
    const files = await connectorRss.listFiles(config(url));
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("same-guid");
  });
});

/**
 * N-2：缓存命中时会对快照里的**每一跳**复核 egress；复核一失败就直接抛错。
 * 而缓存的跳链是**上一轮真实走过的地址**：合法源做 CDN 轮换、签名 URL 变更，或那一跳
 * 临时解析失败时，起始地址明明已经能直连（或换了新跳转目标），却被一条已经作废的旧跳
 * 地址判死，最长持续整个 TTL（45s）。修法：复核不过 → 丢弃该缓存项，重新走完整逐跳抓取
 * （全新一次校验，不是放行）。
 */
describe("RSS 连接器 · 缓存复核不过要丢弃重抓，不许硬报错（N-2）", () => {
  const PUBLIC_IP = "93.184.216.34";
  const defaultResolver = async (host: string): Promise<string[]> => {
    const dns = await import("node:dns");
    const records = await dns.promises.lookup(host, { all: true, verbatim: true });
    return records.map((r) => r.address);
  };

  function redirectResponse(location: string, status = 302): Response {
    const res = new Response(null, { status });
    res.headers.set("location", location);
    return res;
  }

  afterEach(() => {
    setResolveHostForTests(defaultResolver);
  });

  it("旧跳地址如今被拦（CDN 轮换）而新链路可直连：重抓成功拿到正文，而不是报错", async () => {
    const base = freshUrl();
    const staleHop = `https://cdn-old${testSeq}.example.test/final.xml`;

    // 第 1 轮：base → 302 → 旧 CDN → feed（快照记下两跳 [base, 旧CDN]）
    // 策略先放行私网：assertEgressAllowed 提前返回，不把 host 写进 egress 自己的 60s passCache，
    // 这样第 2 轮换成"拦私网"时，对旧跳地址才是**真**复核（否则被 passCache 短路，测不到东西）。
    setEgressPolicyForTests(async () => true);
    fetchMock.mockImplementation(async (input) =>
      String(input) === base ? redirectResponse(staleHop) : feedResponse(hnRss2),
    );
    const first = await connectorRss.listFiles(config(base));
    expect(first).toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 第 2 轮：源站换了链路 —— 起始地址直接 200（旧 CDN 那一跳已经不存在）；
    // 同时策略收紧：旧 CDN 的 host 现在解析到内网地址（等价于"这一跳如今会被拦/解析失败"）。
    setEgressPolicyForTests(async () => false);
    setResolveHostForTests(async (host) =>
      host.includes("cdn-old") ? ["10.0.0.5"] : [PUBLIC_IP],
    );
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => feedResponse(hnRss2));

    // 缺陷现场（修复前）：缓存复核对旧跳抛 egress blocked，直接报错，45s 内每次都这样。
    const again = await connectorRss.listFiles(config(base));
    expect(again).toHaveLength(20);
    expect(again.map((f) => f.id)).toEqual(first.map((f) => f.id));
    // 自愈 = 重新完整抓一次，且一个字节都不碰那个已被拦的旧跳地址
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("cdn-old"))).toBe(true);
  });

  it("重抓之后仍逐跳校验：新链路照样跳到被拦地址时必须明确失败（自愈≠放行）", async () => {
    const base = freshUrl();
    const staleHop = `https://cdn-old${testSeq}.example.test/final.xml`;

    setEgressPolicyForTests(async () => true);
    fetchMock.mockImplementation(async (input) =>
      String(input) === base ? redirectResponse(staleHop) : feedResponse(hnRss2),
    );
    await connectorRss.listFiles(config(base));

    // 这一轮起始地址仍然 302 到那个"如今被拦"的地址：丢弃缓存重抓后，
    // 逐跳门禁照旧在第 2 跳前拦住，绝不发出对内网目标的请求。
    setEgressPolicyForTests(async () => false);
    setResolveHostForTests(async (host) => (host.includes("cdn-old") ? ["10.0.0.5"] : [PUBLIC_IP]));
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (input) =>
      String(input) === base ? redirectResponse(staleHop) : feedResponse(hnRss2),
    );

    await expect(connectorRss.listFiles(config(base))).rejects.toThrow(/egress blocked/i);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("10.0.0.5"))).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("cdn-old"))).toBe(false);
  });
});
