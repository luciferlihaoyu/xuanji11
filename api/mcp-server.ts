import { desc, eq, like, or, and, isNull, count } from "drizzle-orm";
import { z } from "zod";
import {
  backupJobs,
  kbDocuments,
  kbFolders,
  knowledgeEdges,
  knowledgeNodes,
  workflows,
  type User,
} from "@db/schema";
import { clean } from "./lib/clean";
import { paginate, InvalidCursorError } from "./lib/mcp-pagination";
import { previewDocumentDeletion } from "./lib/document-removal";
import { runDueBackupSchedules } from "./lib/backup-scheduler";
import { createTask, finishTask, getTask, isCancelRequested, requestCancel, updateTaskProgress, type TaskRecord } from "./lib/task-registry";
import { executeWorkflow } from "./lib/workflow-runtime";
import { zvecTools, handleZvecTool } from "./mcp-zvec-tools";
import { hybridSearchTool, handleHybridSearch } from "./mcp-hybrid-search";
import { kbBackupTools, handleKbBackupTool } from "./mcp-kb-backup";
import { keywordTools, handleKeywordTool } from "./mcp-keyword";
import { relationTools, handleRelationTool } from "./mcp-relation";
import { analyticsTool, handleAnalyticsTool } from "./mcp-analytics";
import { tryIndexDocumentById, startReindexAll, getReindexProgress } from "./lib/document-indexer";
import { vectorEngine } from "./lib/vector";
import { deleteDocumentCascade } from "./lib/document-removal";
import { normalizeTitle } from "./lib/title-normalize";
import type { AuthenticatedIdentity, AuthInfo } from "./lib/auth";
import { authenticateApiKey, hasScope, sessionAuth } from "./lib/auth";
import { authenticateLocalRequest } from "./local-auth";
import { getDb } from "./queries/connection";

type JsonRpcId = string | number | null;

interface McpToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** MCP 工具注解（MCP 2025-06-18 spec）：给调用方判断「能不能自动批准」用 */
export interface McpToolAnnotations {
  /** 人类可读的工具名（UI 展示用） */
  readonly title: string;
  /** 不修改任何状态 */
  readonly readOnlyHint: boolean;
  /** 可能造成不可逆删除 */
  readonly destructiveHint: boolean;
  /** 重复调用与单次调用效果相同 */
  readonly idempotentHint: boolean;
  /** 会触达外部系统（远端网盘、外部模型端点等） */
  readonly openWorldHint: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** 必填：新增工具时类型门禁会强制补齐注解，避免注解长期不全 */
  readonly annotations: McpToolAnnotations;
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
  { name: "knowledge_search", description: "Search knowledge graph nodes and edges", annotations: { title: "检索知识图谱", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { query: { type: "string", description: "Title, content, or edge label search text" }, type: { type: "string", description: "Optional node type filter", enum: knowledgeTypeSchema.options } } } },
  { name: "knowledge_create", description: "Create a new knowledge graph node", annotations: { title: "新建图谱节点", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { title: { type: "string", description: "Node title" }, content: { type: "string", description: "Node content" }, type: { type: "string", description: "Node type", enum: knowledgeTypeSchema.options } }, required: ["title"] } },
  { name: "document_read", description: "Read a knowledge base document", annotations: { title: "读取知识库文档", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { id: { type: "number", description: "Document id" } }, required: ["id"] } },
  { name: "document_write", description: "Create or update a knowledge base document. Content is automatically chunked and indexed into the vector store.", annotations: { title: "写入知识库文档", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { id: { type: "number", description: "Existing document id; omit to create" }, folderId: { type: "number", description: "Folder id" }, title: { type: "string", description: "Document title; required when creating" }, content: { type: "string", description: "Document content" }, format: { type: "string", description: "Document format", enum: documentFormatSchema.options } } } },
  { name: "document_delete", description: "Delete a knowledge base document and cascade-clean chunks, vectors, and linked knowledge graph nodes/edges", annotations: { title: "删除知识库文档", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { id: { type: "number", description: "Document id" } , dryRun: { type: "boolean", description: "Preview exactly what would be deleted (counts) without deleting anything" }}, required: ["id"] } },
  { name: "document_set_folder", description: "Assign a document to a folder (or null to remove). Lightweight; does not re-chunk or re-vectorize", annotations: { title: "移动文档到文件夹", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { id: { type: "number", description: "Document id" }, folderId: { type: "number", description: "Folder id; null to remove" } }, required: ["id", "folderId"] } },
  { name: "document_upsert", description: "Create a document or update the earliest existing document with the same normalized title (bracket prefixes, case, and whitespace ignored). Idempotent for sync writers", annotations: { title: "按标题同步文档", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { title: { type: "string", description: "Document title (1-500 chars)" }, content: { type: "string", description: "Document content" }, format: { type: "string", description: "Document format", enum: documentFormatSchema.options }, tags: { type: "array", description: "Document tags" }, metadata: { type: "object", description: "Document metadata" }, folderId: { type: "number", description: "Folder id" } }, required: ["title"] } },
  { name: "folder_create", description: "Create a knowledge base folder (optionally under a parent folder)", annotations: { title: "新建文件夹", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: { name: { type: "string", description: "Folder name (1-255 chars)" }, parentId: { type: "number", description: "Parent folder id; omit or null for root" } }, required: ["name"] } },
  { name: "folder_list", description: "List knowledge base folders with document counts", annotations: { title: "列出文件夹", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { cursor: { type: "string", description: "Opaque cursor taken verbatim from a previous response's nextCursor; omit for the first page" }, limit: { type: "number", description: "Page size, 1-200 (default 50)" } } } },
  { name: "kb.reindex_all", description: "Start a full reindex of all knowledge base documents into the vector store (runs in background, idempotent). Returns initial progress.", annotations: { title: "全量重建索引", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: {} } },
  { name: "kb.reindex_status", description: "Get the progress of the running or last reindex-all job plus current vector store size", annotations: { title: "查询重建进度", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: {} } },
  { name: "backup_list", description: "List backup jobs and status", annotations: { title: "列出备份任务", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { status: { type: "string", description: "Optional backup status filter" }, cursor: { type: "string", description: "Opaque cursor taken verbatim from a previous response's nextCursor; omit for the first page" }, limit: { type: "number", description: "Page size, 1-200 (default 50)" } } } },
  { name: "backup_trigger", description: "Trigger a scheduled backup job immediately", annotations: { title: "立即触发备份", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, inputSchema: { type: "object", properties: { jobId: { type: "number", description: "Scheduled backup job id" } }, required: ["jobId"] } },
  { name: "task_get", description: "Get a long-running task (backup/reindex) status and progress", annotations: { title: "查询长任务", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Task handle returned by backup_trigger / kb.reindex_all" } }, required: ["taskId"] } },
  { name: "task_cancel", description: "Request cancellation of a long-running task (two-phase: signal now, executor acknowledges at a safe point)", annotations: { title: "取消长任务", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Task handle" } }, required: ["taskId"] } },
  { name: "workflow_list", description: "List workflows", annotations: { title: "列出工作流", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", properties: { status: { type: "string", description: "Optional workflow status filter" }, cursor: { type: "string", description: "Opaque cursor taken verbatim from a previous response's nextCursor; omit for the first page" }, limit: { type: "number", description: "Page size, 1-200 (default 50)" } } } },
  { name: "workflow_execute", description: "Execute a workflow", annotations: { title: "执行工作流", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, inputSchema: { type: "object", properties: { id: { type: "number", description: "Workflow id" }, input: { type: "object", description: "Workflow input payload" } }, required: ["id"] } },
  ...zvecTools,
  hybridSearchTool,
  ...kbBackupTools,
  ...keywordTools,
  ...relationTools,
  analyticsTool,
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

/**
 * 列表工具统一分页信封：{ items, nextCursor, total }。
 * cursor 非法时返回 isError（不静默重发第一页，否则调用方会重复处理数据却毫无察觉）。
 */
function paginatedResult<T>(rows: readonly T[], opts: { cursor?: string; limit?: number }): McpToolResult {
  try {
    return textResult(paginate(rows, opts));
  } catch (e) {
    if (e instanceof InvalidCursorError) return { content: [{ type: "text", text: e.message }], isError: true };
    throw e;
  }
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
  return textResult({ id: Number(result.lastInsertRowid) });
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
    // 内容变更时自动重建索引；索引失败不影响文档更新
    const indexed = input.content !== undefined ? await tryIndexDocumentById(id) : { chunks: 0, skipped: true };
    return textResult({ success: true, id, chunks: indexed.chunks });
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
  const id = Number(result.lastInsertRowid);
  // 自动索引：有内容即入向量库；索引失败不影响文档创建
  const indexed = input.content ? await tryIndexDocumentById(id) : { chunks: 0, skipped: true };
  return textResult({ id, chunks: indexed.chunks });
}

async function handleDocumentDelete(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:write");
  const input = z.object({ id: z.number().int().positive(), dryRun: z.boolean().default(false) }).parse(args);
  try {
    if (input.dryRun) {
      // dryRun：只报影响面，绝不落任何删除（含向量清理）
      const preview = await previewDocumentDeletion(getDb(), vectorEngine, input.id);
      return textResult({ dryRun: true, ...preview });
    }
    const r = await deleteDocumentCascade(getDb(), vectorEngine, input.id);
    return textResult({ success: true, id: input.id, ...r });
  } catch (e) {
    // 文档不存在：返回 isError=true，让 MCP 调用方能区分"业务失败"与"协议错误"
    if (e instanceof Error && e.message.includes("Document not found")) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
    throw e;
  }
}

async function handleDocumentSetFolder(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:write");
  const input = z.object({ id: z.number().int().positive(), folderId: z.number().int().positive().nullable() }).parse(args);
  const db = getDb();
  // 1) 文档存在性校验
  const existing = await db.select({ id: kbDocuments.id }).from(kbDocuments).where(eq(kbDocuments.id, input.id)).limit(1);
  if (existing.length === 0) {
    return { content: [{ type: "text", text: `Document not found: ${input.id}` }], isError: true };
  }
  // 2) folderId 非空时校验文件夹存在
  if (input.folderId !== null && input.folderId !== undefined) {
    const folderExisting = await db.select({ id: kbFolders.id }).from(kbFolders).where(eq(kbFolders.id, input.folderId)).limit(1);
    if (folderExisting.length === 0) {
      return { content: [{ type: "text", text: `Folder not found: ${input.folderId}` }], isError: true };
    }
  }
  // 3) 轻量更新：只动 folderId，绝不重索引
  await db.update(kbDocuments).set({ folderId: input.folderId ?? null }).where(eq(kbDocuments.id, input.id));
  return textResult({ success: true, id: input.id, folderId: input.folderId ?? null });
}

async function handleDocumentUpsert(args: Record<string, unknown>, user: User, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:write");
  const input = z.object({
    title: z.string().min(1).max(500),
    content: z.string().optional(),
    format: documentFormatSchema.default("markdown"),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    folderId: z.number().int().positive().nullable().optional(),
  }).parse(args);
  const db = getDb();
  // 按归一化标题全表查重：量级 ~1800 行可接受，文档表全表扫描是已知的轻量操作；
  // 这里走应用层比对是为了用 normalizeTitle（库内 SQL 函数无法表达"[xxx] 前缀剥离"规则）。
  const candidates = await db.select({ id: kbDocuments.id, title: kbDocuments.title }).from(kbDocuments);
  const norm = normalizeTitle(input.title);
  const match = candidates
    .filter((row) => normalizeTitle(row.title) === norm)
    .sort((a, b) => a.id - b.id)[0];
  if (match) {
    // 命中：更新 title/content/format/updatedAt（其余字段不动；folderId 不在 upsert 范围）
    await db.update(kbDocuments).set(clean({
      title: input.title,
      content: input.content,
      format: input.format,
      updatedAt: new Date(),
    })).where(eq(kbDocuments.id, match.id));
    if (input.content !== undefined) {
      await tryIndexDocumentById(match.id);
    }
    return textResult({ id: match.id, action: "updated" });
  }
  // 未命中：插入新文档（参考 handleDocumentWrite 的 insert 分支）
  const result = await db.insert(kbDocuments).values(clean({
    title: input.title,
    content: input.content,
    format: input.format,
    tags: input.tags,
    metadata: input.metadata,
    folderId: input.folderId ?? null,
    createdBy: user.id,
  }));
  const newId = Number(result.lastInsertRowid);
  if (input.content !== undefined) {
    await tryIndexDocumentById(newId);
  }
  return textResult({ id: newId, action: "created" });
}

async function handleFolderCreate(args: Record<string, unknown>, user: User, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:write");
  const input = z.object({
    name: z.string().min(1).max(255),
    parentId: z.number().int().positive().nullable().optional(),
  }).parse(args);
  const db = getDb();
  const parentId = input.parentId ?? null;
  // 1) parentId 非空时校验父目录存在
  if (parentId !== null) {
    const parentExisting = await db.select({ id: kbFolders.id }).from(kbFolders).where(eq(kbFolders.id, parentId)).limit(1);
    if (parentExisting.length === 0) {
      return { content: [{ type: "text", text: `Parent folder not found: ${parentId}` }], isError: true };
    }
  }
  // 2) 同层同名查重（parentId 可能为 null，按 isNull 分支匹配）
  const dupWhere = parentId === null
    ? and(eq(kbFolders.name, input.name), isNull(kbFolders.parentId))
    : and(eq(kbFolders.name, input.name), eq(kbFolders.parentId, parentId));
  const existing = await db.select({ id: kbFolders.id }).from(kbFolders).where(dupWhere).limit(1);
  if (existing.length > 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ success: false, error: "folder exists", id: existing[0].id }),
      }],
      isError: true,
    };
  }
  // 3) 插入
  const result = await db.insert(kbFolders).values({
    name: input.name,
    parentId,
    createdBy: user.id,
  });
  return textResult({ id: Number(result.lastInsertRowid), name: input.name, parentId });
}

/**
 * folder_list 的查询口径（具名导出以便直接断言 ORDER BY 全序性）。
 *
 * WHY 必须有 id 兜底：`kb_folders.sortOrder` 默认 0 且 folder_create 从不写它 →
 * MCP 建的文件夹全部并列。排序键并列时 SQLite **不保证任何顺序**，
 * 而 cursor 分页是 offset 语义，顺序漂移就会跨页漏项或重项。
 * sortOrder 为主序（保留人工排序语义），id 兜底补成全序。
 */
export function folderListQuery(db: ReturnType<typeof getDb>) {
  return db
    .select({
      id: kbFolders.id,
      name: kbFolders.name,
      parentId: kbFolders.parentId,
      icon: kbFolders.icon,
      sortOrder: kbFolders.sortOrder,
      createdAt: kbFolders.createdAt,
      updatedAt: kbFolders.updatedAt,
      documentCount: count(kbDocuments.id),
    })
    .from(kbFolders)
    .leftJoin(kbDocuments, eq(kbDocuments.folderId, kbFolders.id))
    .groupBy(kbFolders.id)
    .orderBy(kbFolders.sortOrder, kbFolders.id);
}

async function handleFolderList(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:read");
  const input = z.object({ cursor: z.string().optional(), limit: z.number().optional() }).parse(args);
  const rows = await folderListQuery(getDb());
  return paginatedResult(rows, input);
}

async function handleKbReindexAll(auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:write");
  // P0-4：重建索引同样走统一句柄（全库回填是典型长任务）
  const task = createTask({ kind: "reindex" });
  return textResult({ taskId: task.taskId, ...startReindexAll(task.taskId) });
}

async function handleKbReindexStatus(auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "documents:read");
  return textResult({ ...getReindexProgress(), vectorSize: vectorEngine.size });
}

async function handleBackupList(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "backups:read");
  const input = z.object({ status: backupStatusSchema.optional(), cursor: z.string().optional(), limit: z.number().optional() }).parse(args);
  // 排序必须稳定（createdAt 同值用 id 兜底），否则分页会漏项/重项
  const query = getDb().select().from(backupJobs).orderBy(desc(backupJobs.createdAt), desc(backupJobs.id));
  const jobs = input.status ? await query.where(eq(backupJobs.status, input.status)) : await query;
  return paginatedResult(jobs, input);
}

async function handleBackupTrigger(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "backups:write");
  const input = z.object({ jobId: z.number().int().positive() }).parse(args);
  await getDb().update(backupJobs).set({ enabled: "true", nextRunAt: new Date() }).where(eq(backupJobs.id, input.jobId));
  // P0-4：不再让调用方干等——只跑这一个调度，并把它这次运行的任务句柄交出去
  const handles = await runDueBackupSchedules({ scheduleId: input.jobId });
  const handle = handles[0];
  if (!handle) {
    return { content: [{ type: "text", text: `没有可执行的备份调度：${input.jobId}（作业可能不存在）` }], isError: true };
  }
  return textResult({ taskId: handle.taskId, scheduleId: handle.scheduleId, runJobId: handle.runJobId, status: "running" });
}

/** 至少具备其中一个 scope（任务句柄横跨备份/文档两类业务） */
function assertAnyScope(auth: AuthInfo, scopes: readonly string[]): void {
  if (scopes.some((scope) => hasScope(auth, scope))) return;
  throw new Error(`Missing required scope: ${scopes.join(" 或 ")}`);
}

/**
 * 把任务句柄与业务真相对齐：句柄只存身份，状态/进度以业务源为准。
 * - backup → backup_jobs 的 run 行（进程重启后依然准确）
 * - reindex → 索引器的 getReindexProgress()
 */
async function syncTaskFromSource(record: TaskRecord): Promise<TaskRecord> {
  if (record.kind === "backup" && record.refId !== undefined) {
    const [row] = await getDb().select().from(backupJobs).where(eq(backupJobs.id, record.refId));
    if (!row) return record;
    const meta = { filesTotal: row.filesTotal, filesDone: row.filesDone, filesFailed: row.filesFailed };
    if (row.status === "completed") return finishTask(record.taskId, "completed", { progress: 100, meta }) ?? record;
    if (row.status === "cancelled") return finishTask(record.taskId, "cancelled", { meta }) ?? record;
    if (row.status === "failed" || row.status === "partial") {
      return finishTask(record.taskId, "failed", { error: row.error ?? `备份状态：${row.status}`, meta }) ?? record;
    }
    return updateTaskProgress(record.taskId, row.progress ?? 0, { ...meta, backupStatus: row.status }) ?? record;
  }
  if (record.kind === "reindex") {
    const p = getReindexProgress();
    const meta = { total: p.total, done: p.done, failed: p.failed, chunksTotal: p.chunksTotal };
    const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    if (p.running) return updateTaskProgress(record.taskId, pct, meta) ?? record;
    // 索引器已停：running 句柄按结果收口（也覆盖进程重启导致句柄悬空的情况）
    return finishTask(record.taskId, p.failed > 0 ? "failed" : "completed", { progress: 100, meta }) ?? record;
  }
  return record;
}

async function handleTaskGet(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertAnyScope(auth, ["documents:read", "backups:read"]);
  const input = z.object({ taskId: z.string().min(1).max(200) }).parse(args);
  const record = getTask(input.taskId);
  if (!record) {
    return { content: [{ type: "text", text: `Task not found: ${input.taskId}` }], isError: true };
  }
  const synced = await syncTaskFromSource(record);
  return textResult({ ...synced, cancelRequested: isCancelRequested(input.taskId) });
}

async function handleTaskCancel(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertAnyScope(auth, ["documents:write", "backups:write"]);
  const input = z.object({ taskId: z.string().min(1).max(200) }).parse(args);
  const record = getTask(input.taskId);
  if (!record) {
    return { content: [{ type: "text", text: `Task not found: ${input.taskId}` }], isError: true };
  }
  // 先对齐业务真相：已结束的任务必须如实回答「无需取消」，不能谎报取消成功
  await syncTaskFromSource(record);
  const outcome = requestCancel(input.taskId);
  if (!outcome) {
    return { content: [{ type: "text", text: `Task not found: ${input.taskId}` }], isError: true };
  }
  return textResult({
    taskId: input.taskId,
    accepted: outcome.accepted,
    status: outcome.task.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  });
}

async function handleWorkflowList(args: Record<string, unknown>, auth: AuthInfo): Promise<McpToolResult> {
  assertScope(auth, "workflows:read");
  const input = z.object({ status: workflowStatusSchema.optional(), cursor: z.string().optional(), limit: z.number().optional() }).parse(args);
  const query = getDb().select().from(workflows).orderBy(desc(workflows.updatedAt), desc(workflows.id));
  const rows = input.status ? await query.where(eq(workflows.status, input.status)) : await query;
  return paginatedResult(rows, input);
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
    case "document_delete": return handleDocumentDelete(call.arguments, auth);
    case "document_set_folder": return handleDocumentSetFolder(call.arguments, auth);
    case "document_upsert": return handleDocumentUpsert(call.arguments, user, auth);
    case "folder_create": return handleFolderCreate(call.arguments, user, auth);
    case "folder_list": return handleFolderList(call.arguments, auth);
    case "kb.reindex_all": return handleKbReindexAll(auth);
    case "kb.reindex_status": return handleKbReindexStatus(auth);
    case "backup_list": return handleBackupList(call.arguments, auth);
    case "backup_trigger": return handleBackupTrigger(call.arguments, auth);
    case "task_get": return handleTaskGet(call.arguments, auth);
    case "task_cancel": return handleTaskCancel(call.arguments, auth);
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
    case "kb.export":
    case "kb.import":
      return handleKbBackupTool(call.name, call.arguments, auth);
    case "keywords.extract":
    case "keywords.autoTag":
      return handleKeywordTool(call.name, call.arguments, auth, user.id);
    case "relations.discover":
    case "relations.create":
      return handleRelationTool(call.name, call.arguments, auth, user);
    case "analytics.get":
      return handleAnalyticsTool(call.arguments, auth);
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
