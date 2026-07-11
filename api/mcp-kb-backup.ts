import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { exportKnowledgeBase, importKnowledgeBase } from "./lib/kb-backup";

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

export const kbBackupTools: readonly McpTool[] = [
  {
    name: "kb.export",
    description: "Export the full knowledge base as a structured JSON backup, including knowledge graph nodes, edges, and knowledge base documents.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kb.import",
    description: "Import a knowledge base backup from structured JSON. Requires knowledge:write scope. Existing rows with the same id are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string", description: "Backup version string (e.g. 1.0)" },
        exportedAt: { type: "string", description: "Optional ISO timestamp of the original export" },
        data: { type: "object", description: "Backup payload containing nodes, edges, and documents arrays" },
      },
      required: ["version", "data"],
    },
  },
];

export async function handleKbBackupTool(name: string, args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  switch (name) {
    case "kb.export":
      assertScope(auth, "knowledge:read");
      return textResult(await exportKnowledgeBase());
    case "kb.import":
      assertScope(auth, "knowledge:write");
      return textResult(await importKnowledgeBase(args));
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
