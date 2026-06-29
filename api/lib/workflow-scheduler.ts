import { eq, and, gte } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { workflows, workflowRuns } from "@db/schema";
import { executeWorkflow } from "./workflow-runtime";

interface CronTrigger {
  type: "cron";
  schedule: string;
  enabled?: boolean;
}

interface WebhookTrigger {
  type: "webhook";
  enabled?: boolean;
}

type WorkflowTrigger = CronTrigger | WebhookTrigger;

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const vals: number[] = [];
    for (let i = min; i <= max; i++) vals.push(i);
    return vals;
  }
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return [];
    const vals: number[] = [];
    for (let i = min; i <= max; i += step) vals.push(i);
    return vals;
  }
  if (field.includes(",")) {
    return field.split(",").map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
  }
  const val = parseInt(field, 10);
  return isNaN(val) ? [] : [val];
}

function matchCron(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minuteStr, hourStr, dayStr, monthStr, weekdayStr] = parts;

  const minute = parseCronField(minuteStr, 0, 59);
  const hour = parseCronField(hourStr, 0, 23);
  const day = parseCronField(dayStr, 1, 31);
  const month = parseCronField(monthStr, 1, 12);
  const weekday = parseCronField(weekdayStr, 0, 6);

  return (
    minute.includes(date.getMinutes()) &&
    hour.includes(date.getHours()) &&
    day.includes(date.getDate()) &&
    month.includes(date.getMonth() + 1) &&
    weekday.includes(date.getDay())
  );
}

export async function runDueCronWorkflows(): Promise<void> {
  const db = getDb();
  const activeWorkflows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.status, "active"));

  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}_${now.getHours()}:${now.getMinutes()}`;

  for (const workflow of activeWorkflows) {
    const triggers = (workflow.triggers as WorkflowTrigger[] | undefined) ?? [];
    const cronTriggers = triggers.filter(
      (t): t is CronTrigger => t?.type === "cron" && typeof t.schedule === "string" && t.enabled !== false
    );

    if (cronTriggers.length === 0) continue;

    const due = cronTriggers.some((t) => matchCron(t.schedule, now));
    if (!due) continue;

    // 防止同一分钟内重复执行：检查本分钟内是否已有 cron 触发记录
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
    const recentRuns = await db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowId, workflow.id),
          eq(workflowRuns.triggeredBy, "cron"),
          gte(workflowRuns.createdAt, oneMinuteAgo)
        )
      )
      .limit(1);

    if (recentRuns.length > 0) continue;

    console.log(`[WorkflowScheduler] Running cron workflow ${workflow.id} at ${minuteKey}`);
    executeWorkflow(workflow.id, {}, null, "cron").catch((err) => {
      console.error(`[WorkflowScheduler] Cron workflow ${workflow.id} failed:`, err);
    });
  }
}

export function startWorkflowScheduler(intervalMs = 60_000): () => void {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await runDueCronWorkflows();
    } catch (err) {
      console.error("[WorkflowScheduler] Tick failed:", err);
    } finally {
      running = false;
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    clearInterval(timer);
  };
}

export async function triggerWebhookWorkflow(
  workflowId: number,
  payload: Record<string, unknown> = {}
): Promise<{ runId: number } | { error: string }> {
  const db = getDb();
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId));

  if (!workflow) return { error: "Workflow not found" };
  if (workflow.status !== "active") return { error: "Workflow is not active" };

  const triggers = (workflow.triggers as WorkflowTrigger[] | undefined) ?? [];
  const hasWebhook = triggers.some((t) => t?.type === "webhook" && t.enabled !== false);
  if (!hasWebhook) return { error: "Webhook trigger not enabled" };

  const runId = await executeWorkflow(workflowId, payload, null, "webhook");
  return { runId };
}

export function getWebhookUrl(workflowId: number, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/workflows/${workflowId}/webhook`;
}
