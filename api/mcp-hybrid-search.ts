import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { executeHybridSearch, searchInputSchema } from "./lib/hybrid-search";

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

export const hybridSearchTool: McpTool = {
  name: "search.hybrid",
  description:
    "Hybrid search across knowledge graph nodes and indexed document chunks. Uses keyword DB search and vector semantic search with Reciprocal Rank Fusion.",
  annotations: { title: "混合检索（关键词+向量）", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query text (max 500 chars)" },
      mode: { type: "string", description: "Search mode", enum: ["keyword", "vector", "hybrid"] },
      limit: { type: "number", description: "Maximum number of results (1-50, default 10)" },
      filters: { type: "object", description: "Optional filters: type, folder, tags" },
    },
    required: ["query"],
  },
};

export async function handleHybridSearch(
  args: Record<string, unknown>,
  auth: AuthInfo,
): Promise<McpToolResult> {
  assertScope(auth, "knowledge:read");
  const input = searchInputSchema.parse(args);
  const result = await executeHybridSearch(input);
  return textResult(result);
}
