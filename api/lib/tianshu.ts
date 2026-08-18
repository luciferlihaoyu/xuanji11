/**
 * 天枢 (Tianshu) — New API 兼容的模型聚合网关配置。
 *
 * 作为璇玑的模型来源兜底：显式的 LLM_API_URL / LLM_API_KEY 优先，
 * 未配置时回落到天枢（TIANSHU_BASE_URL / TIANSHU_API_KEY）。
 * 密钥仅存在于服务端环境变量，不写入数据库、不暴露给前端。
 */

export function tianshuBaseUrl(): string {
  return (process.env.TIANSHU_BASE_URL || "https://woppis1.zeabur.app").replace(/\/+$/, "");
}

export function tianshuApiKey(): string {
  return process.env.TIANSHU_API_KEY || "";
}

export function tianshuEnabled(): boolean {
  return tianshuApiKey().length > 0;
}

/** OpenAI 兼容 API 根路径（…/v1），供 chat/completions 与 embeddings 拼接 */
export function tianshuApiUrl(): string {
  return `${tianshuBaseUrl()}/v1`;
}
