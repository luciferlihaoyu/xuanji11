import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { executeHybridSearch, searchInputSchema } from "./lib/hybrid-search";

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, { type: string; description: string; enum?: string[] }>;
    readonly required?: string[];
  };
}

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
  inputSchema: {
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
