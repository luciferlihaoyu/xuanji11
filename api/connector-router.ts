import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { systemSettings } from "@db/schema";
import { clean } from "./lib/clean";
import { getConnector } from "./connectors";
import { logAudit } from "./lib/audit";

const connectorConfigKey = (platform: string) => `connector_${platform}_config`;

const configSchema = z.record(z.string(), z.unknown());

export const connectorRouter = createRouter({
  getConfig: authedQuery
    .input(z.object({ platform: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, connectorConfigKey(input.platform)));
      const row = results[0];
      if (!row?.value) return null;
      try {
        return JSON.parse(row.value) as Record<string, unknown>;
      } catch {
        return null;
      }
    }),

  saveConfig: adminQuery
    .input(
      z.object({
        platform: z.string(),
        config: configSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const key = connectorConfigKey(input.platform);
      const value = JSON.stringify(input.config);
      const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, key));

      if (existing.length > 0) {
        await db
          .update(systemSettings)
          .set(clean({ value, category: "connector", updatedBy: ctx.user?.id ?? null }))
          .where(eq(systemSettings.key, key));
      } else {
        await db.insert(systemSettings).values({
          key,
          value,
          category: "connector",
          updatedBy: ctx.user?.id ?? null,
        });
      }
      await logAudit(ctx, "connector_config", "update", null, input as Record<string, unknown>);
      return { success: true };
    }),

  testConnection: authedQuery
    .input(
      z.object({
        platform: z.string(),
        config: configSchema,
      })
    )
    .mutation(async ({ input }) => {
      const connector = getConnector(input.platform);
      if (!connector) {
        return { success: false, message: `未找到连接器: ${input.platform}` };
      }
      return connector.testConnection(input.config);
    }),

  refreshToken: adminQuery
    .input(
      z.object({
        platform: z.string(),
        config: configSchema,
      })
    )
    .mutation(async ({ input, ctx }): Promise<{ success: boolean; message?: string; accessToken?: string; refreshToken?: string }> => {
      const connector = getConnector(input.platform);
      if (!connector) {
        return { success: false, message: `未找到连接器: ${input.platform}` };
      }
      if (!connector.refreshToken) {
        return { success: false, message: "该连接器不支持刷新 Token" };
      }
      const tokens = await connector.refreshToken(input.config);
      if (!tokens) {
        return { success: false, message: "刷新 Token 失败" };
      }
      const db = getDb();
      const key = connectorConfigKey(input.platform);
      const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, key));

      if (existing.length > 0) {
        await db
          .update(systemSettings)
          .set(clean({
            value: JSON.stringify({ ...input.config, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
            category: "connector",
            updatedBy: ctx.user?.id ?? null,
          }))
          .where(eq(systemSettings.key, key));
      } else {
        await db.insert(systemSettings).values({
          key,
          value: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
          category: "connector",
          updatedBy: ctx.user?.id ?? null,
        });
      }
      await logAudit(ctx, "connector_config", "update", null, { platform: input.platform } as Record<string, unknown>);
      return { success: true, ...tokens };
    }),
});
