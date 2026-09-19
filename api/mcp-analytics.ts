import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { getAnalyticsData } from "./analytics-router";

// 工具类型统一来自 mcp-server（类型导入编译期擦除，不构成运行时循环依赖）
// 单一来源的好处：annotations 为必填，新增工具漏写注解会被类型门禁拦下
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

export const analyticsTool: McpTool = {
  name: "analytics.get",
  description: "Get knowledge base analytics including totals, top tags, recent nodes, and orphan nodes.",
  annotations: { title: "知识库统计", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: {
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
