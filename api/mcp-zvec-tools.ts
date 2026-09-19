import { z } from "zod";
import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import * as vectorService from "./lib/vector-service";

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

function textResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function handleZvecEmbed(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "zvec:read");
  const input = z.object({ texts: z.array(z.string().min(1)).max(100) }).parse(args);
  const vectors = await vectorService.embedTexts(input.texts);
  return textResult({ vectors });
}

async function handleZvecSearch(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "zvec:read");
  const input = z.object({ query: z.string().min(1).max(500), topK: z.number().int().min(1).max(50).default(10) }).parse(args);
  const results = await vectorService.searchVectors(input.query, input.topK);
  return textResult({ results });
}

async function handleZvecStats(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "zvec:read");
  z.object({}).parse(args);
  const stats = await vectorService.getStats();
  return textResult(stats);
}

async function handleZvecListCollections(_args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "zvec:read");
  const collections = await vectorService.listCollections();
  return textResult({ collections });
}

async function handleZvecAddDocuments(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "zvec:write");
  const documentSchema = z.object({ content: z.string().min(1).max(100_000), metadata: z.record(z.string(), z.unknown()).optional() });
  const input = z.object({
    name: z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/),
    documents: z.array(documentSchema).min(1).max(100),
  }).parse(args);
  const result = await vectorService.addDocumentsToCollection(input.name, input.documents);
  return textResult(result);
}

async function handleZvecDeleteCollection(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "zvec:write");
  const input = z.object({ name: z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/) }).parse(args);
  await vectorService.deleteCollection(input.name);
  return textResult({ success: true });
}

export const zvecTools: readonly McpTool[] = [
  { name: "zvec.embed", description: "Generate vector embeddings for one or more texts. Use this to turn raw text into dense vectors for similarity comparisons.", annotations: { title: "文本向量化", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, inputSchema: { type: "object", properties: { texts: { type: "array", description: "Array of texts to embed (max 100)" } }, required: ["texts"] } },
  { name: "zvec.search", description: "Semantic search over indexed document chunks. Use this to find the most relevant chunks for a user question.", annotations: { title: "向量语义检索", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query text" }, topK: { type: "number", description: "Maximum number of results (1-50, default 10)" } }, required: ["query"] } },
  { name: "zvec.stats", description: "Get ZVec vector engine status and health. Use this to check whether the vector engine is ready and how many documents are indexed.", annotations: { title: "向量引擎状态", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: {} } },
  { name: "zvec.listCollections", description: "List all ZVec vector collections. Use this to discover available collections before adding or searching documents.", annotations: { title: "列出向量集合", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: {} } },
  { name: "zvec.addDocuments", description: "Add documents to a ZVec collection and make them immediately searchable. Requires zvec:write scope. Each document must include content text; optional metadata is stored with the chunk.", annotations: { title: "向集合添加文档", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { name: { type: "string", description: "Target collection name (alphanumeric, underscores and dashes allowed)" }, documents: { type: "array", description: "Array of documents to add (max 100). Each item: { content: string, metadata?: object }" } }, required: ["name", "documents"] } },
  { name: "zvec.deleteCollection", description: "Delete a ZVec collection by name. Requires zvec:write scope. This removes the collection metadata and associated documents.", annotations: { title: "删除向量集合", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { name: { type: "string", description: "Collection name to delete (alphanumeric, underscores and dashes allowed)" } }, required: ["name"] } },
];

export async function handleZvecTool(name: string, args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  switch (name) {
    case "zvec.embed": return handleZvecEmbed(args, auth);
    case "zvec.search": return handleZvecSearch(args, auth);
    case "zvec.stats": return handleZvecStats(args, auth);
    case "zvec.listCollections": return handleZvecListCollections(args, auth);
    case "zvec.addDocuments": return handleZvecAddDocuments(args, auth);
    case "zvec.deleteCollection": return handleZvecDeleteCollection(args, auth);
    default: return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
