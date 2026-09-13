/**
 * 工作流事件触发器：领域事件（如新文档创建）→ 触发绑定的 active 工作流。
 *
 * 与 cron/webhook 触发器并列，是第三种触发方式。
 * 工作流在 triggers JSON 里声明 { "type": "document-created", "enabled": true }
 * 即订阅本事件。触发时把工作流输入 { documentId, title } 传给首节点。
 *
 * 设计：fire-and-forget——不阻塞文档创建主流程，失败只记日志不影响创建。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { workflows } from "@db/schema";
import { executeWorkflow } from "./workflow-runtime";

interface DocumentCreatedTrigger {
  type: "document-created";
  enabled?: boolean;
}

/** 新文档创建事件：触发所有订阅了 document-created 的 active 工作流 */
export async function fireDocumentCreated(documentId: number, title: string): Promise<number> {
  const db = getDb();
  const activeWorkflows = await db.select({
    id: workflows.id,
    name: workflows.name,
    triggers: workflows.triggers,
  }).from(workflows).where(eq(workflows.status, "active"));

  const subscribed = activeWorkflows.filter((w) => {
    const triggers = (w.triggers as DocumentCreatedTrigger[] | undefined) ?? [];
    return triggers.some((t) => t?.type === "document-created" && t.enabled !== false);
  });

  let fired = 0;
  for (const w of subscribed) {
    try {
      await executeWorkflow(w.id, { documentId, title }, null, "api");
      fired++;
    } catch (err) {
      console.error(`[WorkflowEvent] document-created 触发工作流 ${w.id}(${w.name}) 失败:`, err);
    }
  }
  if (fired > 0) {
    console.log(`[WorkflowEvent] 文档 ${documentId} 触发 ${fired} 个工作流`);
  }
  return fired;
}
