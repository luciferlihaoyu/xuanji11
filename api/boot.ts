import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { Paths } from "@contracts/constants";
import { saveUploadedFile, deleteUploadedFile, getFileStream } from "./upload-handler";
import { getDb } from "./queries/connection";
import "./connectors"; // 注册 115网盘、阿里云盘等连接器

const app = new Hono<{ Bindings: HttpBindings }>();

// 文件上传路由（50MB 限制）
app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// Kimi OAuth callback（可选）
if (env.appId && env.appSecret) {
  const { createOAuthCallbackHandler } = await import("./kimi/auth");
  app.get(Paths.oauthCallback, createOAuthCallbackHandler());
}

// ========== 文件上传 API ==========

// 上传文件（multipart/form-data）
app.post("/api/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];

    if (!files || files.length === 0) {
      return c.json({ error: "未选择文件" }, 400);
    }

    const results = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      const result = await saveUploadedFile(file);
      results.push(result);
    }

    return c.json({
      success: true,
      files: results,
      count: results.length,
    });
  } catch (err) {
    console.error("[Upload] Error:", err);
    return c.json({ error: "上传失败: " + (err instanceof Error ? err.message : String(err)) }, 500);
  }
});

// 获取文件列表
app.get("/api/upload/list", async (c) => {
  try {
    const { getDb } = await import("./queries/connection");
    const { uploadedFiles } = await import("@db/schema");
    const { desc } = await import("drizzle-orm");
    const db = getDb();
    const files = await db.select().from(uploadedFiles).orderBy(desc(uploadedFiles.createdAt));
    return c.json({ success: true, files });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// 删除上传的文件
app.delete("/api/upload/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "无效的文件ID" }, 400);
    const success = await deleteUploadedFile(id);
    return c.json({ success });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// 下载/查看上传的文件
app.get("/api/files/:filename", async (c) => {
  const filename = c.req.param("filename");
  const fileInfo = getFileStream(filename);
  if (!fileInfo) return c.json({ error: "文件不存在" }, 404);

  c.header("Content-Type", fileInfo.mimeType);
  // 使用 Bun 或 Node 的流式响应
  return new Response(fileInfo.stream as unknown as ReadableStream);
});

// ========== tRPC API ==========
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});

// ========== 健康检查 ==========
const startTime = Date.now();
app.get("/health", (c) => {
  try {
    const db = getDb();
    return c.json({ ok: true, uptime: Math.floor((Date.now() - startTime) / 1000), dbConnected: true });
  } catch {
    return c.json({ ok: true, uptime: Math.floor((Date.now() - startTime) / 1000), dbConnected: false }, 503);
  }
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`璇玑智脑 running on http://localhost:${port}/`);
  });

  // 优雅关闭
  const shutdown = (signal: string) => {
    console.log(`\n收到 ${signal}，正在优雅关闭...`);
    server.close(() => {
      console.log("HTTP 服务已关闭");
      process.exit(0);
    });
    // 5 秒后强制退出
    setTimeout(() => {
      console.error("强制退出");
      process.exit(1);
    }, 5000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
