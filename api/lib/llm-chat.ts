/**
 * OpenAI 兼容 chat completion 薄封装。
 * LLM 来源复用 keyword-extractor 的 findLlmAgent()（agent 配置 → LLM_* 环境变量 → 天枢网关）。
 * 出站请求统一过 egress guard（apiUrl 来自管理员可配的 agent 设置）。
 */
import { findLlmAgent } from "./keyword-extractor";
import { assertEgressAllowed } from "./egress";

export interface ChatResult {
  readonly content: string;
  readonly model: string;
}

export async function hasLlmAvailable(): Promise<boolean> {
  return (await findLlmAgent()) !== undefined;
}

/** 发起一次 chat completion；未配置 LLM 或调用失败返回 undefined（调用方决定回退/skipped）。 */
export async function chatCompletion(
  prompt: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult | undefined> {
  const config = await findLlmAgent();
  if (!config) return undefined;

  const url = config.apiUrl.endsWith("/chat/completions")
    ? config.apiUrl
    : `${config.apiUrl.replace(/\/$/, "")}/chat/completions`;

  await assertEgressAllowed(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[LlmChat] HTTP error:", res.status);
      return undefined;
    }
    const data = (await res.json().catch(() => null)) as
      | { choices?: { message?: { content?: string } }[] }
      | null;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return undefined;
    return { content, model: config.model };
  } catch (err) {
    console.error("[LlmChat] request failed:", err instanceof Error ? err.message : err);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * 流式 chat completion（SSE 解析）。
 * onToken 收到每个增量 token；返回完整内容与模型名；失败返回 undefined。
 */
export async function chatCompletionStream(
  messages: readonly ChatMessage[],
  onToken: (token: string) => void,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult | undefined> {
  const config = await findLlmAgent();
  if (!config) return undefined;

  const url = config.apiUrl.endsWith("/chat/completions")
    ? config.apiUrl
    : `${config.apiUrl.replace(/\/$/, "")}/chat/completions`;

  await assertEgressAllowed(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1000,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      console.error("[LlmChat] stream HTTP error:", res.status);
      return undefined;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onToken(delta);
          }
        } catch {
          // 半截 JSON 行，跳过
        }
      }
    }
    if (!full) return undefined;
    return { content: full, model: config.model };
  } catch (err) {
    console.error("[LlmChat] stream failed:", err instanceof Error ? err.message : err);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
