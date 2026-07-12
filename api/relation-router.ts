import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey, hasScope, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { discoverInputSchema, discoverRelations } from "./lib/relation-analyzer";

declare module "hono" {
  interface ContextVariableMap {
    user: User;
    auth: AuthInfo;
  }
}

const relationAuthMiddleware: MiddlewareHandler = async (c, next) => {
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

function requireRelationScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!hasScope(auth, scope)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}

export const relationRouter = new Hono();

relationRouter.use(relationAuthMiddleware);

relationRouter.onError((err, c) => {
  console.error("[Relation] Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

relationRouter.post("/discover", requireRelationScope("knowledge:read"), async (c) => {
  try {
    const input = discoverInputSchema.parse(await c.req.json());
    const result = await discoverRelations(input);
    return c.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    if (err instanceof Error && err.message === "Document not found") {
      return c.json({ error: "Document not found" }, 404);
    }
    console.error("[Relation] Discover failed:", err);
    return c.json({ error: "Relation discovery failed" }, 500);
  }
});
