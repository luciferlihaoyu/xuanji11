import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, zvecRouter, searchRouter, kbBackupRouter, keywordRouter, relationRouter } from "./router";
import { createContext } from "./context";
import type { AuthInfo } from "./lib/auth";
import { env } from "./lib/env";
import { Paths } from "@contracts/constants";
import { saveUploadedFile, deleteUploadedFile, getFileStream } from "./upload-handler";
import { ingestFile } from "./lib/ingestion";
import { getDb } from "./queries/connection";
import { uploadedFiles, ingestionItems } from "@db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { triggerWebhookWorkflow, startWorkflowScheduler } from "./lib/workflow-scheduler";
import { startBackupScheduler } from "./lib/backup-scheduler";
import { initializeZvec } from "./lib/vector";
import { authenticateLocalRequest } from "./local-auth";
import { createMcpHandler } from "./mcp-server";
import type { User } from "@db/schema";
import "./connectors"; // 注册 115网盘、阿里云盘等连接器

initializeZvec();

declare module "hono" {
  interface ContextVariableMap {
    user: User;
    auth: AuthInfo;
  }
}

const app = new Hono<{ Bindings: HttpBindings }>();
const mcp = createMcpHandler();

// ========== 全局安全响应头中间件 ==========
const securityHeadersMiddleware: MiddlewareHandler<{ Bindings: HttpBindings }> = async (c, next) => {
  await next();

  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname);
  if (env.isProduction && !isLocalhost) {
    c.res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' https:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  c.res.headers.set("Content-Security-Policy", cspDirectives.join("; "));
};

app.use(securityHeadersMiddleware);

const csrfProtectedMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function parsePositiveIntParam(value: string | undefined): number | undefined {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return id;
}

function isCsrfExemptPath(path: string): boolean {
  return (
    path === "/api/mcp" ||
    path === "/api/mcp/sse" ||
    path === "/api/search" ||
    path.startsWith("/api/zvec/") ||
    path.startsWith("/api/kb/") ||
    path.startsWith("/api/keywords/") ||
    path.startsWith("/api/relations/") ||
    /^\/api\/workflows\/[^/]+\/webhook$/.test(path)
  );
}

const csrfMiddleware: MiddlewareHandler<{ Bindings: HttpBindings }> = async (c, next) => {
  if (
    csrfProtectedMethods.has(c.req.method) &&
    !isCsrfExemptPath(c.req.path) &&
    c.req.header("X-Requested-With") !== "XMLHttpRequest"
  ) {
    return c.json({ success: false, error: "Invalid request" }, 403);
  }

  return next();
};

// 文件上传路由（50MB 限制）
app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// Kimi OAuth callback（可选）
if (env.appId && env.appSecret) {
  const { createOAuthCallbackHandler } = await import("./kimi/auth");
  app.get(Paths.oauthCallback, createOAuthCallbackHandler());
}

// ========== JWT 认证中间件 ==========
const authMiddleware: MiddlewareHandler<{ Bindings: HttpBindings }> = async (c, next) => {
  const path = c.req.path;

  // 放行公开路由
  if (
    path === "/health" ||
    path === "/api/mcp" ||
    path === "/api/mcp/sse" ||
    path === "/api/search" ||
    path.startsWith("/api/zvec/") ||
    path.startsWith("/api/kb/") ||
    path.startsWith("/api/keywords/") ||
    path.startsWith("/api/relations/") ||
    path.startsWith("/api/trpc/") ||
    path === Paths.oauthCallback
  ) {
    return next();
  }

  const user = await authenticateLocalRequest(c.req.raw.headers);
  if (!user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }

  c.set("user", user);
  return next();
};

// 注册认证中间件到所有 /api/* 路由
app.use("/api/*", csrfMiddleware);
app.use("/api/*", authMiddleware);

// MCP endpoint for AI agent access
app.post("/api/mcp", async (c) => {
  const body = await c.req.json();
  const result = await mcp.handleMcpRequest(body, c.req.raw.headers);
  return c.json(result);
});

// SSE endpoint for remote MCP clients
app.get("/api/mcp/sse", (c) => {
  return mcp.createMcpSseResponse(c.req.raw.headers);
});

// ZVec REST API
app.route("/api/zvec", zvecRouter);

// Hybrid search REST API
app.route("/api/search", searchRouter);

// Knowledge base backup REST API
app.route("/api/kb", kbBackupRouter);

// Keyword extraction REST API
app.route("/api/keywords", keywordRouter);

// Relation discovery REST API
app.route("/api/relations", relationRouter);

// ========== 认证状态路由 ==========
app.get("/api/auth/me", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }
  return c.json({ success: true, user });
});

// ========== 文件上传 API ==========

// 上传文件（multipart/form-data）
app.post("/api/upload", async (c) => {
  try {
    const user = c.get("user");
    if (!user) {
      return c.json({ success: false, error: "Authentication required" }, 401);
    }

    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];

    if (!files || files.length === 0) {
      return c.json({ success: false, error: "未选择文件" }, 400);
    }

    const results = [];
    const ingestionErrors: { file: string; error: string }[] = [];

    for (const file of files) {
      if (!(file instanceof File)) continue;
      let result;
      try {
        result = await saveUploadedFile(file, user.id);
      } catch (err) {
        console.error("[Upload] saveUploadedFile failed:", err);
        return c.json(
          {
            success: false,
            error: "上传失败",
          },
          500,
        );
      }
      results.push(result);

      try {
        await ingestFile({
          sourceType: "upload",
          fileName: result.originalName,
          mimeType: result.mimeType,
          size: result.size,
          storagePath: result.storagePath,
          uploadedFileId: result.id,
        });
      } catch (err) {
        console.error("[Upload] Ingestion failed:", err);
        ingestionErrors.push({ file: result.originalName, error: "文件入库失败" });
      }
    }

    return c.json({
      success: true,
      files: results,
      count: results.length,
      ingestionErrors: ingestionErrors.length > 0 ? ingestionErrors : undefined,
    });
  } catch (err) {
    console.error("[Upload] Error:", err);
    return c.json(
      {
        success: false,
        error: "上传失败",
      },
      500,
    );
  }
});

// 获取文件列表
app.get("/api/upload/list", async (c) => {
  try {
    const user = c.get("user");
    if (!user) {
      return c.json({ success: false, error: "Authentication required" }, 401);
    }

    const db = getDb();
    const query = db
      .select()
      .from(uploadedFiles)
      .orderBy(desc(uploadedFiles.createdAt));

    // 非管理员只看到自己的文件
    const files = user.role === "admin"
      ? await query
      : await query.where(eq(uploadedFiles.uploadedBy, user.id));

    return c.json({ success: true, files });
  } catch (err) {
    console.error("[UploadList] Error:", err);
    return c.json(
      {
        success: false,
        error: "获取文件列表失败",
      },
      500,
    );
  }
});

// 删除上传的文件
app.delete("/api/upload/:id", async (c) => {
  try {
    const user = c.get("user");
    if (!user) {
      return c.json({ success: false, error: "Authentication required" }, 401);
    }

    const id = parsePositiveIntParam(c.req.param("id"));
    if (id === undefined) return c.json({ success: false, error: "无效的文件ID" }, 400);

    // 非管理员只能删除自己的文件
    if (user.role !== "admin") {
      const db = getDb();
      const rows = await db
        .select()
        .from(uploadedFiles)
        .where(eq(uploadedFiles.id, id));
      if (rows.length === 0 || rows[0].uploadedBy !== user.id) {
        return c.json({ success: false, error: "无权限删除此文件" }, 403);
      }
    }

    const success = await deleteUploadedFile(id);
    return c.json({ success });
  } catch (err) {
    console.error("[UploadDelete] Error:", err);
    return c.json(
      {
        success: false,
        error: "删除失败",
      },
      500,
    );
  }
});

// 下载上传的文件
app.get("/api/files/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: "无效的文件ID" }, 400);
  }

  const fileInfo = await getFileStream(id);
  if (!fileInfo) return c.json({ success: false, error: "文件不存在" }, 404);

  if (user.role !== "admin" && fileInfo.file.uploadedBy !== user.id) {
    return c.json({ success: false, error: "无权限下载此文件" }, 403);
  }

  const mimeType = fileInfo.file.mimeType || "application/octet-stream";
  c.header("Content-Type", mimeType);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.file.originalName)}`);
  // 使用 Bun 或 Node 的流式响应
  return new Response(fileInfo.stream as unknown as ReadableStream);
});

app.get("/api/upload/:id/ingestion", async (c) => {
  try {
    const user = c.get("user");
    if (!user) {
      return c.json({ success: false, error: "Authentication required" }, 401);
    }

    const id = parsePositiveIntParam(c.req.param("id"));
    if (id === undefined) return c.json({ success: false, error: "无效的文件ID" }, 400);

    const db = getDb();
    const items = await db
      .select()
      .from(ingestionItems)
      .where(
        sql`JSON_UNQUOTE(JSON_EXTRACT(${ingestionItems.metadata}, '$.uploadedFileId')) = ${String(id)}`,
      )
      .orderBy(desc(ingestionItems.createdAt));
    return c.json({ success: true, items });
  } catch (err) {
    console.error("[UploadIngestion] Error:", err);
    return c.json(
      {
        success: false,
        error: "查询失败",
      },
      500,
    );
  }
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

app.post("/api/workflows/:id/webhook", async (c) => {
  try {
    const user = c.get("user");
    if (!user) {
      return c.json({ success: false, error: "Authentication required" }, 401);
    }

    const id = parsePositiveIntParam(c.req.param("id"));
    if (id === undefined) return c.json({ success: false, error: "无效的工作流 ID" }, 400);

    const payload = await c.req.json().catch(() => ({}));
    const result = await triggerWebhookWorkflow(id, payload);

    if ("error" in result) {
      console.error("[Webhook] Trigger failed:", result.error);
      return c.json({ success: false, error: "Webhook 触发失败" }, 400);
    }

    return c.json({ success: true, runId: result.runId });
  } catch (err) {
    console.error("[Webhook] Error:", err);
    return c.json(
      {
        success: false,
        error: "Webhook 触发失败",
      },
      500,
    );
  }
});

// ========== 健康检查 ==========
const startTime = Date.now();
app.get("/health", (c) => {
  try {
    getDb();
    return c.json({ ok: true, uptime: Math.floor((Date.now() - startTime) / 1000), dbConnected: true });
  } catch (err) {
    console.error("[Health] Error:", err);
    return c.json({ ok: true, uptime: Math.floor((Date.now() - startTime) / 1000), dbConnected: false }, 503);
  }
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app as unknown as Parameters<typeof serveStaticFiles>[0]);

  const port = parseInt(process.env.PORT || "3000");
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`璇玑智脑 running on http://localhost:${port}/`);
  });

  const stopScheduler = startWorkflowScheduler();
  const stopBackupScheduler = startBackupScheduler();

  // 优雅关闭
  const shutdown = (signal: string) => {
    console.log(`\n收到 ${signal}，正在优雅关闭...`);
    stopScheduler();
    stopBackupScheduler();
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
