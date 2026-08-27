import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  foreignKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** SQLite 时间戳默认值：毫秒精度的 unix epoch（适配 better-sqlite3 同步驱动）。 */
const nowMs = sql`(unixepoch() * 1000)`;

// ========== 用户表（OAuth认证） ==========
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  unionId: text("unionId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  avatar: text("avatar"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
  lastSignInAt: integer("lastSignInAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ========== Agent 智能助手表 ==========
export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type", { enum: ["assistant", "analyst", "curator", "connector", "custom"] })
    .default("assistant")
    .notNull(),
  avatarUrl: text("avatarUrl"),
  status: text("status", { enum: ["active", "inactive", "error", "training"] })
    .default("active")
    .notNull(),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
  // 权限配置（JSON存储7项权限）
  permissions: text("permissions", { mode: "json" }).$type<Record<string, unknown>>(),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
}, (table) => [
  index("agents_created_by_idx").on(table.createdBy),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "agents_created_by_fk",
  }),
]);

export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;

// ========== 外部 MCP 服务器配置表 ==========
export const mcpServers = sqliteTable("mcp_servers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  authToken: text("authToken"),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
});

export type McpServer = typeof mcpServers.$inferSelect;
export type InsertMcpServer = typeof mcpServers.$inferInsert;

// ========== 知识图谱节点表 ==========
export const knowledgeNodes = sqliteTable("knowledge_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  content: text("content"),
  type: text("type", { enum: ["concept", "document", "topic", "entity", "note", "tag"] })
    .default("concept")
    .notNull(),
  // 可视化位置
  posX: real("posX").default(0),
  posY: real("posY").default(0),
  // 样式配置
  style: text("style", { mode: "json" }).$type<Record<string, unknown>>(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
}, (table) => [
  index("knowledgeNodes_createdBy_idx").on(table.createdBy),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "knowledge_nodes_created_by_fk",
  }),
]);

export type KnowledgeNode = typeof knowledgeNodes.$inferSelect;
export type InsertKnowledgeNode = typeof knowledgeNodes.$inferInsert;

// ========== 知识图谱关系/边表 ==========
export const knowledgeEdges = sqliteTable("knowledge_edges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceId: integer("sourceId", { mode: "number" }).notNull(),
  targetId: integer("targetId", { mode: "number" }).notNull(),
  label: text("label"),
  type: text("type", { enum: ["related", "contains", "references", "extends", "similar", "sequence"] })
    .default("related")
    .notNull(),
  weight: real("weight").default(1),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("knowledgeEdges_targetId_idx").on(table.targetId),
  index("knowledgeEdges_sourceId_idx").on(table.sourceId),
  foreignKey({
    columns: [table.sourceId],
    foreignColumns: [knowledgeNodes.id],
    name: "knowledge_edges_source_fk",
  }),
  foreignKey({
    columns: [table.targetId],
    foreignColumns: [knowledgeNodes.id],
    name: "knowledge_edges_target_fk",
  }),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "knowledge_edges_created_by_fk",
  }),
]);

export type KnowledgeEdge = typeof knowledgeEdges.$inferSelect;
export type InsertKnowledgeEdge = typeof knowledgeEdges.$inferInsert;

// ========== 知识库文件夹表 ==========
export const kbFolders = sqliteTable("kb_folders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  parentId: integer("parentId", { mode: "number" }),
  icon: text("icon").default("folder"),
  sortOrder: integer("sortOrder").default(0),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
}, (table) => [
  index("kbFolders_createdBy_idx").on(table.createdBy),
  index("kbFolders_parentId_idx").on(table.parentId),
  foreignKey({
    columns: [table.parentId],
    foreignColumns: [table.id],
    name: "kb_folders_parent_id_fk",
  }),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "kb_folders_created_by_fk",
  }),
]);

export type KbFolder = typeof kbFolders.$inferSelect;
export type InsertKbFolder = typeof kbFolders.$inferInsert;

// ========== 知识库文档表 ==========
export const kbDocuments = sqliteTable("kb_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  folderId: integer("folderId", { mode: "number" }),
  title: text("title").notNull(),
  content: text("content"),
  format: text("format", { enum: ["markdown", "text", "json", "html", "code"] })
    .default("markdown")
    .notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  metadata: text("metadata", { mode: "json" }).$type<{
    wordCount?: number;
    source?: string;
    vectorized?: boolean;
    lastOpenedAt?: string;
  }>(),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
}, (table) => [
  index("kbDocuments_createdBy_idx").on(table.createdBy),
  index("kbDocuments_folderId_idx").on(table.folderId),
  foreignKey({
    columns: [table.folderId],
    foreignColumns: [kbFolders.id],
    name: "kb_docs_folder_id_fk",
  }),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "kb_docs_created_by_fk",
  }),
]);

export type KbDocument = typeof kbDocuments.$inferSelect;
export type InsertKbDocument = typeof kbDocuments.$inferInsert;

// ========== 工作流表 ==========
export const workflows = sqliteTable("workflows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", { enum: ["draft", "active", "paused", "error", "archived"] })
    .default("draft")
    .notNull(),
  // 画布配置
  canvas: text("canvas", { mode: "json" }).$type<Record<string, unknown>>(),
  // 触发器配置
  triggers: text("triggers", { mode: "json" }).$type<unknown[]>(),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
}, (table) => [
  index("workflows_createdBy_idx").on(table.createdBy),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "workflows_created_by_fk",
  }),
]);

export type Workflow = typeof workflows.$inferSelect;
export type InsertWorkflow = typeof workflows.$inferInsert;

// ========== 工作流节点表 ==========
export const workflowNodes = sqliteTable("workflow_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workflowId: integer("workflowId", { mode: "number" }).notNull(),
  type: text("type").notNull(),
  label: text("label"),
  positionX: real("positionX").default(0),
  positionY: real("positionY").default(0),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
  connections: text("connections", { mode: "json" }).$type<unknown[]>(),
  sortOrder: integer("sortOrder").default(0),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("workflowNodes_workflowId_idx").on(table.workflowId),
  foreignKey({
    columns: [table.workflowId],
    foreignColumns: [workflows.id],
    name: "workflow_nodes_wf_fk",
  }),
]);

export type WorkflowNode = typeof workflowNodes.$inferSelect;
export type InsertWorkflowNode = typeof workflowNodes.$inferInsert;

// ========== 数据源表 ==========
export const dataSources = sqliteTable("data_sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: [
    "cloud_drive",
    "nas",
    "database",
    "api",
    "webhook",
    "rss",
    "notion",
    "obsidian",
  ] }).notNull(),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
  status: text("status", { enum: ["connected", "disconnected", "error", "syncing"] })
    .default("disconnected")
    .notNull(),
  lastSyncAt: integer("lastSyncAt", { mode: "timestamp_ms" }),
  lastError: text("lastError"),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
}, (table) => [
  index("dataSources_type_idx").on(table.type),
  index("dataSources_createdBy_idx").on(table.createdBy),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "data_sources_created_by_fk",
  }),
]);

export type DataSource = typeof dataSources.$inferSelect;
export type InsertDataSource = typeof dataSources.$inferInsert;

// ========== 上传文件表 ==========
export const uploadedFiles = sqliteTable("uploaded_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  originalName: text("originalName").notNull(),
  mimeType: text("mimeType"),
  size: integer("size", { mode: "number" }),
  storagePath: text("storagePath").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  uploadedBy: integer("uploadedBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("uploadedFiles_uploadedBy_idx").on(table.uploadedBy),
  foreignKey({
    columns: [table.uploadedBy],
    foreignColumns: [users.id],
    name: "uploaded_files_uploaded_by_fk",
  }),
]);

export type UploadedFile = typeof uploadedFiles.$inferSelect;
export type InsertUploadedFile = typeof uploadedFiles.$inferInsert;

// ========== 向量集合表（用于向量化模型配置） ==========
export const vectorCollections = sqliteTable("vector_collections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  model: text("model").default("text-embedding-3-small"),
  dimension: integer("dimension").default(1536),
  status: text("status", { enum: ["ready", "building", "error"] })
    .default("ready")
    .notNull(),
  documentCount: integer("documentCount").default(0),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
}, (table) => [
  index("vectorCollections_createdBy_idx").on(table.createdBy),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "vector_collections_created_by_fk",
  }),
]);

export type VectorCollection = typeof vectorCollections.$inferSelect;
export type InsertVectorCollection = typeof vectorCollections.$inferInsert;

// ========== 系统设置表 ==========
export const systemSettings = sqliteTable("system_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value"),
  category: text("category").default("general"),
  updatedBy: integer("updatedBy", { mode: "number" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .default(nowMs)
    .notNull(),
}, (table) => [
  index("systemSettings_key_idx").on(table.key),
  index("systemSettings_category_idx").on(table.category),
  foreignKey({
    columns: [table.updatedBy],
    foreignColumns: [users.id],
    name: "system_settings_user_fk",
  }),
]);

export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;

// ========== 摄取任务表（上传/数据源同步/备份等统一入口） ==========
export const ingestionJobs = sqliteTable("ingestion_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceType: text("sourceType", { enum: ["upload", "datasource", "backup", "manual"] }).notNull(),
  sourceId: text("sourceId"),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "cancelled"] }).default("pending").notNull(),
  totalItems: integer("totalItems").default(0),
  processedItems: integer("processedItems").default(0),
  failedItems: integer("failedItems").default(0),
  error: text("error"),
  retryCount: integer("retryCount").default(0),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("ingestionJobs_sourceType_idx").on(table.sourceType),
  index("ingestionJobs_status_idx").on(table.status),
  index("ingestionJobs_createdBy_idx").on(table.createdBy),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "ingestion_jobs_created_by_fk",
  }),
]);

export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type InsertIngestionJob = typeof ingestionJobs.$inferInsert;

// ========== 摄取项目表（任务中的单个文件/对象） ==========
export const ingestionItems = sqliteTable("ingestion_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId", { mode: "number" }).notNull(),
  externalId: text("externalId"),
  name: text("name").notNull(),
  mimeType: text("mimeType"),
  size: integer("size", { mode: "number" }),
  status: text("status", { enum: ["pending", "parsing", "chunking", "indexing", "completed", "failed", "unsupported"] }).default("pending").notNull(),
  error: text("error"),
  sourceUrl: text("sourceUrl"),
  storagePath: text("storagePath"),
  documentId: integer("documentId", { mode: "number" }),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("ingestionItems_jobId_idx").on(table.jobId),
  index("ingestionItems_status_idx").on(table.status),
  index("ingestionItems_documentId_idx").on(table.documentId),
  foreignKey({
    columns: [table.jobId],
    foreignColumns: [ingestionJobs.id],
    name: "ingestion_items_job_fk",
  }),
]);

export type IngestionItem = typeof ingestionItems.$inferSelect;
export type InsertIngestionItem = typeof ingestionItems.$inferInsert;

// ========== 文档分块表（向量搜索基本单元） ==========
export const documentChunks = sqliteTable("document_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  documentId: integer("documentId", { mode: "number" }).notNull(),
  itemId: integer("itemId", { mode: "number" }),
  content: text("content").notNull(),
  chunkIndex: integer("chunkIndex").default(0).notNull(),
  embedding: text("embedding", { mode: "json" }).$type<number[]>(),
  embeddingModel: text("embeddingModel"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("documentChunks_documentId_idx").on(table.documentId),
  index("documentChunks_itemId_idx").on(table.itemId),
  foreignKey({
    columns: [table.documentId],
    foreignColumns: [kbDocuments.id],
    name: "document_chunks_doc_fk",
  }),
]);

export type DocumentChunk = typeof documentChunks.$inferSelect;
export type InsertDocumentChunk = typeof documentChunks.$inferInsert;

// ========== 备份任务表（持久化备份状态） ==========
export const backupJobs = sqliteTable("backup_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  target: text("target").notNull(),
  sourcePath: text("sourcePath").notNull(),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "partial"] }).default("pending").notNull(),
  progress: integer("progress").default(0),
  filesTotal: integer("filesTotal").default(0),
  filesDone: integer("filesDone").default(0),
  filesFailed: integer("filesFailed").default(0),
  manifest: text("manifest", { mode: "json" }).$type<Record<string, unknown>>(),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
  cron: text("cron"),
  enabled: text("enabled", { enum: ["true", "false"] }).default("false").notNull(),
  nextRunAt: integer("nextRunAt", { mode: "timestamp_ms" }),
  keepLastN: integer("keepLastN").default(7),
  maxRetries: integer("maxRetries").default(3),
  retryCount: integer("retryCount").default(0),
  error: text("error"),
  startedAt: integer("startedAt", { mode: "timestamp_ms" }),
  completedAt: integer("completedAt", { mode: "timestamp_ms" }),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("backupJobs_target_idx").on(table.target),
  index("backupJobs_status_idx").on(table.status),
  index("backupJobs_createdBy_idx").on(table.createdBy),
  index("backupJobs_enabled_nextRun_idx").on(table.enabled, table.nextRunAt),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "backup_jobs_created_by_fk",
  }),
]);

export type BackupJob = typeof backupJobs.$inferSelect;
export type InsertBackupJob = typeof backupJobs.$inferInsert;

// ========== 备份任务文件表 ==========
export const backupJobFiles = sqliteTable("backup_job_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId", { mode: "number" }).notNull(),
  relativePath: text("relativePath").notNull(),
  size: integer("size", { mode: "number" }),
  checksum: text("checksum"),
  status: text("status", { enum: ["pending", "uploaded", "failed"] }).default("pending").notNull(),
  error: text("error"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("backupJobFiles_jobId_idx").on(table.jobId),
  foreignKey({
    columns: [table.jobId],
    foreignColumns: [backupJobs.id],
    name: "backup_job_files_job_fk",
  }),
]);

export type BackupJobFile = typeof backupJobFiles.$inferSelect;
export type InsertBackupJobFile = typeof backupJobFiles.$inferInsert;

// ========== 恢复任务表 ==========
export const restoreJobs = sqliteTable("restore_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  backupJobId: integer("backupJobId", { mode: "number" }).notNull(),
  targetPath: text("targetPath").notNull(),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "partial"] }).default("pending").notNull(),
  progress: integer("progress").default(0),
  filesTotal: integer("filesTotal").default(0),
  filesDone: integer("filesDone").default(0),
  filesFailed: integer("filesFailed").default(0),
  manifestVerified: text("manifestVerified", { enum: ["pending", "passed", "failed"] }).default("pending").notNull(),
  error: text("error"),
  startedAt: integer("startedAt", { mode: "timestamp_ms" }),
  completedAt: integer("completedAt", { mode: "timestamp_ms" }),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("restoreJobs_backupJobId_idx").on(table.backupJobId),
  index("restoreJobs_status_idx").on(table.status),
  foreignKey({
    columns: [table.backupJobId],
    foreignColumns: [backupJobs.id],
    name: "restore_jobs_backup_fk",
  }),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "restore_jobs_created_by_fk",
  }),
]);

export type RestoreJob = typeof restoreJobs.$inferSelect;
export type InsertRestoreJob = typeof restoreJobs.$inferInsert;

// ========== 工作流运行表 ==========
export const workflowRuns = sqliteTable("workflow_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workflowId: integer("workflowId", { mode: "number" }).notNull(),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "cancelled"] }).default("pending").notNull(),
  triggeredBy: text("triggeredBy", { enum: ["manual", "api", "cron", "webhook"] }).default("manual").notNull(),
  input: text("input", { mode: "json" }).$type<Record<string, unknown>>(),
  output: text("output", { mode: "json" }).$type<Record<string, unknown>>(),
  error: text("error"),
  startedAt: integer("startedAt", { mode: "timestamp_ms" }),
  completedAt: integer("completedAt", { mode: "timestamp_ms" }),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("workflowRuns_workflowId_idx").on(table.workflowId),
  index("workflowRuns_status_idx").on(table.status),
  foreignKey({
    columns: [table.workflowId],
    foreignColumns: [workflows.id],
    name: "workflow_runs_wf_fk",
  }),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "workflow_runs_created_by_fk",
  }),
]);

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type InsertWorkflowRun = typeof workflowRuns.$inferInsert;

// ========== 工作流运行节点结果表 ==========
export const workflowRunNodes = sqliteTable("workflow_run_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("runId", { mode: "number" }).notNull(),
  nodeId: integer("nodeId", { mode: "number" }).notNull(),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "skipped"] }).default("pending").notNull(),
  input: text("input", { mode: "json" }).$type<Record<string, unknown>>(),
  output: text("output", { mode: "json" }).$type<Record<string, unknown>>(),
  error: text("error"),
  startedAt: integer("startedAt", { mode: "timestamp_ms" }),
  completedAt: integer("completedAt", { mode: "timestamp_ms" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("workflowRunNodes_runId_idx").on(table.runId),
  index("workflowRunNodes_nodeId_idx").on(table.nodeId),
  foreignKey({
    columns: [table.runId],
    foreignColumns: [workflowRuns.id],
    name: "workflow_run_nodes_run_fk",
  }),
  foreignKey({
    columns: [table.nodeId],
    foreignColumns: [workflowNodes.id],
    name: "workflow_run_nodes_node_fk",
  }),
]);

export type WorkflowRunNode = typeof workflowRunNodes.$inferSelect;
export type InsertWorkflowRunNode = typeof workflowRunNodes.$inferInsert;

// ========== 审计日志表 ==========
export const auditActionEnumValues = ["create", "update", "delete", "run"];
export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityType: text("entityType").notNull(),
  entityId: integer("entityId", { mode: "number" }).notNull(),
  action: text("action", { enum: ["create", "update", "delete", "run"] }).notNull(),
  actorId: integer("actorId", { mode: "number" }),
  details: text("details", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("auditLogs_entity_idx").on(table.entityType, table.entityId),
  index("auditLogs_actor_idx").on(table.actorId),
  foreignKey({
    columns: [table.actorId],
    foreignColumns: [users.id],
    name: "audit_logs_actor_fk",
  }),
]);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ========== 外部 Agent API 密钥表 ==========
export const apiKeys = sqliteTable("api_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  keyHash: text("keyHash").notNull().unique(),
  keyPrefix: text("keyPrefix").notNull(),
  agentId: integer("agentId", { mode: "number" }).notNull(),
  permissions: text("permissions", { mode: "json" }).$type<Record<string, unknown>>(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>(),
  isActive: text("isActive", { enum: ["true", "false"] }).default("true").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
  lastUsedAt: integer("lastUsedAt", { mode: "timestamp_ms" }),
  createdBy: integer("createdBy", { mode: "number" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowMs),
}, (table) => [
  index("apiKeys_agentId_idx").on(table.agentId),
  index("apiKeys_keyPrefix_idx").on(table.keyPrefix),
  foreignKey({
    columns: [table.agentId],
    foreignColumns: [agents.id],
    name: "api_keys_agent_fk",
  }),
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "api_keys_created_by_fk",
  }),
]);

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;
