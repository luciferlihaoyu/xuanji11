import { z } from "zod";
import { knowledgeEdges, type User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { discoverInputSchema, discoverRelations } from "./lib/relation-analyzer";
import { getDb } from "./queries/connection";
import { clean } from "./lib/clean";
import { getBacklinks } from "./lib/backlinks";
import { insertEdge } from "./lib/edge-writer";

// 工具类型统一来自 mcp-server（类型导入编译期擦除，不构成运行时循环依赖）。
// 单一来源的好处：annotations 为必填，新增工具漏写注解会被类型门禁拦下。
import type { McpTool } from "./mcp-server";
export type { McpTool };

interface McpToolResult {
  readonly content: Array<{ type: "text"; text: string }>;
  readonly isError?: boolean;
}

function assertScope(auth: AuthInfo, scope: string): void {
  if (!hasScope(auth, scope)) throw new Error(`Missing required scope: ${scope}`);
}

const edgeTypeSchema = z.enum(["related", "contains", "references", "extends", "similar", "sequence"]);

function textResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function handleRelationsCreate(args: Record<string, unknown>, user: User, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "knowledge:write");
  const input = z.object({
    sourceId: z.number().int().positive(),
    targetId: z.number().int().positive(),
    label: z.string().max(255).optional(),
    type: edgeTypeSchema.default("related"),
    weight: z.number().default(1),
    // T4-01：这条边成立的依据（声明理由/原文摘录）。不给则以「操作者声明」入证——
    // 仍可追责到 createdBy，但无据编造语义的边从此没有静默通道。
    evidence: z.string().max(2000).optional(),
  }).parse(args);
  const { id } = await insertEdge(
    {
      sourceId: input.sourceId,
      targetId: input.targetId,
      label: input.label ?? null,
      type: input.type,
      weight: input.weight,
      createdBy: user.id,
      evidence: { text: input.evidence?.trim() || `人工声明（MCP relations.create by ${user.name}）：${input.label ?? input.type}` },
    },
    getDb(),
  );
  return textResult({ id });
}

async function handleRelationsDiscover(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "knowledge:read");
  const input = discoverInputSchema.parse(args);
  const result = await discoverRelations(input);
  return textResult(result);
}

async function handleRelationsBacklinks(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "knowledge:read");
  const input = z.object({ nodeId: z.number().int().positive() }).parse(args);
  const result = await getBacklinks(input.nodeId);
  if (!result) throw new Error(`Node ${input.nodeId} not found`);
  return textResult(result);
}

export const relationTools: readonly McpTool[] = [
  {
    name: "relations.backlinks",
    description:
      "Backlinks of a graph node, split by direction semantics: referencesIn only counts directed edge families (references/extends/contains/sequence); related/similar come back as undirectedNeighbors and NEVER as references.",
    annotations: { title: "节点反链（按类型分流）", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: {
      type: "object",
      properties: { nodeId: { type: "number", description: "knowledge_nodes.id" } },
      required: ["nodeId"],
    },
  },
  {
    name: "relations.discover",
    description:
      "Discover hidden relationships for a knowledge base document using co-occurrence, vector, and reference strategies.",
    annotations: { title: "发现图谱关系", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "number", description: "Knowledge base document id" },
        strategies: {
          type: "array",
          description: "Optional strategies: co-occurrence, vector, reference",
        },
        limit: { type: "number", description: "Maximum suggestions per request (default 20)" },
      },
      required: ["documentId"],
    },
  },
  {
    name: "relations.create",
    description:
      "Create an edge (relationship) between two knowledge graph nodes.",
    annotations: { title: "建立图谱关系", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "number", description: "Source knowledge node id" },
        targetId: { type: "number", description: "Target knowledge node id" },
        label: { type: "string", description: "Edge label" },
        type: { type: "string", description: "Edge type", enum: edgeTypeSchema.options as unknown as string[] },
        weight: { type: "number", description: "Edge weight (default 1)" },
      },
      required: ["sourceId", "targetId"],
    },
  },
];

export async function handleRelationTool(
  name: string,
  args: Record<string, unknown>,
  auth: AuthInfo,
  user?: User,
): Promise<McpToolResult> {
  switch (name) {
    case "relations.discover":
      return handleRelationsDiscover(args, auth);
    case "relations.backlinks":
      return handleRelationsBacklinks(args, auth);
    case "relations.create":
      if (!user) return { content: [{ type: "text", text: "User authentication required" }], isError: true };
      return handleRelationsCreate(args, user, auth);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
