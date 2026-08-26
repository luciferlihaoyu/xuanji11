import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../queries/connection";
import {
  kbDocuments,
  knowledgeEdges,
  mcpServers,
  workflows,
  workflowNodes,
  workflowRuns,
  workflowRunNodes,
} from "@db/schema";
import { McpClient, type McpServerConfig } from "./mcp-client";
import { embedTexts } from "./vector-service";
import { executeHybridSearch } from "./hybrid-search";
import { extractKeywords } from "./keyword-extractor";
import { chatCompletion } from "./llm-chat";

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

/** 构造 skipped 输出：含 skipped 字段的节点状态记为 "skipped" 而非 "completed"。 */
function skipped(reason: string): Record<string, unknown> {
  return { skipped: reason };
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

  'save-result': async (config, ctx) => {
    const folderId = Number(config.targetFolderId ?? 0);
    if (!Number.isInteger(folderId) || folderId <= 0) {
      return skipped('save-result 需要配置 targetFolderId（结果写入的知识库文件夹）');
    }
    const title = String(config.title ?? '工作流结果').slice(0, 500) || '工作流结果';
    const content =
      typeof config.content === 'string' && config.content.trim()
        ? config.content
        : JSON.stringify(ctx.outputs, null, 2);
    const db = getDb();
    const result = await db.insert(kbDocuments).values({
      folderId,
      title,
      content,
      format: 'markdown',
      tags: ['workflow'],
      metadata: { source: 'workflow' },
    });
    return { saved: true, documentId: Number(result[0].insertId), title };
  },

  'text-extract': async (config) => {
    const text = String(config.text ?? '');
    return { extracted: text.slice(0, 200), length: text.length };
  },

  'find-similar': async (config) => {
    const query = String(config.query ?? '').trim();
    if (!query) return skipped('find-similar 需要配置 query');
    const limit = Math.min(Math.max(Number(config.limit ?? 10), 1), 50);
    const response = await executeHybridSearch({ query, mode: 'hybrid', limit });
    return {
      query,
      matches: response.results.map((r) => ({
        id: r.id,
        title: r.title,
        snippet: r.snippet,
        type: r.type,
        score: r.score,
      })),
    };
  },

  'create-link': async (config) => {
    const sourceId = Number(config.sourceId ?? 0);
    const targetId = Number(config.targetId ?? 0);
    if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(targetId) || targetId <= 0) {
      return skipped('create-link 需要配置数值型 sourceId 与 targetId');
    }
    const label = typeof config.label === 'string' && config.label.trim() ? config.label.slice(0, 255) : null;
    const db = getDb();
    // 幂等：已存在同向边则不重复插入
    const existing = await db.select({ id: knowledgeEdges.id }).from(knowledgeEdges)
      .where(and(eq(knowledgeEdges.sourceId, sourceId), eq(knowledgeEdges.targetId, targetId)));
    if (existing.length > 0) {
      return { sourceId, targetId, edgeId: existing[0].id, deduplicated: true };
    }
    const result = await db.insert(knowledgeEdges).values({
      sourceId,
      targetId,
      label,
      type: 'related',
    });
    return { sourceId, targetId, edgeId: Number(result[0].insertId), created: true };
  },

  'call-agent': async (config) => executeCallAgent(config),

  'notify-agent': async () => skipped('notify-agent 尚未实现真实通知通道'),

  'file-upload': async () => skipped('file-upload 尚未实现（请使用数据摄入页面上传文件）'),

  cron: async () => skipped('cron 为触发器节点，由调度器处理，运行时跳过'),

  webhook: async () => skipped('webhook 为触发器节点，由调度器处理，运行时跳过'),

  keywords: async (config) => {
    const text = String(config.text ?? '');
    if (!text.trim()) return skipped('keywords 需要配置 text');
    const maxKeywords = Math.min(Math.max(Number(config.maxKeywords ?? 10), 1), 100);
    // auto 模式：LLM 抽取优先，失败自动回退内部分词（keyword-extractor 内置）
    const results = await extractKeywords(text, 'auto', maxKeywords);
    return { keywords: results.map((r) => r.word) };
  },

  summarize: async (config) => {
    const text = String(config.text ?? '');
    if (!text.trim()) return skipped('summarize 需要配置 text');
    const result = await chatCompletion(
      `请将以下内容总结为不超过 3 句话的摘要，直接输出摘要正文：\n\n${text.slice(0, 6000)}`,
      { maxTokens: 400 },
    );
    if (!result) return skipped('未配置可用的 LLM（请在 Agent 管理或环境变量中配置），无法生成摘要');
    return { summary: result.content, model: result.model };
  },

  vectorize: async (config) => {
    const text = String(config.text ?? '');
    if (!text.trim()) return skipped('vectorize 需要配置 text');
    try {
      // 真实调用嵌入服务生成向量（入库请使用数据摄入流程；此处验证并产出向量维度）
      const vectors = await embedTexts([text]);
      return {
        model: typeof config.model === 'string' ? config.model : undefined,
        dimensions: vectors[0]?.length ?? 0,
        vectorized: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not configured/i.test(message)) return skipped('未配置嵌入模型，无法向量化');
      throw err;
    }
  },

  'send-notification': async () => skipped('send-notification 尚未实现真实通知渠道'),
};

/** 单节点执行入口（供测试与调度复用）。 */
export async function executeNode(
  type: string,
  config: Record<string, unknown>,
  ctx: NodeExecutionContext,
): Promise<Record<string, unknown>> {
  const executor = nodeExecutors[type] ?? nodeExecutors['save-result'];
  return executor(config, ctx);
}

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
      // 含 skipped 字段的输出：节点状态记 "skipped"（schema 枚举原生支持），不再伪装成功
      const status = output && typeof (output as Record<string, unknown>).skipped === "string" ? "skipped" : "completed";
      await db.update(workflowRunNodes).set({ status, output, completedAt: new Date() }).where(eq(workflowRunNodes.id, nodeRunId));
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
