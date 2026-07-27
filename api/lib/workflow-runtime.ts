import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../queries/connection";
import { mcpServers, workflows, workflowNodes, workflowRuns, workflowRunNodes } from "@db/schema";
import { McpClient, type McpServerConfig } from "./mcp-client";

export interface NodeExecutionContext {
  input: Record<string, unknown>;
  outputs: Record<string, Record<string, unknown>>;
}

export interface NodeExecutor {
  (config: Record<string, unknown>, ctx: NodeExecutionContext): Promise<Record<string, unknown>>;
}

class WorkflowMcpConfigError extends Error {
  readonly name = "WorkflowMcpConfigError";
}

const callAgentConfigSchema = z.object({
  agentName: z.string().optional(),
  serverId: z.number().int().positive().optional(),
  serverUrl: z.string().url().max(2048).optional(),
  authToken: z.string().max(4096).optional(),
  toolName: z.string().min(1).max(255).optional(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

type CallAgentConfig = z.infer<typeof callAgentConfigSchema>;

function placeholderCallAgent(config: Record<string, unknown>): Record<string, unknown> {
  return { agent: String(config.agentName ?? ''), calledAt: new Date().toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordFromToolResult(result: unknown): Record<string, unknown> {
  return isRecord(result) ? result : { result };
}

function hasRawMcpServerInfo(config: Record<string, unknown>): boolean {
  return typeof config.serverId === "number" || typeof config.serverUrl === "string";
}

async function resolveCallAgentConfig(input: CallAgentConfig): Promise<McpServerConfig> {
  if (input.serverId !== undefined) {
    const [server] = await getDb().select().from(mcpServers).where(eq(mcpServers.id, input.serverId));
    if (!server) throw new WorkflowMcpConfigError("MCP server not found");
    if (!server.enabled) throw new WorkflowMcpConfigError("MCP server is disabled");
    return server.authToken ? { url: server.url, authToken: server.authToken } : { url: server.url };
  }
  if (input.serverUrl === undefined) {
    throw new WorkflowMcpConfigError("call-agent requires serverId or serverUrl when toolName is provided");
  }
  return input.authToken ? { url: input.serverUrl, authToken: input.authToken } : { url: input.serverUrl };
}

export async function executeCallAgent(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hasServerInfo = hasRawMcpServerInfo(config);
  const hasToolName = typeof config.toolName === "string" && config.toolName.length > 0;
  if (!hasServerInfo && !hasToolName) return placeholderCallAgent(config);
  if (!hasServerInfo || !hasToolName) {
    throw new WorkflowMcpConfigError("call-agent MCP config requires server info and toolName");
  }

  const parsed = callAgentConfigSchema.safeParse(config);
  if (!parsed.success) throw new WorkflowMcpConfigError("Invalid call-agent MCP configuration");
  const client = new McpClient(await resolveCallAgentConfig(parsed.data));
  const toolName = parsed.data.toolName;
  if (toolName === undefined) throw new WorkflowMcpConfigError("call-agent MCP config requires toolName");
  return recordFromToolResult(await client.callTool(toolName, parsed.data.arguments));
}

const nodeExecutors: Record<string, NodeExecutor> = {
  delay: async (config) => {
    const ms = Number(config.ms ?? 1000);
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10000)));
    return { delayedMs: ms };
  },

  condition: async (config, ctx) => {
    const expression = String(config.expression ?? 'true');
    const result = expression === 'true' || ctx.input[expression] !== undefined;
    return { result };
  },

  'save-result': async (config) => {
    return { message: String(config.message ?? 'saved'), savedAt: new Date().toISOString() };
  },

  'text-extract': async (config) => {
    const text = String(config.text ?? '');
    return { extracted: text.slice(0, 200), length: text.length };
  },

  'find-similar': async (config) => {
    return { query: String(config.query ?? ''), matches: [] };
  },

  'create-link': async (config) => {
    return { sourceId: String(config.sourceId ?? ''), targetId: String(config.targetId ?? '') };
  },

  'call-agent': async (config) => executeCallAgent(config),

  'notify-agent': async (config) => {
    return { notified: String(config.agentName ?? ''), at: new Date().toISOString() };
  },

  'file-upload': async () => ({ triggered: true }),

  cron: async (config) => ({ schedule: String(config.schedule ?? '') }),

  webhook: async (config) => ({ endpoint: String(config.endpoint ?? '') }),

  keywords: async (config) => {
    const text = String(config.text ?? '');
    const keywords = Array.from(new Set(text.split(/\s+/).filter((w) => w.length > 1))).slice(0, 10);
    return { keywords };
  },

  summarize: async (config) => {
    const text = String(config.text ?? '');
    return { summary: text.slice(0, 200) };
  },

  vectorize: async (config) => ({
    model: String(config.model ?? 'text-embedding-3-small'),
    vectorized: true,
  }),

  'send-notification': async (config) => ({
    channel: String(config.channel ?? 'app'),
    sentAt: new Date().toISOString(),
  }),
};

function topologicalSort(nodes: Array<typeof workflowNodes.$inferSelect>): Array<typeof workflowNodes.$inferSelect> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<number>();
  const result: Array<typeof workflowNodes.$inferSelect> = [];

  function visit(nodeId: number) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const connections = (node.connections as Array<{ targetId?: number }> | undefined) ?? [];
    for (const conn of connections) {
      if (conn.targetId) visit(conn.targetId);
    }
    result.push(node);
  }

  for (const node of nodes) {
    visit(node.id);
  }
  return result.reverse();
}

export async function executeWorkflow(
  workflowId: number,
  runInput: Record<string, unknown> = {},
  createdBy?: number | null,
  triggeredBy: "manual" | "api" | "cron" | "webhook" = "manual"
): Promise<number> {
  const db = getDb();
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  if (!workflow) throw new Error("Workflow not found");

  const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId));
  const sorted = topologicalSort(nodes);

  const runResult = await db.insert(workflowRuns).values({
    workflowId,
    status: "running",
    triggeredBy,
    input: runInput,
    output: {},
    error: null,
    startedAt: new Date(),
    createdBy: createdBy ?? null,
  });
  const runId = Number(runResult[0].insertId);

  const nodeResultRows = new Map<number, number>();
  for (const node of sorted) {
    const nodeRunResult = await db.insert(workflowRunNodes).values({
      runId,
      nodeId: node.id,
      status: "pending",
      input: {},
      output: {},
      error: null,
    });
    nodeResultRows.set(node.id, Number(nodeRunResult[0].insertId));
  }

  const outputs: Record<string, Record<string, unknown>> = {};
  let failed = false;

  for (const node of sorted) {
    const nodeRunId = nodeResultRows.get(node.id);
    if (!nodeRunId) continue;

    await db.update(workflowRunNodes).set({ status: "running", startedAt: new Date() }).where(eq(workflowRunNodes.id, nodeRunId));

    const config = (node.config as Record<string, unknown> | undefined) ?? {};
    const executor = nodeExecutors[node.type] ?? nodeExecutors['save-result'];

    try {
      const output = await executor(config, { input: runInput, outputs });
      outputs[node.id] = output;
      await db.update(workflowRunNodes).set({ status: "completed", output, completedAt: new Date() }).where(eq(workflowRunNodes.id, nodeRunId));
    } catch (err) {
      failed = true;
      console.error("[WorkflowRuntime] Node execution failed:", err);
      await db.update(workflowRunNodes).set({
        status: "failed",
        error: "Internal workflow error",
        completedAt: new Date(),
      }).where(eq(workflowRunNodes.id, nodeRunId));
    }
  }

  const finalOutput = sorted.length > 0 ? outputs[sorted[sorted.length - 1].id] ?? {} : {};
  await db.update(workflowRuns).set({
    status: failed ? "failed" : "completed",
    output: finalOutput,
    completedAt: new Date(),
  }).where(eq(workflowRuns.id, runId));

  return runId;
}
