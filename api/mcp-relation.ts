import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { discoverInputSchema, discoverRelations } from "./lib/relation-analyzer";

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

async function handleRelationsDiscover(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "knowledge:read");
  const input = discoverInputSchema.parse(args);
  const result = await discoverRelations(input);
  return textResult(result);
}

export const relationTools: readonly McpTool[] = [
  {
    name: "relations.discover",
    description:
      "Discover hidden relationships for a knowledge base document using co-occurrence, vector, and reference strategies.",
    inputSchema: {
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
];

export async function handleRelationTool(
  name: string,
  args: Record<string, unknown>,
  auth: AuthInfo,
): Promise<McpToolResult> {
  switch (name) {
    case "relations.discover":
      return handleRelationsDiscover(args, auth);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
