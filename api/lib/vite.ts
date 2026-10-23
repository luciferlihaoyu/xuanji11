import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");

  // 入口 HTML 必须每次回源校验，否则浏览器会启发式缓存旧 index.html，
  // 导致部署新版本后用户仍拿到引用旧资源哈希的页面（表现为白屏或资源 404）。
  // /assets 下的文件名带内容哈希，可长期缓存，故只对 .html 加此头。
  // 与天宫 api/lib/vite.ts、北斗 backend/app/main.py 的口径保持一致。
  app.use(
    "*",
    serveStatic({
      root: "./dist/public",
      onFound: (filepath: string, c) => {
        if (filepath.endsWith(".html")) {
          c.header("Cache-Control", "no-cache");
        }
      },
    }),
  );

  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(distPath, "index.html");
    const content = fs.readFileSync(indexPath, "utf-8");
    // SPA 回退同样不能被缓存，否则换版本后仍会拿到旧入口页
    return c.html(content, 200, { "Cache-Control": "no-cache" });
  });
}
