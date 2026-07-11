import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey, hasScope, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { extractInputSchema, extractKeywords } from "./lib/keyword-extractor";
import { autoTagInputSchema, autoTagDocument } from "./lib/keyword-auto-tag";

declare module "hono" {
  interface ContextVariableMap {
    user: User;
    auth: AuthInfo;
  }
}

const keywordAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const apiKeyIdentity = await authenticateApiKey(c.req.raw.headers);
  if (apiKeyIdentity) {
    c.set("user", apiKeyIdentity.user);
    c.set("auth", apiKeyIdentity.auth);
    return next();
  }

  const user = await authenticateLocalRequest(c.req.raw.headers);
  if (user) {
    c.set("user", user);
    c.set("auth", sessionAuth(user));
    return next();
  }

  return c.json({ error: "Authentication required" }, 401);
};

function requireKeywordScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!hasScope(auth, scope)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}

export const keywordRouter = new Hono();

keywordRouter.use(keywordAuthMiddleware);

keywordRouter.onError((err, c) => {
  console.error("[Keyword] Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

keywordRouter.post("/extract", requireKeywordScope("knowledge:read"), async (c) => {
  try {
    const input = extractInputSchema.parse(await c.req.json());
    const keywords = await extractKeywords(input.text, input.mode, input.maxKeywords);
    return c.json({ keywords });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    console.error("[Keyword] Extract failed:", err);
    return c.json({ error: "Keyword extraction failed" }, 500);
  }
});

keywordRouter.post("/auto-tag", requireKeywordScope("knowledge:write"), async (c) => {
  try {
    const input = autoTagInputSchema.parse(await c.req.json());
    const user = c.get("user");
    const result = await autoTagDocument(input.documentId, 10, user?.id ?? null);
    return c.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    if (err instanceof Error && err.message === "Document not found") {
      return c.json({ error: "Document not found" }, 404);
    }
    console.error("[Keyword] Auto-tag failed:", err);
    return c.json({ error: "Auto-tag failed" }, 500);
  }
});
