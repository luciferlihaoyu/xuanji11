import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alistRepository } from "./alist";

let seq = 0;

/** 每个用例独立用户名，避免模块级 token 缓存跨用例复用导致 login 请求缺失 */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return { url: "https://alist.example.com", username: `user${seq}`, password: "secret", ...overrides };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function loginOk() {
  return json({ code: 200, message: "success", data: { token: "tok-abc" } });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, marker: string): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit][]).filter(([u]) => u.includes(marker));
}

/** 默认路由 mock：login 成功，其余按 overrides 处理 */
function routeFetch(fetchMock: ReturnType<typeof vi.fn>, overrides: Record<string, (init: RequestInit) => Response> = {}) {
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    for (const [marker, handler] of Object.entries(overrides)) {
      if (url.includes(marker)) return Promise.resolve(handler(init));
    }
    if (url.includes("/api/auth/login")) return Promise.resolve(loginOk());
    if (url.includes("/api/fs/list")) return Promise.resolve(json({ code: 200, message: "success", data: { content: [] } }));
    return Promise.resolve(json({ code: 200, message: "success", data: {} }));
  });
}

describe("alist REST backup repository", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("testConnection logs in via REST and lists the base path", async () => {
    routeFetch(fetchMock, {
      "/api/fs/list": () =>
        json({ code: 200, message: "success", data: { content: [{ name: "a", is_dir: false }, { name: "b", is_dir: true }] } }),
    });
    const result = await alistRepository.testConnection(config());
    expect(result.success).toBe(true);
    expect(result.message).toContain("2 个条目");
    const [loginUrl, loginInit] = callsTo(fetchMock, "/api/auth/login")[0];
    expect(loginUrl).toBe("https://alist.example.com/api/auth/login");
    expect(loginInit.method).toBe("POST");
    expect(JSON.parse(String(loginInit.body))).toMatchObject({ password: "secret" });
    const [listUrl, listInit] = callsTo(fetchMock, "/api/fs/list")[0];
    expect(listUrl).toBe("https://alist.example.com/api/fs/list");
    expect(JSON.parse(String(listInit.body))).toMatchObject({ path: "/" });
    expect((listInit.headers as Record<string, string>)["Authorization"]).toBe("tok-abc");
  });

  it("testConnection reports AList server message without leaking credentials", async () => {
    routeFetch(fetchMock, { "/api/fs/list": () => json({ code: 403, message: "permission denied" }) });
    const result = await alistRepository.testConnection(config());
    expect(result.success).toBe(false);
    expect(result.message).toContain("permission denied");
    expect(result.message).not.toContain("secret");
  });

  it("testConnection fails when the url is invalid or not http(s)", async () => {
    const result = await alistRepository.testConnection(config({ url: "ftp://alist.example.com" }));
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the url subpath as backup base path", async () => {
    routeFetch(fetchMock);
    await alistRepository.listFiles(config({ url: "https://alist.example.com/115/%E7%92%87%E7%8E%91" }));
    const [, listInit] = callsTo(fetchMock, "/api/fs/list")[0];
    expect(JSON.parse(String(listInit.body))).toMatchObject({ path: "/115/璇玑" });
  });

  it("accepts legacy /dav urls by stripping the dav prefix", async () => {
    routeFetch(fetchMock);
    await alistRepository.listFiles(config({ url: "https://alist.example.com/dav/115/%E7%92%87%E7%8E%91" }));
    const [listUrl, listInit] = callsTo(fetchMock, "/api/fs/list")[0];
    expect(listUrl).toBe("https://alist.example.com/api/fs/list");
    expect(JSON.parse(String(listInit.body))).toMatchObject({ path: "/115/璇玑" });
  });

  it("uploadFile PUTs to /api/fs/put with encoded File-Path under the base path", async () => {
    routeFetch(fetchMock);
    await alistRepository.uploadFile(config({ url: "https://alist.example.com/dav/backups" }), "sub/dir/file.txt", Buffer.from("data"));
    const [putUrl, putInit] = callsTo(fetchMock, "/api/fs/put")[0];
    expect(putUrl).toBe("https://alist.example.com/api/fs/put");
    expect(putInit.method).toBe("PUT");
    const headers = putInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("tok-abc");
    expect(decodeURIComponent(headers["File-Path"])).toBe("/backups/sub/dir/file.txt");
    expect(putInit.body).toEqual(new Uint8Array(Buffer.from("data")));
  });

  it("uploadFile surfaces server error message without credentials", async () => {
    routeFetch(fetchMock, { "/api/fs/put": () => json({ code: 500, message: "permission denied" }) });
    const caught = await alistRepository.uploadFile(config(), "file.txt", Buffer.from("data")).then(
      () => null,
      (e: unknown) => e
    );
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("permission denied");
    expect(message).not.toContain("secret");
  });

  it("readFile resolves raw_url then downloads; returns null when not found", async () => {
    routeFetch(fetchMock, {
      "/api/fs/get": () => json({ code: 200, message: "success", data: { raw_url: "https://cdn.example.com/f" } }),
      "cdn.example.com": () => new Response("file-content", { status: 200 }),
    });
    const content = await alistRepository.readFile(config(), "dir/file.txt");
    expect(content?.toString()).toBe("file-content");
    const [, getInit] = callsTo(fetchMock, "/api/fs/get")[0];
    expect(JSON.parse(String(getInit.body))).toMatchObject({ path: "/dir/file.txt" });

    routeFetch(fetchMock, { "/api/fs/get": () => json({ code: 500, message: "object not found" }) });
    expect(await alistRepository.readFile(config(), "missing.txt")).toBeNull();
  });

  it("deleteFile removes by dir+name and tolerates not-found", async () => {
    routeFetch(fetchMock);
    await alistRepository.deleteFile(config({ url: "https://alist.example.com/backups" }), "old/file.txt");
    const [, rmInit] = callsTo(fetchMock, "/api/fs/remove")[0];
    expect(JSON.parse(String(rmInit.body))).toEqual({ dir: "/backups/old", names: ["file.txt"] });

    routeFetch(fetchMock, { "/api/fs/remove": () => json({ code: 500, message: "object not found" }) });
    await expect(alistRepository.deleteFile(config(), "old/file.txt")).resolves.toBeUndefined();
  });

  it("listFiles returns only files, prefixed when listing a subdirectory", async () => {
    routeFetch(fetchMock, {
      "/api/fs/list": () =>
        json({
          code: 200,
          message: "success",
          data: {
            content: [
              { name: "a.txt", is_dir: false },
              { name: "subdir", is_dir: true },
              { name: "b.json", is_dir: false },
            ],
          },
        }),
    });
    const files = await alistRepository.listFiles(config(), "docs");
    expect(files.sort()).toEqual(["docs/a.txt", "docs/b.json"]);
    const [, listInit] = callsTo(fetchMock, "/api/fs/list")[0];
    expect(JSON.parse(String(listInit.body))).toMatchObject({ path: "/docs" });
  });

  it("ensureBasePath creates missing directories recursively", async () => {
    const made: string[] = [];
    routeFetch(fetchMock, {
      "/api/fs/list": (init) => {
        const path = JSON.parse(String(init.body)).path as string;
        if (path === "/backups") return json({ code: 500, message: "object not found" });
        if (path === "/backups/xj") return json({ code: 500, message: "object not found" });
        return json({ code: 200, message: "success", data: { content: [] } });
      },
      "/api/fs/mkdir": (init) => {
        made.push(JSON.parse(String(init.body)).path as string);
        return json({ code: 200, message: "success" });
      },
    });
    await alistRepository.ensureBasePath(config({ url: "https://alist.example.com/backups/xj" }));
    expect(made).toEqual(["/backups", "/backups/xj"]);
  });

  it("testConnection auto-creates a missing backup directory", async () => {
    const made: string[] = [];
    routeFetch(fetchMock, {
      "/api/fs/list": (init) => {
        const path = JSON.parse(String(init.body)).path as string;
        if (path === "/115/璇玑" && made.length === 0) return json({ code: 500, message: "object not found" });
        return json({ code: 200, message: "success", data: { content: [] } });
      },
      "/api/fs/mkdir": (init) => {
        made.push(JSON.parse(String(init.body)).path as string);
        return json({ code: 200, message: "success" });
      },
    });
    const result = await alistRepository.testConnection(config({ url: "https://alist.example.com/115/%E7%92%87%E7%8E%91" }));
    expect(result.success).toBe(true);
    expect(result.message).toContain("已自动创建");
    expect(made).toContain("/115/璇玑");
  });

  it("uploadFile creates missing parent directories before putting", async () => {
    const made: string[] = [];
    routeFetch(fetchMock, {
      "/api/fs/list": (init) => {
        const path = JSON.parse(String(init.body)).path as string;
        if (path.startsWith("/backups/sub")) return json({ code: 500, message: "object not found" });
        return json({ code: 200, message: "success", data: { content: [] } });
      },
      "/api/fs/mkdir": (init) => {
        made.push(JSON.parse(String(init.body)).path as string);
        return json({ code: 200, message: "success" });
      },
    });
    await alistRepository.uploadFile(config({ url: "https://alist.example.com/backups" }), "sub/dir/f.txt", Buffer.from("x"));
    expect(made).toEqual(["/backups/sub", "/backups/sub/dir"]);
    expect(callsTo(fetchMock, "/api/fs/put")).toHaveLength(1);
  });

  it("sends an AbortSignal timeout on every request", async () => {
    routeFetch(fetchMock);
    await alistRepository.uploadFile(config(), "f.txt", Buffer.from("x"));
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("refuses paths that escape the base directory", async () => {
    routeFetch(fetchMock);
    await expect(alistRepository.uploadFile(config(), "../escape.txt", Buffer.from("x"))).rejects.toThrow();
    expect(callsTo(fetchMock, "/api/fs/put")).toHaveLength(0);
  });
});
