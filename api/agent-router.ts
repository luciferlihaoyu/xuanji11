import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { eq, desc, like, or, and } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, apiKeys } from "@db/schema";
import { clean } from "./lib/clean";
import { logAudit } from "./lib/audit";
import { scopesFromPermissions } from "./lib/auth";

export const agentRouter = createRouter({
  list: authedQuery
    .input(
      z.object({
        search: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [];

      if (input?.search) {
        conditions.push(or(
          like(agents.name, `%${input.search}%`),
          like(agents.description, `%${input.search}%`)
        ));
      }
      if (input?.type) {
        conditions.push(eq(agents.type, input.type as "assistant" | "analyst" | "curator" | "connector" | "custom"));
      }
      if (input?.status) {
        conditions.push(eq(agents.status, input.status as "active" | "inactive" | "error" | "training"));
      }

      return db.select().from(agents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(agents.updatedAt));
    }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(agents).where(eq(agents.id, input.id));
      return results[0] ?? null;
    }),

  create: adminQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        type: z.enum(["assistant", "analyst", "curator", "connector", "custom"]).default("assistant"),
        avatarUrl: z.string().optional(),
        status: z.enum(["active", "inactive", "error", "training"]).default("active"),
        config: z.record(z.string(), z.unknown()).optional(),
        permissions: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(agents).values(clean({
        name: input.name,
        description: input.description,
        type: input.type,
        avatarUrl: input.avatarUrl,
        status: input.status,
        config: input.config as Record<string, unknown>,
        permissions: input.permissions as Record<string, unknown>,
        createdBy: ctx.user?.id ?? null,
      }));
      const id = Number(result[0].insertId);
      await logAudit(ctx, "agent", "create", id, input as Record<string, unknown>);
      return { id };
    }),

  update: adminQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        type: z.enum(["assistant", "analyst", "curator", "connector", "custom"]).optional(),
        avatarUrl: z.string().optional(),
        status: z.enum(["active", "inactive", "error", "training"]).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        permissions: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(agents).set(clean(data as Record<string, unknown>)).where(eq(agents.id, id));
      await logAudit(ctx, "agent", "update", id, input as Record<string, unknown>);
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(agents).where(eq(agents.id, input.id));
      await logAudit(ctx, "agent", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  updatePermissions: adminQuery
    .input(
      z.object({
        id: z.number(),
        permissions: z.record(z.string(), z.unknown()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.update(agents)
        .set({ permissions: input.permissions as Record<string, unknown> })
        .where(eq(agents.id, input.id));
      await logAudit(ctx, "agent", "update", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  generateApiKey: adminQuery
    .input(
      z.object({
        agentId: z.number(),
        name: z.string().min(1).max(255),
        expiresAt: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rawKey = "xu_sk_" + randomBytes(32).toString("hex");
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.slice(0, 12);

      const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
      const permissions = agent?.permissions ?? {};
      const scopes = scopesFromPermissions(permissions);

      const result = await db.insert(apiKeys).values(clean({
        name: input.name,
        keyHash,
        keyPrefix,
        agentId: input.agentId,
        permissions,
        scopes,
        isActive: "true",
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        createdBy: ctx.user?.id ?? null,
      }));

      return {
        id: Number(result[0].insertId),
        key: rawKey,
        keyPrefix,
        name: input.name,
        scopes,
        message: "Store this key securely. It will not be shown again.",
      };
    }),

  listApiKeys: adminQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        isActive: apiKeys.isActive,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      }).from(apiKeys)
        .where(eq(apiKeys.agentId, input.agentId))
        .orderBy(desc(apiKeys.createdAt));
    }),

  revokeApiKey: adminQuery
    .input(z.object({ keyId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(apiKeys)
        .set({ isActive: "false" })
        .where(eq(apiKeys.id, input.keyId));
      return { success: true };
    }),

  testLlmConnection: adminQuery
    .input(
      z.object({
        apiUrl: z.string().url(),
        apiKey: z.string(),
        model: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const url = input.apiUrl.endsWith('/chat/completions')
        ? input.apiUrl
        : input.apiUrl.replace(/\/$/, '') + '/chat/completions';

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify({
            model: input.model || 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok) {
          const text = await res.text().catch(() => 'No response body');
          return { success: false as const, message: `HTTP ${res.status}: ${text}` };
        }

        const data = (await res.json().catch(() => null)) as { choices?: unknown[]; id?: string } | null;
        if (data && (data.choices || data.id)) {
          return { success: true as const, message: '连接成功' };
        }
        return { success: true as const, message: '响应正常' };
      } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          return { success: false as const, message: '请求超时（15秒）' };
        }
        return { success: false as const, message: err.message || '网络请求失败' };
      }
    }),
});
