import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createCsrfMiddleware } from "./csrf-middleware";

function buildApp() {
  const app = new Hono();
  // 模拟下游：放行的请求会被处理并返回 200
  app.use("/api/*", createCsrfMiddleware());
  app.post("/api/anything", (c) => c.json({ ok: true }));
  app.put("/api/anything", (c) => c.json({ ok: true }));
  app.delete("/api/anything", (c) => c.json({ ok: true }));
  app.patch("/api/anything", (c) => c.json({ ok: true }));
  app.get("/api/anything", (c) => c.json({ ok: true }));
  // 内部 REST 前缀
  app.post("/api/zvec/collections", (c) => c.json({ ok: true }));
  app.post("/api/kb/folders", (c) => c.json({ ok: true }));
  app.post("/api/search/query", (c) => c.json({ ok: true }));
  // 完全豁免
  app.post("/api/mcp", (c) => c.json({ ok: true }));
  app.post("/api/workflows/123/webhook", (c) => c.json({ ok: true }));
  return app;
}

describe("csrfMiddleware 端到端", () => {
  it("GET 请求不受 CSRF 校验（无论 header）", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/anything", { method: "GET" }));
    expect(res.status).toBe(200);
  });

  it("POST 带 X-Requested-With=XMLHttpRequest 通过", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/anything", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    }));
    expect(res.status).toBe(200);
  });

  it("POST 同源 Origin 通过", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/anything", {
      method: "POST",
      headers: { "Origin": "http://x" },
    }));
    expect(res.status).toBe(200);
  });

  it("POST 跨域 Origin 无 XRW 返回 403", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/anything", {
      method: "POST",
      headers: { "Origin": "http://evil.com" },
    }));
    expect(res.status).toBe(403);
  });

  it("POST 无任何可信头时返回 403", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://x/api/anything", { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("PUT/PATCH/DELETE 同样需要 CSRF 校验", async () => {
    const app = buildApp();
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const r = await app.fetch(new Request("http://x/api/anything", { method }));
      expect(r.status).toBe(403);
    }
  });

  it("内部 REST POST 带 XRW 通过", async () => {
    const app = buildApp();
    const r = await app.fetch(new Request("http://x/api/zvec/collections", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    }));
    expect(r.status).toBe(200);
  });

  it("内部 REST POST 无 XRW 仍被 403（防止 cookie CSRF）", async () => {
    const app = buildApp();
    const r = await app.fetch(new Request("http://x/api/kb/folders", {
      method: "POST",
      headers: { "Origin": "http://evil.com" },
    }));
    expect(r.status).toBe(403);
  });

  it("完全豁免路径 /api/mcp 任意 header 都通过", async () => {
    const app = buildApp();
    const r = await app.fetch(new Request("http://x/api/mcp", {
      method: "POST",
      headers: { "Origin": "http://evil.com" },
    }));
    expect(r.status).toBe(200);
  });

  it("完全豁免路径 /api/workflows/:id/webhook 任意 header 都通过", async () => {
    const app = buildApp();
    const r = await app.fetch(new Request("http://x/api/workflows/123/webhook", {
      method: "POST",
      headers: { "Origin": "http://evil.com" },
    }));
    expect(r.status).toBe(200);
  });
});
