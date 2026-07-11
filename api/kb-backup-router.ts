import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey, hasScope, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { exportKnowledgeBase, importKnowledgeBase } from "./lib/kb-backup";

declare module "hono" {
  interface ContextVariableMap {
    user: User;
    auth: AuthInfo;
  }
}

const kbBackupAuthMiddleware: MiddlewareHandler = async (c, next) => {
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

function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    if (!hasScope(c.get("auth"), scope)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}

export const kbBackupRouter = new Hono();

kbBackupRouter.use(kbBackupAuthMiddleware);

kbBackupRouter.onError((err, c) => {
  console.error("[KB Backup] Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

kbBackupRouter.post("/export", requireScope("knowledge:read"), async (c) => {
  try {
    const result = await exportKnowledgeBase();
    return c.json(result);
  } catch (err) {
    console.error("[KB Backup] Export failed:", err); // no-excuse-ok: catch — top-level HTTP handler
    return c.json({ error: "Export failed" }, 500);
  }
});

kbBackupRouter.post("/import", requireScope("knowledge:write"), async (c) => {
  try {
    const body = await c.req.json();
    const result = await importKnowledgeBase(body);
    return c.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    console.error("[KB Backup] Import failed:", err); // no-excuse-ok: catch — top-level HTTP handler
    return c.json({ error: "Import failed" }, 500);
  }
});
