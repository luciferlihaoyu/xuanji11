/**
 * 璇玑 connector 动作层 — 供天宫/外部系统通过 connector 路由调用。
 * 契约：tiangong-xuanji-integration-contract.md（§3 / §7 / §10）
 */

import { z } from "zod";
import { eq, like, desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbDocuments, knowledgeNodes, knowledgeEdges } from "@db/schema";
import { executeHybridSearch } from "./hybrid-search";
import { tryIndexDocumentById } from "./document-indexer";
import { createIngestionJob, type IngestionSourceType } from "./ingestion";

// ==================== 契约输入/输出 Schema ====================

export const traceSchema = z.object({
  taskId: z.string().optional(),
  traceId: z.string().optional(),
  agentId: z.string().optional(),
  originSystem: z.string().optional(),
});
export type TraceInput = z.infer<typeof traceSchema>;

export const searchContextInputSchema = z.object({
  query: z.string().min(1).max(500),
  mode: z.enum(["keyword", "vector", "hybrid"]).default("hybrid"),
  limit: z.number().int().min(1).max(50).default(8),
  filters: z.object({
    project: z.string().optional(),
    tags: z.array(z.string()).optional(),
    types: z.array(z.string()).optional(),
  }).optional(),
  trace: traceSchema.optional(),
});

export const writeTaskMemoryInputSchema = z.object({
  task: z.object({
    taskId: z.string(),
    traceId: z.string().optional(),
    name: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
    agentId: z.string().optional(),
  }),
  memory: z.object({
    project: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    contentMarkdown: z.string().optional(),
    tags: z.array(z.string()).optional(),
    decisions: z.array(z.object({ title: z.string(), reason: z.string() })).optional(),
    artifacts: z.array(z.object({ type: z.string(), name: z.string(), artifactRef: z.string() })).optional(),
  }),
  trace: traceSchema.optional(),
});

export const linkArtifactInputSchema = z.object({
  taskId: z.string(),
  traceId: z.string().optional(),
  documentId: z.number().int().positive(),
  artifact: z.object({
    artifactRef: z.string(),
    downloadUrl: z.string().optional(),
    mimeType: z.string().optional(),
    sha256: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  }),
  trace: traceSchema.optional(),
});

export const getMemoryDigestInputSchema = z.object({
  project: z.string(),
  scope: z.enum(["project", "all"]).default("project"),
  maxTokens: z.number().int().min(100).max(20000).default(4000),
  trace: traceSchema.optional(),
});

export const startIngestionInputSchema = z.object({
  sourceType: z.enum(["upload", "datasource", "backup", "manual"]),
  source: z.object({
    kind: z.string(),
    path: z.string().optional(),
    dataSourceId: z.number().int().positive().optional(),
  }),
  options: z.object({
    project: z.string().optional(),
    tags: z.array(z.string()).optional(),
    vectorize: z.boolean().default(true),
    discoverRelations: z.boolean().default(false),
  }).optional(),
  trace: traceSchema.optional(),
});

// ==================== 工具函数 ====================

function buildDigestFromRows(rows: readonly { title: string; content: string | null }[], maxTokens: number): string {
  const budget = Math.max(200, maxTokens * 4); // 粗略按 4 字符/token
  let used = 0;
  const parts: string[] = [];
  for (const row of rows) {
    const snippet = (row.content ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    const block = `## ${row.title}\n${snippet}`;
    if (used + block.length > budget) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n") || "暂无可用记忆内容。";
}

// ==================== 5 个 connector 动作 ====================

/** 1. searchContext — 混合检索 + 图谱提示 + 记忆摘要 */
export async function searchContext(input: z.infer<typeof searchContextInputSchema>) {
  const db = getDb();
  const search = await executeHybridSearch({
    query: input.query,
    mode: input.mode,
    limit: input.limit,
    filters: input.filters,
  });

  // 契约要求数值型 documentId / chunkId（tiangong-xuanji-integration-contract）。
  // hybrid search 的 id 是字符串（可能是纯数字或复合 id），这里尽力解析；
  // 无法解析出数值的条目直接跳过，避免破坏下游 schema 校验。
  const results = search.results.flatMap((r) => {
    const nums = r.id.match(/\d+/g)?.map(Number) ?? [];
    if (nums.length === 0) return [];
    const documentId = nums[0];
    const chunkId = nums[nums.length - 1];
    return [{
      kind: "document_chunk" as const,
      documentId,
      chunkId,
      title: (r.title || "未命名").slice(0, 500),
      snippet: (r.snippet || r.title || "无摘要").slice(0, 5000),
      score: r.score,
      source: r.sources.join(",").slice(0, 100) || "hybrid",
    }];
  });

  // 图谱提示：从节点标题/内容做 LIKE 匹配
  const q = `%${input.query}%`;
  const graphRows = await db
    .select({ id: knowledgeNodes.id, title: knowledgeNodes.title, type: knowledgeNodes.type })
    .from(knowledgeNodes)
    .where(like(knowledgeNodes.title, q))
    .limit(6);
  const graphHints = graphRows.map((n) => ({ nodeId: n.id, title: n.title, type: n.type }));

  // 记忆摘要：取与查询相关的最近文档
  const docs = await db
    .select({ title: kbDocuments.title, content: kbDocuments.content })
    .from(kbDocuments)
    .where(like(kbDocuments.title, q))
    .orderBy(desc(kbDocuments.updatedAt))
    .limit(4);

  return {
    results,
    graphHints,
    memoryDigest: buildDigestFromRows(docs, 2000),
    trace: input.trace ?? null,
  };
}

/** 2. writeTaskMemory — 任务记忆落库 + 建图 + 向量化 */
export async function writeTaskMemory(input: z.infer<typeof writeTaskMemoryInputSchema>) {
  const db = getDb();
  const { task, memory } = input;

  // 2.1 建 kb_document
  const artifactRefs = (memory.artifacts ?? []).map((a) => a.artifactRef);
  const docValues = {
    folderId: null,
    title: memory.title,
    content: memory.contentMarkdown ?? memory.summary ?? "",
    format: "markdown" as const,
    tags: memory.tags ?? [],
    metadata: {
      source: "tiangong_task",
      taskId: task.taskId,
      traceId: task.traceId ?? null,
      agentId: task.agentId ?? null,
      project: memory.project,
      taskType: task.type ?? null,
      artifactRefs,
      vectorized: false,
    },
    createdBy: null,
  };
  const docResult = await db.insert(kbDocuments).values(docValues as never);
  const documentId = Number(docResult[0].insertId);

  // 2.2 建 document 节点
  const docNodeResult = await db.insert(knowledgeNodes).values({
    title: memory.title,
    content: memory.summary ?? "",
    type: "document",
    posX: 0,
    posY: 0,
    style: {},
    metadata: {
      sourceSystem: "tiangong",
      externalType: "task",
      externalId: task.taskId,
      traceId: task.traceId ?? null,
      documentId: String(documentId),
    },
    createdBy: null,
  });
  const docNodeId = Number(docNodeResult[0].insertId);

  // 2.3 建 project 节点（不存在才建）
  const existingProject = await db
    .select({ id: knowledgeNodes.id })
    .from(knowledgeNodes)
    .where(eq(knowledgeNodes.title, memory.project));
  let projectNodeId = existingProject[0]?.id;
  if (!projectNodeId) {
    const pr = await db.insert(knowledgeNodes).values({
      title: memory.project,
      content: `项目记忆空间：${memory.project}`,
      type: "topic",
      posX: 0,
      posY: 0,
      style: {},
      metadata: { sourceSystem: "tiangong", externalType: "project", externalId: memory.project },
      createdBy: null,
    });
    projectNodeId = Number(pr[0].insertId);
  }

  // 2.4 建边：project contains document
  const edgeResult = await db.insert(knowledgeEdges).values({
    sourceId: projectNodeId,
    targetId: docNodeId,
    label: "contains",
    type: "contains",
    weight: 1,
    createdBy: null,
  });
  const edgeId = Number(edgeResult[0].insertId);

  // 2.5 向量化（失败不阻断）
  const indexed = await tryIndexDocumentById(documentId);
  await db
    .update(kbDocuments)
    .set({ metadata: { ...docValues.metadata, vectorized: indexed.chunks > 0 } })
    .where(eq(kbDocuments.id, documentId));

  return {
    documentId,
    nodeIds: [docNodeId, projectNodeId],
    edgeIds: [edgeId],
    chunkCount: indexed.chunks,
    vectorized: indexed.chunks > 0,
  };
}

/** 3. linkArtifact — 文档关联制品节点 */
export async function linkArtifact(input: z.infer<typeof linkArtifactInputSchema>) {
  const db = getDb();
  const { documentId, artifact } = input;

  // 3.1 建 artifact entity 节点
  const nodeResult = await db.insert(knowledgeNodes).values({
    title: artifact.artifactRef,
    content: artifact.downloadUrl ?? artifact.artifactRef,
    type: "entity",
    posX: 0,
    posY: 0,
    style: {},
    metadata: {
      sourceSystem: "tiangong",
      externalType: "artifact",
      externalId: artifact.artifactRef,
      taskId: input.taskId,
      traceId: input.traceId ?? null,
      mimeType: artifact.mimeType ?? null,
      sha256: artifact.sha256 ?? null,
      size: artifact.size ?? null,
    },
    createdBy: null,
  });
  const nodeId = Number(nodeResult[0].insertId);

  // 3.2 document -> artifact references 边
  const edgeResult = await db.insert(knowledgeEdges).values({
    sourceId: documentId,
    targetId: nodeId,
    label: "references",
    type: "references",
    weight: 1,
    createdBy: null,
  });
  const edgeId = Number(edgeResult[0].insertId);

  return { linked: true, nodeId, edgeId };
}

/** 4. getMemoryDigest — 项目记忆摘要 */
export async function getMemoryDigest(input: z.infer<typeof getMemoryDigestInputSchema>) {
  const db = getDb();
  const { project, scope, maxTokens } = input;

  const rows = await db
    .select({ id: kbDocuments.id, title: kbDocuments.title, content: kbDocuments.content, metadata: kbDocuments.metadata })
    .from(kbDocuments)
    .orderBy(desc(kbDocuments.updatedAt))
    .limit(20);

  const projectRows = scope === "project"
    ? rows.filter((r) => {
        const meta = r.metadata as Record<string, unknown> | null;
        return meta?.project === project;
      })
    : rows;

  // 决策/风险：从内容中粗提取含「决策/风险/结论」的片段
  const keyDecisions: string[] = [];
  const openRisks: string[] = [];
  for (const row of projectRows) {
    const text = (row.content ?? "").slice(0, 2000);
    const dm = text.match(/决策[:：]\s*([^\n]+)/);
    if (dm) keyDecisions.push(dm[1].trim());
    const rm = text.match(/风险[:：]\s*([^\n]+)/);
    if (rm) openRisks.push(rm[1].trim());
  }

  return {
    digest: buildDigestFromRows(projectRows, maxTokens),
    keyDecisions: keyDecisions.slice(0, 10),
    openRisks: openRisks.slice(0, 10),
    sourceDocumentIds: projectRows.map((r) => r.id),
  };
}

/** 5. startIngestion — 创建入库任务（异步由既有 ingestion 管道处理） */
export async function startIngestion(input: z.infer<typeof startIngestionInputSchema>) {
  const jobId = await createIngestionJob(
    input.sourceType as IngestionSourceType,
    input.source.path ?? (input.source.dataSourceId ? String(input.source.dataSourceId) : undefined),
    null,
  );
  return {
    jobId,
    status: "pending" as const,
    itemCount: 0,
    trace: input.trace ?? null,
  };
}
