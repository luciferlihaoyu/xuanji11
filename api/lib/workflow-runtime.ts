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
    // targetFolderId 0/缺省 = 根目录（folderId null）；>0 指定文件夹
    const rawFolderId = Number(config.targetFolderId ?? 0);
    const folderId = Number.isInteger(rawFolderId) && rawFolderId > 0 ? rawFolderId : null;
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
    const documentId = Number(result.lastInsertRowid);
    // 必须走索引：直接插库会产生「有内容但未索引」的文档，检索不到且每日巡检持续报红
    // （线上实证：巡检/建边/去重/聚类四类报告每天新增 2 篇，长期累积）。
    // 索引失败不阻断工作流（报告本身已落盘有价值），但要如实标注，别假装成功。
    try {
      const { indexDocumentById } = await import('./document-indexer');
      const indexed = await indexDocumentById(documentId);
      return { saved: true, documentId, title, indexed: true, chunks: indexed.chunks };
    } catch (err) {
      const indexError = err instanceof Error ? err.message : String(err);
      console.warn(`[WorkflowRuntime] save-result 已落盘但索引失败 documentId=${documentId}: ${indexError}`);
      return { saved: true, documentId, title, indexed: false, indexError };
    }
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
    return { sourceId, targetId, edgeId: Number(result.lastInsertRowid), created: true };
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

  summarize: async (config, ctx) => {
    let text = String(config.text ?? '');
    // 无 text 时尝试按 documentId 加载文档内容（document-created 事件流）
    if (!text.trim()) {
      const documentId = Number(config.documentId ?? ctx.input.documentId ?? 0);
      if (documentId > 0) {
        const db = getDb();
        const { kbDocuments: kbDocs } = await import("@db/schema");
        const doc = await db.select({ title: kbDocs.title, content: kbDocs.content })
          .from(kbDocs).where(eq(kbDocs.id, documentId)).limit(1);
        if (doc[0]) text = `${doc[0].title}\n${doc[0].content ?? ''}`;
      }
    }
    if (!text.trim()) return skipped('summarize 需要 text 或 documentId');
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

  // ---- 新增：知识加工四节点（把 BM25/分拣/聚类/建边接进工作流）----

  /** 自动建边：语义相似度连接知识孤岛（复用 autoLinkEdgesCore） */
  'auto-link': async (config) => {
    const threshold = Math.min(Math.max(Number(config.threshold ?? 0.62), 0.3), 0.95);
    const maxPerNode = Math.min(Math.max(Number(config.maxPerNode ?? 3), 1), 10);
    const dryRun = config.dryRun === true; // 工作流默认真建（dryRun 需显式开启）
    const { autoLinkEdgesCore } = await import("./auto-link");
    const result = await autoLinkEdgesCore({ threshold, maxPerNode, dryRun });
    return {
      created: result.created,
      considered: result.considered,
      isolated: result.isolated,
      totalCandidates: result.totalCandidates,
      dryRun,
    };
  },

  /** 索引一致性巡检：对账 docs/chunks/FTS/vector/图谱，输出健康报告 */
  'index-health': async () => {
    const { checkIndexHealth } = await import("./index-health");
    return checkIndexHealth() as unknown as Record<string, unknown>;
  },

  /** 去重扫描：发现疑似重复组写入收件箱（只建议不删除） */
  'dedup-scan': async () => {
    const { scanDuplicatesToInbox } = await import("./dedup-detector");
    const result = await scanDuplicatesToInbox();
    return { groups: result.groups, created: result.created };
  },

  /** 语义聚类：全文档 KMeans++ → 主题群（只读分析，报告交给下游 save-result） */
  cluster: async (config) => {
    const k = config.k !== undefined ? Math.min(Math.max(Number(config.k), 3), 24) : undefined;
    const labelWithLlm = config.labelWithLlm !== false;
    const { clusterDocuments } = await import("./doc-clusterer");
    const result = await clusterDocuments(k, labelWithLlm);
    return {
      totalDocs: result.totalDocs,
      k: result.k,
      llmLabeled: result.llmLabeled,
      clusters: result.clusters.map((c) => ({ label: c.label, size: c.size, docTitles: c.docTitles })),
    };
  },

  /** 入库分拣：对指定文档跑 LLM 建议并直接落库（无人工确认——工作流场景） */
  'ingest-triage': async (config, ctx) => {
    const documentId = Number(config.documentId ?? ctx.input.documentId ?? 0);
    if (!Number.isInteger(documentId) || documentId <= 0) {
      return skipped('ingest-triage 需要 documentId（config 或工作流输入）');
    }
    const db = getDb();
    const { kbDocuments: kbDocs } = await import("@db/schema");
    const doc = await db.select({ title: kbDocs.title, content: kbDocs.content })
      .from(kbDocs).where(eq(kbDocs.id, documentId)).limit(1);
    if (!doc[0]) return skipped(`文档不存在: ${documentId}`);

    const { suggestIngestion } = await import("./ingestion-suggester");
    const suggestion = await suggestIngestion(doc[0].title, doc[0].content ?? "");
    if (suggestion.skipped) return skipped(`分拣不可用: ${suggestion.reason ?? 'LLM 未配置'}`);

    // 启发式置信度（suggester 不返回置信度时的代理指标）：
    // 命中既有文件夹 +0.5 / 仅建议新建文件夹 +0.35 / 无文件夹建议 +0.2
    // 标签 2-5 个 +0.25，0-1 个 +0.1；有概念 +0.1
    let confidence = 0.2;
    if (suggestion.folderId) confidence += 0.5;
    else if (suggestion.newFolderName?.trim()) confidence += 0.35;
    confidence += suggestion.tags.length >= 2 ? 0.25 : suggestion.tags.length >= 1 ? 0.1 : 0;
    if (suggestion.concepts.length > 0) confidence += 0.1;
    confidence = Math.min(1, confidence);

    const autoThreshold = Math.min(Math.max(Number(config.autoApplyThreshold ?? 0.85), 0), 1);

    // 置信度分流：低于阈值不自动落库，进收件箱等人工确认
    if (confidence < autoThreshold) {
      const { kbReviewItems: reviewItems } = await import("@db/schema");
      await db.insert(reviewItems).values({
        kind: "triage",
        documentId,
        title: `分拣待确认（置信度 ${confidence.toFixed(2)}）：${doc[0].title.slice(0, 40)}`,
        payload: {
          suggestedFolderId: suggestion.folderId,
          suggestedNewFolderName: suggestion.newFolderName ?? null,
          suggestedTags: suggestion.tags,
          concepts: suggestion.concepts,
        },
        confidence,
      });
      return { documentId, routedToInbox: true, confidence };
    }

    // 高置信度：直接落库
    const { knowledgeNodes: kNodes, knowledgeEdges: kEdges, kbFolders: kbF } = await import("@db/schema");
    let folderId = suggestion.folderId;
    if (!folderId && suggestion.newFolderName?.trim()) {
      const f = await db.insert(kbF).values({ name: suggestion.newFolderName.trim() });
      folderId = Number(f.lastInsertRowid);
    }
    await db.update(kbDocs).set({ folderId: folderId ?? null, tags: suggestion.tags })
      .where(eq(kbDocs.id, documentId));

    // 概念实体节点 + contains 边
    const { sql } = await import("drizzle-orm");
    const docNode = await db.select({ id: kNodes.id }).from(kNodes)
      .where(sql`json_extract(${kNodes.metadata}, '$.documentId') = ${String(documentId)}`).limit(1);
    const docNodeId = docNode[0]?.id;
    let createdNodes = 0;
    for (const c of suggestion.concepts) {
      const dup = await db.select({ id: kNodes.id }).from(kNodes)
        .where(sql`${kNodes.title} = ${c.title} AND ${kNodes.type} = ${c.type}`).limit(1);
      let nodeId: number;
      if (dup[0]) {
        nodeId = dup[0].id;
      } else {
        const r = await db.insert(kNodes).values({
          title: c.title, content: c.summary, type: c.type,
          metadata: { source: "workflow-triage", documentId: String(documentId) },
        });
        nodeId = Number(r.lastInsertRowid);
        createdNodes++;
      }
      if (docNodeId) {
        const edgeExists = await db.select({ id: kEdges.id }).from(kEdges)
          .where(sql`${kEdges.sourceId} = ${nodeId} AND ${kEdges.targetId} = ${docNodeId}`).limit(1);
        if (!edgeExists[0]) {
          await db.insert(kEdges).values({ sourceId: nodeId, targetId: docNodeId, label: "contains", type: "contains", weight: 1 });
        }
      }
    }
    return { documentId, folderId, tags: suggestion.tags, conceptsCreated: createdNodes, confidence, autoApplied: true };
  },

  /** 更新文档：把工作流产出（如摘要）写回文档 */
  'update-document': async (config, ctx) => {
    const documentId = Number(config.documentId ?? ctx.input.documentId ?? 0);
    if (!Number.isInteger(documentId) || documentId <= 0) {
      return skipped('update-document 需要 documentId');
    }
    const db = getDb();
    const { kbDocuments: kbDocs } = await import("@db/schema");
    const doc = await db.select({ content: kbDocs.content }).from(kbDocs)
      .where(eq(kbDocs.id, documentId)).limit(1);
    if (!doc[0]) return skipped(`文档不存在: ${documentId}`);

    // 写入前快照旧版本（workflow 自动改文档也可回溯）
    try {
      const { snapshotDocumentVersion } = await import("./doc-versioning");
      await snapshotDocumentVersion(documentId, "workflow", "update-document");
    } catch { /* 快照失败不阻塞 */ }

    // mode: prepend（头部插入，如摘要）| replace | append
    const mode = String(config.mode ?? 'prepend');
    const newContent = String(config.content ?? ctx.input.summary ?? '');
    if (!newContent.trim()) return skipped('update-document 无内容可写（config.content 或上游 summary）');

    let final: string;
    if (mode === 'replace') {
      final = newContent;
    } else if (mode === 'append') {
      final = (doc[0].content ?? '') + '\n\n' + newContent;
    } else {
      final = newContent + '\n\n---\n\n' + (doc[0].content ?? '');
    }
    await db.update(kbDocs).set({ content: final }).where(eq(kbDocs.id, documentId));
    return { documentId, mode, contentLength: final.length };
  },
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
  const runId = Number(runResult.lastInsertRowid);

  const nodeResultRows = new Map<number, number>();
  // 逐行插入拿准确 id——better-sqlite3 批量 insert 的 lastInsertRowid 是【末行】 id，
  // 与 MySQL（首行）相反。MySQL→SQLite 迁移后这里错位：节点状态/输出写错行，
  // 前面的节点永远停在 pending。逐行插换正确性（节点数通常 <50，N 次插入无压力）。
  for (const node of sorted) {
    const r = await db.insert(workflowRunNodes).values({
      runId,
      nodeId: node.id,
      status: "pending" as const,
      input: {} as Record<string, unknown>,
      output: {} as Record<string, unknown>,
      error: null as string | null,
    });
    nodeResultRows.set(node.id, Number(r.lastInsertRowid));
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
      // 数据流：把工作流输入 + 截至目前的上游输出（浅合并，后者优先）传给本节点。
      // 这样 summarize 的 { summary } 能被下游 update-document 经 ctx.input.summary 读到。
      const upstreamMerged = Object.assign({}, ...Object.values(outputs));
      const nodeInput = { ...runInput, ...upstreamMerged };
      const output = await executor(config, { input: nodeInput, outputs });
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
