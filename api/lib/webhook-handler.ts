/**
 * 工作流 webhook 触发端点的纯函数：boot.ts 调用，测试覆盖。
 * HMAC token 鉴权 + 调 triggerWebhookWorkflow，返回 HTTP Response 形态。
 */
import { verifyWebhookToken } from "./csrf";

export interface WebhookDeps {
  /** 工作流 ID 解析是否合法（正整数） */
  parseWorkflowId: (raw: string) => number | undefined;
  /** 从 env/配置中拿 jwtSecret */
  jwtSecret: string;
  /** 真实触发工作流的副作用函数 */
  trigger: (id: number, payload: Record<string, unknown>) => Promise<{ runId: number } | { error: string }>;
}

export type WebhookResponse = { status: number; body: { success: boolean; error?: string; runId?: number } };

export async function handleWebhookTrigger(
  workflowIdRaw: string,
  token: string,
  payload: unknown,
  deps: WebhookDeps,
): Promise<WebhookResponse> {
  const id = deps.parseWorkflowId(workflowIdRaw);
  if (id === undefined) return { status: 400, body: { success: false, error: "无效的工作流 ID" } };
  if (!verifyWebhookToken(id, token, deps.jwtSecret)) {
    return { status: 403, body: { success: false, error: "Invalid webhook token" } };
  }
  const safePayload = (typeof payload === "object" && payload !== null) ? payload as Record<string, unknown> : {};
  const result = await deps.trigger(id, safePayload);
  if ("error" in result) return { status: 400, body: { success: false, error: "Webhook 触发失败" } };
  return { status: 200, body: { success: true, runId: result.runId } };
}

export function parsePositiveIntId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return id;
}
