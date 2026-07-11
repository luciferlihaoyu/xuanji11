import type { User } from "@db/schema";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AuthInfo } from "./lib/auth";
import { authenticateApiKey, hasScope, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import * as vectorService from "./lib/vector-service";

declare module "hono" {
  interface ContextVariableMap {
    user: User;
    auth: AuthInfo;
  }
}

const zvecAuthMiddleware: MiddlewareHandler = async (c, next) => {
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
    const auth = c.get("auth");
    if (!hasScope(auth, scope)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}

const embedSchema = z.object({
  texts: z.array(z.string().min(1)).max(100),
});

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  topK: z.number().int().min(1).max(50).default(10),
});

const createCollectionSchema = z.object({
  name: z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().max(1000).optional(),
  model: z.string().max(255).optional(),
  dimension: z.number().int().min(1).max(8192).optional(),
});

const deleteCollectionParamsSchema = z.object({
  name: z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/),
});

const collectionStatsParamsSchema = z.object({
  name: z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/),
});

export const zvecRouter = new Hono();

zvecRouter.use(zvecAuthMiddleware);

zvecRouter.onError((err, c) => {
  console.error("[ZVec] Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

zvecRouter.post("/embed", requireScope("zvec:read"), async (c) => {
  try {
    const input = embedSchema.parse(await c.req.json());
    const vectors = await vectorService.embedTexts(input.texts);
    return c.json({ vectors });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    console.error("[ZVec] Embed error:", err); // no-excuse-ok: catch — top-level HTTP handler
    return c.json({ error: "Failed to generate embeddings" }, 500);
  }
});

zvecRouter.post("/search", requireScope("zvec:read"), async (c) => {
  try {
    const input = searchSchema.parse(await c.req.json());
    const results = await vectorService.searchVectors(input.query, input.topK);
    return c.json({ results });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    console.error("[ZVec] Search error:", err); // no-excuse-ok: catch — top-level HTTP handler
    return c.json({ error: "Search failed" }, 500);
  }
});

zvecRouter.get("/collections", requireScope("zvec:read"), async (c) => {
  try {
    const collections = await vectorService.listCollections();
    return c.json({ collections });
  } catch (err) {
    console.error("[ZVec] List collections error:", err); // no-excuse-ok: catch — top-level HTTP handler
    return c.json({ error: "Failed to list collections" }, 500);
  }
});

zvecRouter.post("/collections", requireScope("zvec:write"), async (c) => {
  try {
    const input = createCollectionSchema.parse(await c.req.json());
    const user = c.get("user");
    const result = await vectorService.createCollection({
      ...input,
      createdBy: user.id,
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    console.error("[ZVec] Create collection error:", err); // no-excuse-ok: catch — top-level HTTP handler
    return c.json({ error: "Failed to create collection" }, 500);
  }
});

zvecRouter.delete("/collections/:name", requireScope("zvec:write"), async (c) => {
  try {
    const { name } = deleteCollectionParamsSchema.parse(c.req.param());
    await vectorService.deleteCollection(name);
    return c.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    console.error("[ZVec] Delete collection error:", err); // no-excuse-ok: catch — top-level HTTP handler
    return c.json({ error: "Failed to delete collection" }, 500);
  }
});

zvecRouter.get("/collections/:name/stats", requireScope("zvec:read"), async (c) => {
  try {
    const { name } = collectionStatsParamsSchema.parse(c.req.param());
    const stats = await vectorService.getCollectionStats(name);
    return c.json(stats);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    if (err instanceof Error && err.message.startsWith("Collection not found")) {
      return c.json({ error: "Collection not found" }, 404);
    }
    console.error("[ZVec] Collection stats error:", err); // no-excuse-ok: catch — top-level HTTP handler
    return c.json({ error: "Failed to get collection stats" }, 500);
  }
});
