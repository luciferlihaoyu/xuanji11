import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { extractInputSchema, extractKeywords } from "./lib/keyword-extractor";
import { autoTagInputSchema, autoTagDocument } from "./lib/keyword-auto-tag";

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
    inputSchema: {
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
    inputSchema: {
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
