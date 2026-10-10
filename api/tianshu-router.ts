/**
 * 天枢 (Tianshu / New API 兼容网关) 模型管理路由
 *
 * - 从天枢拉取可用模型列表（用 safeFetch + scope="admin" 走 egress 校验）
 * - 对话模型选择：持久化到 system_settings.tianshu_chat_model，关键词提取等 LLM 调用立即生效
 * - 嵌入模型选择：写入 embedding_model（legacy 配置键），并停用向量模板以使其生效
 *
 * L2 修复（Reviewer B L2 / 之前的 L2 报告）：tianshu 原用 global fetch 直连出网——
 * admin 改 TIANSHU_BASE_URL 到内网即触发 SSRF。改用 safeFetch（DNS 钉死 + 协议
 * 白名单 + egress allowlist）；scope="admin" 让 admin 显式配的固定服务目标在
 * 60s 缓存窗口内复用校验，但管理员放行内网（EGRESS_ALLOW_PRIVATE_NET=true）
 * 是部署侧显式决策。
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { systemSettings } from "@db/schema";
import { tianshuApiUrl, tianshuApiKey, tianshuEnabled, tianshuBaseUrl } from "./lib/tianshu";
import { safeFetch } from "./lib/safe-fetch";
import { EgressError } from "./lib/egress";
import { logAudit } from "./lib/audit";

export const TIANSHU_CHAT_MODEL_KEY = "tianshu_chat_model";
const EMBEDDING_MODEL_KEY = "embedding_model";
const ACTIVE_TEMPLATE_KEY = "embedding_active_template_id";

async function getSettingValue(key: string): Promise<string | undefined> {
  const db = getDb();
  const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return rows[0]?.value ?? undefined;
}

async function upsertSetting(key: string, value: string, category: string): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  if (existing.length > 0) {
    await db.update(systemSettings).set({ value, category }).where(eq(systemSettings.key, key));
  } else {
    await db.insert(systemSettings).values({ key, value, category });
  }
}

/** 解析当前生效的对话模型：设置页选择 > TIANSHU_CHAT_MODEL 环境变量 > 默认值 */
export async function resolveTianshuChatModel(): Promise<string> {
  const fromSettings = await getSettingValue(TIANSHU_CHAT_MODEL_KEY).catch(() => undefined);
  return (fromSettings || "").trim() || (process.env.TIANSHU_CHAT_MODEL || "").trim() || "gpt-3.5-turbo";
}

function safeHost(): string {
  try {
    return new URL(tianshuBaseUrl()).host;
  } catch {
    return "invalid";
  }
}

interface TianshuModelsPayload {
  data?: Array<{ id?: unknown }>;
}

export const tianshuRouter = createRouter({
  /** 天枢连接状态 + 当前模型选择 */
  status: authedQuery.query(async () => {
    const chatModel = await resolveTianshuChatModel();
    const embeddingModel =
      (await getSettingValue(EMBEDDING_MODEL_KEY).catch(() => undefined)) ||
      process.env.EMBEDDING_MODEL ||
      process.env.TIANSHU_EMBEDDING_MODEL ||
      "text-embedding-3-small";
    const activeTemplate = await getSettingValue(ACTIVE_TEMPLATE_KEY).catch(() => undefined);
    return {
      configured: tianshuEnabled(),
      baseUrlHost: safeHost(),
      // 完整网关地址（非密：设置页已展示 host；Agent 表单自动填充用）
      apiUrl: tianshuEnabled() ? tianshuApiUrl() : undefined,
      chatModel,
      embeddingModel,
      embeddingTemplateActive: Boolean(activeTemplate),
    };
  }),

  /** 从天枢拉取可用模型列表 */
  listModels: authedQuery.query(async () => {
    const apiKey = tianshuApiKey();
    if (!apiKey) {
      return { ok: false as const, error: "TIANSHU_API_KEY 未配置", models: [] as string[] };
    }
    try {
      // L2 修复：用 safeFetch + scope="admin" 走 egress 校验，堵 SSRF
      // （admin 改 TIANSHU_BASE_URL 到内网不再静默放行）。safeFetch 内部 DNS
      // 钉死 + 协议白名单 + 每跳重新校验；timeout 仍由调用方 signal 控制。
      const resp = await safeFetch(`${tianshuApiUrl()}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
        scope: "admin",
      });
      if (!resp.ok) {
        return { ok: false as const, error: `天枢返回 HTTP ${resp.status}`, models: [] as string[] };
      }
      const payload = JSON.parse(await resp.text()) as TianshuModelsPayload;
      const models = (payload.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 255)
        .sort();
      return { ok: true as const, models };
    } catch (e) {
      // EgressError：URL 被 egress 策略拒绝（内网 / 黑名单等）—— 提示管理员
      if (e instanceof EgressError) {
        return { ok: false as const, error: `天枢地址被出口策略拒绝: ${e.message}`, models: [] as string[] };
      }
      return { ok: false as const, error: `天枢请求失败: ${e instanceof Error ? e.message : String(e)}`, models: [] as string[] };
    }
  }),

  /** 设置对话模型（关键词提取、Agent LLM 调用等） */
  setChatModel: adminQuery
    .input(z.object({ model: z.string().min(1).max(255) }))
    .mutation(async ({ input, ctx }) => {
      await upsertSetting(TIANSHU_CHAT_MODEL_KEY, input.model, "tianshu");
      await logAudit(ctx, "system_setting", "update", null, { key: TIANSHU_CHAT_MODEL_KEY, value: input.model });
      return { success: true as const, chatModel: input.model };
    }),

  /**
   * 设置嵌入模型（写入 legacy embedding_model 键，并停用向量模板使其生效）。
   * 注意：更换嵌入模型可能改变向量维度，已有向量数据需重建索引。
   */
  setEmbeddingModel: adminQuery
    .input(z.object({ model: z.string().min(1).max(255) }))
    .mutation(async ({ input, ctx }) => {
      await upsertSetting(EMBEDDING_MODEL_KEY, input.model, "vectorization");
      // 停用模板，让 legacy 配置（embedding_model + 天枢网关）生效
      await upsertSetting(ACTIVE_TEMPLATE_KEY, "", "vectorization");
      await logAudit(ctx, "system_setting", "update", null, { key: EMBEDDING_MODEL_KEY, value: input.model });
      return { success: true as const, embeddingModel: input.model };
    }),
});
