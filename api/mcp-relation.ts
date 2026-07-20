import { z } from "zod";
import { knowledgeEdges, type User } from "@db/schema";
import type { AuthInfo } from "./lib/auth";
import { hasScope } from "./lib/auth";
import { discoverInputSchema, discoverRelations } from "./lib/relation-analyzer";
import { getDb } from "./queries/connection";
import { clean } from "./lib/clean";

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
  }).parse(args);
  const result = await getDb().insert(knowledgeEdges).values(clean({ ...input, createdBy: user.id }));
  return textResult({ id: Number(result[0].insertId) });
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
  {
    name: "relations.create",
    description:
      "Create an edge (relationship) between two knowledge graph nodes.",
    inputSchema: {
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
    case "relations.create":
      if (!user) return { content: [{ type: "text", text: "User authentication required" }], isError: true };
      return handleRelationsCreate(args, user, auth);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
