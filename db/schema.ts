import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  timestamp,
  bigint,
  json,
  float,
  int,
  foreignKey,
} from "drizzle-orm/mysql-core";

// ========== 用户表（OAuth认证） ==========
export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ========== Agent 智能助手表 ==========
export const agents = mysqlTable("agents", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  type: mysqlEnum("type", ["assistant", "analyst", "curator", "connector", "custom"])
    .default("assistant")
    .notNull(),
  avatarUrl: text("avatarUrl"),
  status: mysqlEnum("status", ["active", "inactive", "error", "training"])
    .default("active")
    .notNull(),
  config: json("config").$type<Record<string, unknown>>(),
  // 权限配置（JSON存储7项权限）
  permissions: json("permissions").$type<Record<string, unknown>>(),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "agents_created_by_fk",
  }),
]);

export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;

// ========== 知识图谱节点表 ==========
export const knowledgeNodes = mysqlTable("knowledge_nodes", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 500 }).notNull(),
  content: text("content"),
  type: mysqlEnum("type", ["concept", "document", "topic", "entity", "note", "tag"])
    .default("concept")
    .notNull(),
  // 可视化位置
  posX: float("posX").default(0),
  posY: float("posY").default(0),
  // 样式配置
  style: json("style").$type<Record<string, unknown>>(),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "knowledge_nodes_created_by_fk",
  }),
]);

export type KnowledgeNode = typeof knowledgeNodes.$inferSelect;
export type InsertKnowledgeNode = typeof knowledgeNodes.$inferInsert;

// ========== 知识图谱关系/边表 ==========
export const knowledgeEdges = mysqlTable("knowledge_edges", {
  id: serial("id").primaryKey(),
  sourceId: bigint("sourceId", { mode: "number", unsigned: true }).notNull(),
  targetId: bigint("targetId", { mode: "number", unsigned: true }).notNull(),
  label: varchar("label", { length: 255 }),
  type: mysqlEnum("type", ["related", "contains", "references", "extends", "similar", "sequence"])
    .default("related")
    .notNull(),
  weight: float("weight").default(1),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
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
export const kbFolders = mysqlTable("kb_folders", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  parentId: bigint("parentId", { mode: "number", unsigned: true }),
  icon: varchar("icon", { length: 100 }).default("folder"),
  sortOrder: int("sortOrder").default(0),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => [
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
export const kbDocuments = mysqlTable("kb_documents", {
  id: serial("id").primaryKey(),
  folderId: bigint("folderId", { mode: "number", unsigned: true }),
  title: varchar("title", { length: 500 }).notNull(),
  content: text("content"),
  format: mysqlEnum("format", ["markdown", "text", "json", "html", "code"])
    .default("markdown")
    .notNull(),
  tags: json("tags").$type<string[]>(),
  metadata: json("metadata").$type<{
    wordCount?: number;
    source?: string;
    vectorized?: boolean;
    lastOpenedAt?: string;
  }>(),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => [
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
export const workflows = mysqlTable("workflows", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: mysqlEnum("status", ["draft", "active", "paused", "error", "archived"])
    .default("draft")
    .notNull(),
  // 画布配置
  canvas: json("canvas").$type<Record<string, unknown>>(),
  // 触发器配置
  triggers: json("triggers").$type<unknown[]>(),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "workflows_created_by_fk",
  }),
]);

export type Workflow = typeof workflows.$inferSelect;
export type InsertWorkflow = typeof workflows.$inferInsert;

// ========== 工作流节点表 ==========
export const workflowNodes = mysqlTable("workflow_nodes", {
  id: serial("id").primaryKey(),
  workflowId: bigint("workflowId", { mode: "number", unsigned: true }).notNull(),
  type: varchar("type", { length: 100 }).notNull(),
  label: varchar("label", { length: 255 }),
  positionX: float("positionX").default(0),
  positionY: float("positionY").default(0),
  config: json("config").$type<Record<string, unknown>>(),
  connections: json("connections").$type<unknown[]>(),
  sortOrder: int("sortOrder").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.workflowId],
    foreignColumns: [workflows.id],
    name: "workflow_nodes_wf_fk",
  }),
]);

export type WorkflowNode = typeof workflowNodes.$inferSelect;
export type InsertWorkflowNode = typeof workflowNodes.$inferInsert;

// ========== 数据源表 ==========
export const dataSources = mysqlTable("data_sources", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  type: mysqlEnum("type", [
    "cloud_drive",
    "nas",
    "database",
    "api",
    "webhook",
    "rss",
    "notion",
    "obsidian",
  ]).notNull(),
  config: json("config").$type<Record<string, unknown>>(),
  status: mysqlEnum("status", ["connected", "disconnected", "error", "syncing"])
    .default("disconnected")
    .notNull(),
  lastSyncAt: timestamp("lastSyncAt"),
  lastError: text("lastError"),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "data_sources_created_by_fk",
  }),
]);

export type DataSource = typeof dataSources.$inferSelect;
export type InsertDataSource = typeof dataSources.$inferInsert;

// ========== 上传文件表 ==========
export const uploadedFiles = mysqlTable("uploaded_files", {
  id: serial("id").primaryKey(),
  filename: varchar("filename", { length: 500 }).notNull(),
  originalName: varchar("originalName", { length: 500 }).notNull(),
  mimeType: varchar("mimeType", { length: 255 }),
  size: bigint("size", { mode: "number", unsigned: true }),
  storagePath: text("storagePath").notNull(),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  uploadedBy: bigint("uploadedBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.uploadedBy],
    foreignColumns: [users.id],
    name: "uploaded_files_user_fk",
  }),
]);

export type UploadedFile = typeof uploadedFiles.$inferSelect;
export type InsertUploadedFile = typeof uploadedFiles.$inferInsert;

// ========== 向量集合表（用于向量化模型配置） ==========
export const vectorCollections = mysqlTable("vector_collections", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  model: varchar("model", { length: 255 }).default("text-embedding-3-small"),
  dimension: int("dimension").default(1536),
  status: mysqlEnum("status", ["ready", "building", "error"])
    .default("ready")
    .notNull(),
  documentCount: int("documentCount").default(0),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [users.id],
    name: "vector_collections_created_by_fk",
  }),
]);

export type VectorCollection = typeof vectorCollections.$inferSelect;
export type InsertVectorCollection = typeof vectorCollections.$inferInsert;

// ========== 系统设置表 ==========
export const systemSettings = mysqlTable("system_settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 255 }).notNull().unique(),
  value: text("value"),
  category: varchar("category", { length: 100 }).default("general"),
  updatedBy: bigint("updatedBy", { mode: "number", unsigned: true }),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    columns: [table.updatedBy],
    foreignColumns: [users.id],
    name: "system_settings_user_fk",
  }),
]);

export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;
