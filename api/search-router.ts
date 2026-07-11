import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey, hasScope, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { executeHybridSearch, searchInputSchema } from "./lib/hybrid-search";

declare module "hono" {
  interface ContextVariableMap {
    user: User;
    auth: AuthInfo;
  }
}

const searchAuthMiddleware: MiddlewareHandler = async (c, next) => {
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

function requireSearchScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!hasScope(auth, scope)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}

export const searchRouter = new Hono();

searchRouter.use(searchAuthMiddleware);

searchRouter.onError((err, c) => {
  console.error("[Search] Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

searchRouter.post("/", requireSearchScope("knowledge:read"), async (c) => {
  try {
    const input = searchInputSchema.parse(await c.req.json());
    const result = await executeHybridSearch(input);
    return c.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    console.error("[Search] Search failed:", err);
    return c.json({ error: "Search failed" }, 500);
  }
});
