import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alistRepository } from "./alist";

const MULTISTATUS_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>https://alist.example.com/dav/</D:href>
    <D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>https://alist.example.com/dav/docs/</D:href>
    <D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>https://alist.example.com/dav/my%20file.txt</D:href>
    <D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>https://alist.example.com/dav/a&amp;b.json</D:href>
    <D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { url: "https://alist.example.com/dav", username: "user", password: "secret", ...overrides };
}

function response(body: string, status: number): Response {
  return new Response(status === 204 ? null : body, {
    status,
    headers: { "Content-Type": "text/xml" },
  });
}

describe("alist WebDAV repository", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("testConnection succeeds on PROPFIND 207 with Basic auth", async () => {
    fetchMock.mockResolvedValue(response(MULTISTATUS_XML, 207));
    const result = await alistRepository.testConnection(config());
    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://alist.example.com/dav/");
    expect(init.method).toBe("PROPFIND");
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("user:secret").toString("base64")}`,
    });
    expect((init.headers as Record<string, string>)["Depth"]).toBe("0");
  });

  it("testConnection reports failure with non-207 without leaking credentials", async () => {
    fetchMock.mockResolvedValue(response("<error/>", 401));
    const result = await alistRepository.testConnection(config());
    expect(result.success).toBe(false);
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("user");
  });

  it("testConnection fails when the url is invalid or not http(s)", async () => {
    const result = await alistRepository.testConnection(config({ url: "ftp://alist.example.com/dav" }));
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploadFile PUTs to the normalized url with Basic auth", async () => {
    fetchMock.mockResolvedValue(response("", 201));
    await alistRepository.uploadFile(config({ url: "https://alist.example.com/dav/" }), "sub/dir/file.txt", Buffer.from("data"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://alist.example.com/dav/sub/dir/file.txt");
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("user:secret").toString("base64")}`,
    });
    expect(init.body).toEqual(new Uint8Array(Buffer.from("data")));
  });

  it("uploadFile rejects on non-2xx with a status code, message without credentials", async () => {
    fetchMock.mockResolvedValue(response("denied", 401));
    await expect(
      alistRepository.uploadFile(config(), "file.txt", Buffer.from("data"))
    ).rejects.toMatchObject({ statusCode: 401 });
    const caught = await alistRepository.uploadFile(config(), "file.txt", Buffer.from("data")).then(
      () => null,
      (e: unknown) => e
    );
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain("secret");
  });

  it("readFile returns the body on 200 and null on 404", async () => {
    fetchMock.mockResolvedValueOnce(response("file-content", 200));
    const content = await alistRepository.readFile(config(), "dir/file.txt");
    expect(content?.toString()).toBe("file-content");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://alist.example.com/dav/dir/file.txt");
    expect(init.method).toBe("GET");

    fetchMock.mockResolvedValueOnce(response("", 404));
    expect(await alistRepository.readFile(config(), "missing.txt")).toBeNull();
  });

  it("deleteFile issues DELETE and tolerates 204", async () => {
    fetchMock.mockResolvedValue(response("", 204));
    await alistRepository.deleteFile(config(), "old/file.txt");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://alist.example.com/dav/old/file.txt");
    expect(init.method).toBe("DELETE");
  });

  it("listFiles parses multistatus hrefs, decodes them and filters directories", async () => {
    fetchMock.mockResolvedValue(response(MULTISTATUS_XML, 207));
    const files = await alistRepository.listFiles(config());
    expect(files.sort()).toEqual(["a&b.json", "my file.txt"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://alist.example.com/dav/");
    expect((init.headers as Record<string, string>)["Depth"]).toBe("1");
  });

  it("listFiles rejects on non-207", async () => {
    fetchMock.mockResolvedValue(response("", 500));
    await expect(alistRepository.listFiles(config())).rejects.toMatchObject({ statusCode: 500 });
  });

  it("rejects config without username or password", async () => {
    fetchMock.mockResolvedValue(response(MULTISTATUS_XML, 207));
    const result = await alistRepository.testConnection(config({ username: "" }));
    expect(result.success).toBe(false);
  });

  it("sends an AbortSignal timeout on every request", async () => {
    fetchMock.mockResolvedValue(response("", 201));
    await alistRepository.uploadFile(config(), "f.txt", Buffer.from("x"));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses paths that escape the base directory", async () => {
    await expect(alistRepository.uploadFile(config(), "../escape.txt", Buffer.from("x"))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
