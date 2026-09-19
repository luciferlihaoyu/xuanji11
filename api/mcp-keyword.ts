import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { extractInputSchema, extractKeywords } from "./lib/keyword-extractor";
import { autoTagInputSchema, autoTagDocument } from "./lib/keyword-auto-tag";

// 工具类型统一来自 mcp-server（类型导入编译期擦除，不构成运行时循环依赖）。
// 单一来源的好处：annotations 为必填，新增工具漏写注解会被类型门禁拦下。
import type { McpTool } from "./mcp-server";
export type { McpTool };

// 注解如实性：keywords.extract 的 mode=llm/auto 与 keywords.autoTag（内部走 extractKeywords(...,"auto")）
// 都会 fetch 外部 LLM 端点（见 lib/keyword-extractor.ts），因此 openWorldHint 必须为 true——
// 否则客户端会误判为纯本地调用而自动放行。

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

async function handleKeywordsExtract(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "knowledge:read");
  const input = extractInputSchema.parse(args);
  const keywords = await extractKeywords(input.text, input.mode, input.maxKeywords);
  return textResult({ keywords });
}

async function handleKeywordsAutoTag(
  args: Record<string, unknown>,
  auth: AuthInfo,
  userId: number | null,
): Promise<McpToolResult> {
  assertScope(auth, "knowledge:write");
  const input = autoTagInputSchema.parse(args);
  const result = await autoTagDocument(input.documentId, 10, userId);
  return textResult(result);
}

export const keywordTools: readonly McpTool[] = [
  {
    name: "keywords.extract",
    description: "Extract keywords from text using internal frequency analysis or LLM when configured. Returns ranked keywords with scores.",
    annotations: { title: "抽取关键词", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to extract keywords from" },
        mode: { type: "string", description: "Extraction mode: internal, llm, or auto", enum: ["internal", "llm", "auto"] },
        maxKeywords: { type: "number", description: "Maximum number of keywords to return (1-100, default 10)" },
      },
      required: ["text"],
    },
  },
  {
    name: "keywords.autoTag",
    description: "Extract keywords from a knowledge base document and create tag nodes linked to the document.",
    annotations: { title: "自动打标签", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "number", description: "Knowledge base document id" },
      },
      required: ["documentId"],
    },
  },
];

export async function handleKeywordTool(
  name: string,
  args: Record<string, unknown>,
  auth: AuthInfo,
  userId: number | null,
): Promise<McpToolResult> {
  switch (name) {
    case "keywords.extract": return handleKeywordsExtract(args, auth);
    case "keywords.autoTag": return handleKeywordsAutoTag(args, auth, userId);
    default: return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
