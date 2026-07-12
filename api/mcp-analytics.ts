import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { getAnalyticsData } from "./analytics-router";

export interface McpTool {
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

export const analyticsTool: McpTool = {
  name: "analytics.get",
  description: "Get knowledge base analytics including totals, top tags, recent nodes, and orphan nodes.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export async function handleAnalyticsTool(
  _args: Record<string, unknown>,
  auth: AuthInfo,
): Promise<McpToolResult> {
  assertScope(auth, "knowledge:read");
  const data = await getAnalyticsData();
  return textResult(data);
}
