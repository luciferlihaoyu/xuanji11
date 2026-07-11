import { desc, eq, like, or, and } from "drizzle-orm";
import { z } from "zod";
import {
  backupJobs,
  kbDocuments,
  knowledgeEdges,
  knowledgeNodes,
  workflows,
  type User,
} from "@db/schema";
import { clean } from "./lib/clean";
import { runDueBackupSchedules } from "./lib/backup-scheduler";
import { executeWorkflow } from "./lib/workflow-runtime";
import { zvecTools, handleZvecTool } from "./mcp-zvec-tools";
import { hybridSearchTool, handleHybridSearch } from "./mcp-hybrid-search";
import type { AuthenticatedIdentity, AuthInfo } from "./lib/auth";
import { authenticateApiKey, hasScope, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";

type JsonRpcId = string | number | null;

interface McpToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

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

type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

const knowledgeTypeSchema = z.enum(["concept", "document", "topic", "entity", "note", "tag"]);
const documentFormatSchema = z.enum(["markdown", "text", "json", "html", "code"]);
const backupStatusSchema = z.enum(["pending", "running", "completed", "failed", "partial"]);
const workflowStatusSchema = z.enum(["draft", "active", "paused", "error", "archived"]);

const toolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const tools: readonly McpTool[] = [
  { name: "knowledge_search", description: "Search knowledge graph nodes and edges", inputSchema: { type: "object", properties: { query: { type: "string", description: "Title, content, or edge label search text" }, type: { type: "string", description: "Optional node type filter", enum: knowledgeTypeSchema.options } } } },
  { name: "knowledge_create", description: "Create a new knowledge graph node", inputSchema: { type: "object", properties: { title: { type: "string", description: "Node title" }, content: { type: "string", description: "Node content" }, type: { type: "string", description: "Node type", enum: knowledgeTypeSchema.options } }, required: ["title"] } },
  { name: "document_read", description: "Read a knowledge base document", inputSchema: { type: "object", properties: { id: { type: "number", description: "Document id" } }, required: ["id"] } },
  { name: "document_write", description: "Create or update a knowledge base document", inputSchema: { type: "object", properties: { id: { type: "number", description: "Existing document id; omit to create" }, folderId: { type: "number", description: "Folder id" }, title: { type: "string", description: "Document title; required when creating" }, content: { type: "string", description: "Document content" }, format: { type: "string", description: "Document format", enum: documentFormatSchema.options } } } },
  { name: "backup_list", description: "List backup jobs and status", inputSchema: { type: "object", properties: { status: { type: "string", description: "Optional backup status filter" } } } },
  { name: "backup_trigger", description: "Trigger a scheduled backup job immediately", inputSchema: { type: "object", properties: { jobId: { type: "number", description: "Scheduled backup job id" } }, required: ["jobId"] } },
  { name: "workflow_list", description: "List workflows", inputSchema: { type: "object", properties: { status: { type: "string", description: "Optional workflow status filter" } } } },
  { name: "workflow_execute", description: "Execute a workflow", inputSchema: { type: "object", properties: { id: { type: "number", description: "Workflow id" }, input: { type: "object", description: "Workflow input payload" } }, required: ["id"] } },
  ...zvecTools,
  hybridSearchTool,
];

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function textResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function authenticate(headers: Headers): Promise<AuthenticatedIdentity | undefined> {
  const apiKeyIdentity = await authenticateApiKey(headers);
  if (apiKeyIdentity) return apiKeyIdentity;

  const user = await authenticateLocalRequest(headers);
  return user ? { user, auth: sessionAuth(user) } : undefined;
}

function assertScope(auth: AuthInfo, scope: string): void {
  if (!hasScope(auth, scope)) throw new Error(`Missing required scope: ${scope}`);
}

async function handleKnowledgeSearch(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "knowledge:read");
  const input = z.object({ query: z.string().max(500).optional().default(""), type: knowledgeTypeSchema.optional() }).parse(args);
  const q = `%${input.query}%`;
  const db = getDb();
  const nodeFilter = input.query
    ? or(like(knowledgeNodes.title, q), like(knowledgeNodes.content, q))
    : undefined;
  const nodes = await db.select().from(knowledgeNodes)
    .where(and(nodeFilter, input.type ? eq(knowledgeNodes.type, input.type) : undefined))
    .orderBy(desc(knowledgeNodes.updatedAt))
    .limit(20);
  const edges = input.query
    ? await db.select().from(knowledgeEdges).where(like(knowledgeEdges.label, q)).limit(20)
    : await db.select().from(knowledgeEdges).orderBy(desc(knowledgeEdges.createdAt)).limit(20);
  return textResult({ nodes, edges });
}

async function handleKnowledgeCreate(args: Record<string, unknown>, user: User, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "knowledge:write");
  const input = z.object({ title: z.string().min(1).max(500), content: z.string().optional(), type: knowledgeTypeSchema.default("concept") }).parse(args);
  const result = await getDb().insert(knowledgeNodes).values(clean({ ...input, createdBy: user.id }));
  return textResult({ id: Number(result[0].insertId) });
}

async function handleDocumentRead(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:read");
  const input = z.object({ id: z.number().int().positive() }).parse(args);
  const [document] = await getDb().select().from(kbDocuments).where(eq(kbDocuments.id, input.id));
  return textResult(document ?? null);
}

async function handleDocumentWrite(args: Record<string, unknown>, user: User, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:write");
  const input = z.object({ id: z.number().int().positive().optional(), folderId: z.number().int().positive().nullable().optional(), title: z.string().min(1).max(500).optional(), content: z.string().optional(), format: documentFormatSchema.default("markdown"), tags: z.array(z.string()).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(args);
  const db = getDb();
  if (input.id) {
    const { id, ...data } = input;
    await db.update(kbDocuments).set(clean(data)).where(eq(kbDocuments.id, id));
    return textResult({ success: true, id });
  }
  if (!input.title) return { content: [{ type: "text", text: "title is required when creating a document" }], isError: true };
  const result = await db.insert(kbDocuments).values(clean({
    title: input.title,
    content: input.content,
    format: input.format,
    tags: input.tags,
    metadata: input.metadata,
    folderId: input.folderId ?? null,
    createdBy: user.id,
  }));
  return textResult({ id: Number(result[0].insertId) });
}

async function handleBackupList(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "backups:read");
  const input = z.object({ status: backupStatusSchema.optional() }).parse(args);
  const query = getDb().select().from(backupJobs).orderBy(desc(backupJobs.createdAt));
  const jobs = input.status ? await query.where(eq(backupJobs.status, input.status)) : await query;
  return textResult(jobs);
}

async function handleBackupTrigger(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "backups:write");
  const input = z.object({ jobId: z.number().int().positive() }).parse(args);
  await getDb().update(backupJobs).set({ enabled: "true", nextRunAt: new Date() }).where(eq(backupJobs.id, input.jobId));
  await runDueBackupSchedules();
  return textResult({ success: true, scheduledJobId: input.jobId });
}

async function handleWorkflowList(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "workflows:read");
  const input = z.object({ status: workflowStatusSchema.optional() }).parse(args);
  const query = getDb().select().from(workflows).orderBy(desc(workflows.updatedAt));
  const rows = input.status ? await query.where(eq(workflows.status, input.status)) : await query;
  return textResult(rows);
}

async function handleWorkflowExecute(args: Record<string, unknown>, user: User, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "workflows:execute");
  const input = z.object({ id: z.number().int().positive(), input: z.record(z.string(), z.unknown()).default({}) }).parse(args);
  const runId = await executeWorkflow(input.id, input.input, user.id, "api");
  return textResult({ runId });
}

async function callTool(call: McpToolCall, user: User, auth: AuthInfo): Promise<McpToolResult> {
  switch (call.name) {
    case "knowledge_search": return handleKnowledgeSearch(call.arguments, auth);
    case "knowledge_create": return handleKnowledgeCreate(call.arguments, user, auth);
    case "document_read": return handleDocumentRead(call.arguments, auth);
    case "document_write": return handleDocumentWrite(call.arguments, user, auth);
    case "backup_list": return handleBackupList(call.arguments, auth);
    case "backup_trigger": return handleBackupTrigger(call.arguments, auth);
    case "workflow_list": return handleWorkflowList(call.arguments, auth);
    case "workflow_execute": return handleWorkflowExecute(call.arguments, user, auth);
    case "zvec.embed":
    case "zvec.search":
    case "zvec.stats":
    case "zvec.listCollections":
    case "zvec.addDocuments":
    case "zvec.deleteCollection":
      return handleZvecTool(call.name, call.arguments, auth);
    case "search.hybrid":
      return handleHybridSearch(call.arguments, auth);
    default: return { content: [{ type: "text", text: `Unknown tool: ${call.name}` }], isError: true };
  }
}

export async function handleMcpRequest(body: unknown, headers: Headers): Promise<JsonRpcResponse> {
  const parsed = z.object({ jsonrpc: z.literal("2.0").optional(), id: z.union([z.string(), z.number(), z.null()]).default(null), method: z.string(), params: z.unknown().optional() }).safeParse(body);
  if (!parsed.success) { console.error("MCP invalid JSON-RPC request", parsed.error.issues); return err(null, -32600, "Invalid JSON-RPC request"); }
  const request = parsed.data;
  if (request.method === "initialize") return ok(request.id, { protocolVersion: "2024-11-05", serverInfo: { name: "xuanji-mcp", version: "1.0.0" }, capabilities: { tools: {} } });
  const identity = await authenticate(headers);
  if (!identity) { console.error("MCP authentication failed", { hasAuthorization: headers.has("authorization") }); return err(request.id, -32001, "Authentication required"); }
  if (request.method === "tools/list") return ok(request.id, { tools });
  if (request.method !== "tools/call") { console.error("MCP method not found", { method: request.method }); return err(request.id, -32601, "Method not found"); }
  try {
    const call = toolCallSchema.parse(request.params);
    return ok(request.id, await callTool(call, identity.user, identity.auth));
  } catch (caught) {
    if (caught instanceof z.ZodError) {
      console.error("MCP tool argument validation failed", { method: request.method, error: caught });
      return err(request.id, -32602, "Invalid tool arguments");
    }
    if (caught instanceof Error) {
      console.error("MCP tool execution failed", { method: request.method, error: caught });
      return err(request.id, -32603, "Internal tool error");
    }
    console.error("MCP tool execution failed with unknown exception", { method: request.method, error: caught });
    return err(request.id, -32603, "Internal tool error");
  }
}

export async function createMcpSseResponse(headers: Headers): Promise<Response> {
  const identity = await authenticate(headers);
  if (!identity) return new Response("Authentication required", { status: 401 });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: endpoint\ndata: /api/mcp\n\n"));
      timer = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

export function createMcpHandler() {
  return { handleMcpRequest, createMcpSseResponse };
}
