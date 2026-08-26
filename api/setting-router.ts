import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { systemSettings } from "@db/schema";
import { clean } from "./lib/clean";
import { logAudit } from "./lib/audit";
import { maskSettingRows, maskSettingValue } from "./lib/setting-mask";
import * as vectorService from "./lib/vector-service";

const vectorModelProviderSchema = z.enum(["openai", "minimax", "local", "custom"]);

const vectorModelTemplateIdSchema = z.object({
  id: z.string().min(1).max(255),
});

const vectorModelTemplateSaveInputSchema = z.object({
  id: z.string().min(1).max(255).optional(),
  name: z.string().min(1).max(255),
  provider: vectorModelProviderSchema.optional(),
  customProviderName: z.string().max(255).optional(),
  apiUrl: z.string().url().max(2048),
  apiKey: z.string().max(4096),
  model: z.string().min(1).max(255),
  dimension: z.number().int().min(1).max(8192).optional(),
  indexMode: z.string().max(100).optional(),
  similarityThreshold: z.string().max(100).optional(),
});

const vectorModelTemplateTestInputSchema = z.object({
  id: z.string().min(1).max(255).optional(),
  provider: vectorModelProviderSchema.optional(),
  customProviderName: z.string().max(255).optional(),
  apiUrl: z.string().url().max(2048),
  apiKey: z.string().max(4096),
  model: z.string().min(1).max(255),
  dimension: z.number().int().min(1).max(8192).optional(),
});

export const settingRouter = createRouter({
  // 整表/分类读取仅限管理员，且秘密值统一脱敏后返回。
  list: adminQuery.query(async () => {
    const db = getDb();
    return maskSettingRows(await db.select().from(systemSettings));
  }),

  listByCategory: adminQuery
    .input(z.object({ category: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return maskSettingRows(
        await db.select().from(systemSettings)
          .where(eq(systemSettings.category, input.category)),
      );
    }),

  // 单键读取保留登录级权限（普通用户需读 profile_* 等自身配置），
  // 但命中敏感规则的键一律返回掩码，杜绝点名窃取 admin_password_hash 等。
  getByKey: authedQuery
    .input(z.object({ key: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(systemSettings)
        .where(eq(systemSettings.key, input.key));
      const row = results[0];
      if (!row) return null;
      return {
        ...row,
        value: row.value === null ? null : maskSettingValue(row.key, row.value),
      };
    }),

  set: adminQuery
    .input(
      z.object({
        key: z.string().min(1).max(255),
        value: z.string(),
        category: z.string().max(100).default("general"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const existing = await db.select().from(systemSettings)
        .where(eq(systemSettings.key, input.key));

      if (existing.length > 0) {
        await db.update(systemSettings)
          .set(clean({
            value: input.value,
            category: input.category,
            updatedBy: ctx.user?.id ?? null,
          }))
          .where(eq(systemSettings.key, input.key));
      } else {
        await db.insert(systemSettings).values({
          key: input.key,
          value: input.value,
          category: input.category,
          updatedBy: ctx.user?.id ?? null,
        });
      }
      await logAudit(ctx, "system_setting", "update", null, input as Record<string, unknown>);
      return { success: true };
    }),

  setMany: adminQuery
    .input(
      z.array(z.object({
        key: z.string().min(1).max(255),
        value: z.string(),
        category: z.string().max(100).default("general"),
      }))
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      for (const item of input) {
        const existing = await db.select().from(systemSettings)
          .where(eq(systemSettings.key, item.key));

        if (existing.length > 0) {
          await db.update(systemSettings)
            .set(clean({
              value: item.value,
              category: item.category,
              updatedBy: ctx.user?.id ?? null,
            }))
            .where(eq(systemSettings.key, item.key));
        } else {
          await db.insert(systemSettings).values({
            key: item.key,
            value: item.value,
            category: item.category,
            updatedBy: ctx.user?.id ?? null,
          });
        }
      }
      await logAudit(ctx, "system_setting", "update", null, { items: input } as Record<string, unknown>);
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ key: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(systemSettings).where(eq(systemSettings.key, input.key));
      await logAudit(ctx, "system_setting", "delete", null, input as Record<string, unknown>);
      return { success: true };
    }),

  listVectorModelTemplates: authedQuery.query(async () => {
    return vectorService.listVectorModelTemplates();
  }),

  getVectorModelTemplate: authedQuery
    .input(vectorModelTemplateIdSchema)
    .query(async ({ input }) => {
      const template = await vectorService.getVectorModelTemplate(input.id);
      if (!template) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Vector model template not found" });
      }
      return template;
    }),

  saveVectorModelTemplate: adminQuery
    .input(vectorModelTemplateSaveInputSchema)
    .mutation(async ({ input, ctx }) => {
      const summary = await vectorService.saveVectorModelTemplate(input);
      await logAudit(ctx, "vector_model_template", "update", null, { id: summary.id, name: summary.name } as Record<string, unknown>);
      return summary;
    }),

  deleteVectorModelTemplate: adminQuery
    .input(vectorModelTemplateIdSchema)
    .mutation(async ({ input, ctx }) => {
      await vectorService.deleteVectorModelTemplate(input.id);
      await logAudit(ctx, "vector_model_template", "delete", null, input as Record<string, unknown>);
      return { success: true };
    }),

  selectVectorModelTemplate: adminQuery
    .input(vectorModelTemplateIdSchema)
    .mutation(async ({ input, ctx }) => {
      const summary = await vectorService.selectVectorModelTemplate(input.id);
      await logAudit(ctx, "vector_model_template", "update", null, input as Record<string, unknown>);
      return summary;
    }),

  testVectorModelTemplate: adminQuery
    .input(vectorModelTemplateTestInputSchema)
    .mutation(async ({ input }) => {
      const { id, ...config } = input;
      const result = await vectorService.testEmbeddingConfig(config);
      if (id) {
        await vectorService.markVectorModelTemplateTest(id, result);
      }
      return result;
    }),
});
