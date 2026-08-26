import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-characters-long!!";
});

// 放行 egress 让连接器测试可以走到 fetch mock 阶段
import { setEgressPolicyForTests } from "../lib/egress";
setEgressPolicyForTests(async () => true);

import { connectorAlist } from "./alist";

const BASE_CONFIG = {
  url: "https://alist.example.com",
  username: "alice",
  password: "secret",
  basePath: "/115/璇玑",
};

/** 每个 it 用唯一 username，避免模块级 token 缓存跨测试污染。 */
let testSeq = 0;
function freshConfig(overrides: Record<string, unknown> = {}): typeof BASE_CONFIG {
  testSeq += 1;
  return { ...BASE_CONFIG, username: `${BASE_CONFIG.username}-${testSeq}`, ...overrides };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200 });
}

describe("AList 连接器", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("testConnection", () => {
    it("登录成功 + 列目录有数据时返回成功", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { token: "T1" } }))
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { content: [{ name: "a.txt", size: 10 }] } }));
      const r = await connectorAlist.testConnection(freshConfig());
      expect(r.success).toBe(true);
      expect(r.message).toMatch(/连接成功/);
    });

    it("登录 HTTP 错误时返回失败", async () => {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
      const r = await connectorAlist.testConnection(freshConfig());
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/HTTP 401/);
    });

    it("登录返回 200 但 code 非 200 时返回失败", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ code: 500, message: "creds wrong" }));
      const r = await connectorAlist.testConnection(freshConfig());
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/creds wrong/);
    });

    it("配置缺字段时返回配置不完整", async () => {
      const r = await connectorAlist.testConnection({ url: "https://x" });
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/配置不完整/);
    });

    it("url 非 http/https 时拒绝", async () => {
      const r = await connectorAlist.testConnection(freshConfig({ url: "ftp://x" }));
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/配置不完整/);
    });
  });

  describe("listFiles", () => {
    it("把工作目录作为顶级返回", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { token: "T" } }))
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { content: [
          { name: "a.md", size: 10, is_dir: false, modified: "2025-01-01T00:00:00Z" },
          { name: "sub", is_dir: true },
        ] } }));
      const r = await connectorAlist.listFiles(freshConfig(), "/");
      expect(r).toHaveLength(2);
      expect(r[0].id).toBe("/115/璇玑/a.md");
      expect(r[0].type).toBe("file");
      expect(r[0].modifiedAt).toBeInstanceOf(Date);
      expect(r[1].type).toBe("folder");
      expect(r[1].modifiedAt).toBeUndefined();
    });

    it("缺配置时返回空数组", async () => {
      expect(await connectorAlist.listFiles({})).toEqual([]);
    });
  });

  describe("getDownloadUrl", () => {
    it("从 raw_url 字段透传", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { token: "T" } }))
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { raw_url: "https://cdn.example/x" } }));
      const url = await connectorAlist.getDownloadUrl(freshConfig(), "/115/璇玑/a.md");
      expect(url).toBe("https://cdn.example/x");
    });

    it("get 接口非 200 时返回 null", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { token: "T" } }))
        .mockResolvedValueOnce(new Response("nope", { status: 500 }));
      expect(await connectorAlist.getDownloadUrl(freshConfig(), "/x")).toBeNull();
    });
  });

  describe("uploadFile", () => {
    it("PUT 成功且 code=200 时返回 success", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { token: "T" } }))
        .mockResolvedValueOnce(jsonResponse({ code: 200 }));
      const r = await connectorAlist.uploadFile(freshConfig(), "a.md", Buffer.from("hi"));
      expect(r.success).toBe(true);
      expect(r.path).toBe("/115/璇玑/a.md");
      const putCall = fetchMock.mock.calls[1];
      expect(putCall?.[0]).toMatch(/\/api\/fs\/put/);
      const headers = (putCall?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers["File-Path"]).toBe(encodeURIComponent("/115/璇玑/a.md"));
    });

    it("上传路径含 '..' 时直接抛错（防穿越）", async () => {
      await expect(connectorAlist.uploadFile(freshConfig(), "../etc/passwd", Buffer.from("x")))
        .rejects.toThrow(/Invalid upload path/);
    });

    it("HTTP 失败时抛错", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ code: 200, data: { token: "T" } }))
        .mockResolvedValueOnce(new Response("nope", { status: 500 }));
      await expect(connectorAlist.uploadFile(freshConfig(), "a", Buffer.from("x"))).rejects.toThrow(/HTTP 500/);
    });
  });
});
