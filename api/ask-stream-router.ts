/**
 * 引用式问答 SSE 流式端点：GET /stream?query=...&history=[...]
 * 事件序列：citations → token×N → done / error
 * 浏览器 EventSource 同源自动带 cookie，走与 search 相同的认证。
 */
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { searchAuthMiddleware } from "./search-router";

export const askStreamRouter = new Hono();
askStreamRouter.use(searchAuthMiddleware);

const historyItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
});

askStreamRouter.get("/stream", async (c) => {
  const query = c.req.query("query")?.trim();
  if (!query || query.length < 2) {
    return c.json({ error: "query required" }, 400);
  }
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const rawHistory = c.req.query("history");
  if (rawHistory) {
    try {
      history = z.array(historyItemSchema).max(12).parse(JSON.parse(rawHistory));
    } catch {
      return c.json({ error: "invalid history" }, 400);
    }
  }

  return stream(c, async (s) => {
    const send = async (event: string, data: unknown) => {
      await s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const { askKnowledgeBase } = await import("./lib/ask-rag");
      const result = await askKnowledgeBase(query, history, (token) => {
        void s.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      });
      await send("result", {
        citations: result.citations,
        insufficient: result.insufficient,
        evidenceCount: result.evidenceCount,
        model: result.model,
        answer: result.answer,
      });
    } catch (err) {
      await send("error", { message: err instanceof Error ? err.message : "ask failed" });
    }
  });
});
