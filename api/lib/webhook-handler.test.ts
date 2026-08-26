import { describe, it, expect, vi } from "vitest";
import { handleWebhookTrigger, parsePositiveIntId } from "./webhook-handler";
import { webhookToken } from "./csrf";

const SECRET = "test-jwt-secret-at-least-32-chars-long!!";

describe("handleWebhookTrigger", () => {
  it("无效 ID 返回 400", async () => {
    const r = await handleWebhookTrigger("abc", "t", {}, {
      parseWorkflowId: parsePositiveIntId,
      jwtSecret: SECRET,
      trigger: vi.fn(),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/无效/);
  });

  it("缺 token 返回 403", async () => {
    const trigger = vi.fn();
    const r = await handleWebhookTrigger("1", "", {}, {
      parseWorkflowId: parsePositiveIntId,
      jwtSecret: SECRET,
      trigger,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Invalid webhook token/);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("错误 token 返回 403（不调 trigger）", async () => {
    const trigger = vi.fn();
    const r = await handleWebhookTrigger("1", "0".repeat(32), {}, {
      parseWorkflowId: parsePositiveIntId,
      jwtSecret: SECRET,
      trigger,
    });
    expect(r.status).toBe(403);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("正确 token + 合法 ID 调用 trigger 并返回 200 + runId", async () => {
    const trigger = vi.fn(async (id, payload) => ({ runId: 42, _echo: { id, payload } } as never));
    const r = await handleWebhookTrigger(
      "1",
      webhookToken(1, SECRET),
      { hello: "world" },
      { parseWorkflowId: parsePositiveIntId, jwtSecret: SECRET, trigger: trigger as never },
    );
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.runId).toBe(42);
    expect(trigger).toHaveBeenCalledWith(1, { hello: "world" });
  });

  it("trigger 返回 error 时端点返回 400", async () => {
    const trigger = vi.fn(async () => ({ error: "workflow disabled" } as never));
    const r = await handleWebhookTrigger(
      "1",
      webhookToken(1, SECRET),
      {},
      { parseWorkflowId: parsePositiveIntId, jwtSecret: SECRET, trigger: trigger as never },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Webhook 触发失败");
  });

  it("非对象 payload 被规整为 {}（不抛错）", async () => {
    const trigger = vi.fn(async (id, payload) => ({ runId: 1, _echo: { id, payload } } as never));
    const r = await handleWebhookTrigger(
      "1",
      webhookToken(1, SECRET),
      "not-an-object",
      { parseWorkflowId: parsePositiveIntId, jwtSecret: SECRET, trigger: trigger as never },
    );
    expect(r.status).toBe(200);
    expect(trigger).toHaveBeenCalledWith(1, {});
  });
});
