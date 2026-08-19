import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery, scopedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { systemSettings } from "@db/schema";
import { clean } from "./lib/clean";
import { getConnector, listConnectors as listRegisteredConnectors } from "./connectors";
import { logAudit } from "./lib/audit";
import {
  searchContext as runSearchContext,
  writeTaskMemory as runWriteTaskMemory,
  linkArtifact as runLinkArtifact,
  getMemoryDigest as runGetMemoryDigest,
  startIngestion as runStartIngestion,
  searchContextInputSchema,
  writeTaskMemoryInputSchema,
  linkArtifactInputSchema,
  getMemoryDigestInputSchema,
  startIngestionInputSchema,
} from "./lib/connector-actions";


/** 常见扩展名 → MIME（导入知识库时用于判断是否可向量化） */
const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  log: "text/plain",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  zip: "application/zip",
};

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

  listConnectors: authedQuery.query(async () => {
    const db = getDb();
    const registered = listRegisteredConnectors();
    const rows = await db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(sql`${systemSettings.key} LIKE ${"connector_%_config"}`);

    const configuredKeys = new Set(rows.map((r) => r.key));

    return registered.map((c) => {
      const configKey = connectorConfigKey(c.key);
      const configRow = rows.find((r) => r.key === configKey);
      let status: "connected" | "disconnected" | "error" = "disconnected";
      if (configuredKeys.has(configKey)) {
        status = configRow?.value ? "connected" : "disconnected";
      }
      return {
        key: c.key,
        name: c.name,
        configured: configuredKeys.has(configKey),
        status,
      };
    });
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

  /** 浏览网盘文件（使用已保存的连接器配置） */
  browseFiles: authedQuery
    .input(z.object({
      platform: z.string(),
      path: z.string().max(1000).default("/"),
    }))
    .query(async ({ input }) => {
      const connector = getConnector(input.platform);
      if (!connector) return { success: false as const, error: `未找到连接器: ${input.platform}`, files: [] };
      const db = getDb();
      const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, connectorConfigKey(input.platform)));
      if (!rows[0]?.value) return { success: false as const, error: "请先保存连接器配置", files: [] };
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(rows[0].value) as Record<string, unknown>;
      } catch {
        return { success: false as const, error: "连接器配置格式错误", files: [] };
      }
      try {
        const files = await connector.listFiles(config, input.path);
        return { success: true as const, files };
      } catch (e) {
        return { success: false as const, error: e instanceof Error ? e.message : "读取失败", files: [] };
      }
    }),

  /** 从网盘导入文件到知识库（下载 → 入库 → 文本类文件自动向量化） */
  ingestFiles: adminQuery
    .input(z.object({
      platform: z.string(),
      files: z.array(z.object({
        path: z.string().min(1).max(1000),
        name: z.string().min(1).max(255),
        size: z.number().int().nonnegative().optional(),
      })).min(1).max(20),
      project: z.string().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const connector = getConnector(input.platform);
      if (!connector) return { success: false as const, error: `未找到连接器: ${input.platform}`, results: [] };
      const db = getDb();
      const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, connectorConfigKey(input.platform)));
      if (!rows[0]?.value) return { success: false as const, error: "请先保存连接器配置", results: [] };
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(rows[0].value) as Record<string, unknown>;
      } catch {
        return { success: false as const, error: "连接器配置格式错误", results: [] };
      }

      const results: Array<{ path: string; ok: boolean; documentId?: number; error?: string }> = [];
      for (const file of input.files) {
        try {
          const url = await connector.getDownloadUrl(config, file.path);
          if (!url) throw new Error("无法获取下载地址");
          const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
          const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
          const { ingestFile } = await import("./lib/ingestion");
          const result = await ingestFile({
            sourceType: "datasource",
            sourceId: input.platform,
            fileName: file.name,
            mimeType,
            size: file.size ?? 0,
            downloadUrl: url,
            sourceUrl: url,
            externalId: `${input.platform}:${file.path}`,
            metadata: { platform: input.platform, project: input.project ?? null },
            createdBy: ctx.user?.id ?? null,
          });
          results.push({ path: file.path, ok: true, documentId: result.documentId });
        } catch (e) {
          results.push({ path: file.path, ok: false, error: e instanceof Error ? e.message : "导入失败" });
        }
      }
      await logAudit(ctx, "connector_ingest", "create", null, { platform: input.platform, count: input.files.length });
      return { success: true as const, results };
    }),

  // ---- 天宫-璇玑集成契约接口 ----
  searchContext: scopedQuery("knowledge:read")
    .input(searchContextInputSchema)
    .query(async ({ input }) => runSearchContext(input)),

  writeTaskMemory: scopedQuery("knowledge:write")
    .input(writeTaskMemoryInputSchema)
    .mutation(async ({ input }) => runWriteTaskMemory(input)),

  linkArtifact: scopedQuery("artifact:link")
    .input(linkArtifactInputSchema)
    .mutation(async ({ input }) => runLinkArtifact(input)),

  getMemoryDigest: scopedQuery("knowledge:read")
    .input(getMemoryDigestInputSchema)
    .query(async ({ input }) => runGetMemoryDigest(input)),

  startIngestion: scopedQuery("ingestion:write")
    .input(startIngestionInputSchema)
    .mutation(async ({ input }) => runStartIngestion(input)),
});
