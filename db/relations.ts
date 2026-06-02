import { relations } from "drizzle-orm";
import {
  users,
  agents,
  knowledgeNodes,
  knowledgeEdges,
  kbFolders,
  kbDocuments,
  workflows,
  workflowNodes,
  dataSources,
  uploadedFiles,
  vectorCollections,
} from "./schema";

// ========== 用户关系 ==========
export const usersRelations = relations(users, ({ many }) => ({
  agents: many(agents),
  knowledgeNodes: many(knowledgeNodes),
  kbFolders: many(kbFolders),
  kbDocuments: many(kbDocuments),
  workflows: many(workflows),
  dataSources: many(dataSources),
  uploadedFiles: many(uploadedFiles),
  vectorCollections: many(vectorCollections),
}));

// ========== Agent关系 ==========
export const agentsRelations = relations(agents, ({ one }) => ({
  creator: one(users, { fields: [agents.createdBy], references: [users.id] }),
}));

// ========== 知识节点关系 ==========
export const knowledgeNodesRelations = relations(knowledgeNodes, ({ one, many }) => ({
  creator: one(users, { fields: [knowledgeNodes.createdBy], references: [users.id] }),
  outgoingEdges: many(knowledgeEdges, { relationName: "source" }),
  incomingEdges: many(knowledgeEdges, { relationName: "target" }),
}));

// ========== 知识边关系 ==========
export const knowledgeEdgesRelations = relations(knowledgeEdges, ({ one }) => ({
  source: one(knowledgeNodes, {
    fields: [knowledgeEdges.sourceId],
    references: [knowledgeNodes.id],
    relationName: "source",
  }),
  target: one(knowledgeNodes, {
    fields: [knowledgeEdges.targetId],
    references: [knowledgeNodes.id],
    relationName: "target",
  }),
  creator: one(users, { fields: [knowledgeEdges.createdBy], references: [users.id] }),
}));

// ========== 知识库文件夹关系 ==========
export const kbFoldersRelations = relations(kbFolders, ({ one, many }) => ({
  parent: one(kbFolders, { fields: [kbFolders.parentId], references: [kbFolders.id] }),
  children: many(kbFolders),
  documents: many(kbDocuments),
  creator: one(users, { fields: [kbFolders.createdBy], references: [users.id] }),
}));

// ========== 知识库文档关系 ==========
export const kbDocumentsRelations = relations(kbDocuments, ({ one }) => ({
  folder: one(kbFolders, { fields: [kbDocuments.folderId], references: [kbFolders.id] }),
  creator: one(users, { fields: [kbDocuments.createdBy], references: [users.id] }),
}));

// ========== 工作流关系 ==========
export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  creator: one(users, { fields: [workflows.createdBy], references: [users.id] }),
  nodes: many(workflowNodes),
}));

// ========== 工作流节点关系 ==========
export const workflowNodesRelations = relations(workflowNodes, ({ one }) => ({
  workflow: one(workflows, { fields: [workflowNodes.workflowId], references: [workflows.id] }),
}));

// ========== 数据源关系 ==========
export const dataSourcesRelations = relations(dataSources, ({ one }) => ({
  creator: one(users, { fields: [dataSources.createdBy], references: [users.id] }),
}));

// ========== 上传文件关系 ==========
export const uploadedFilesRelations = relations(uploadedFiles, ({ one }) => ({
  uploader: one(users, { fields: [uploadedFiles.uploadedBy], references: [users.id] }),
}));

// ========== 向量集合关系 ==========
export const vectorCollectionsRelations = relations(vectorCollections, ({ one }) => ({
  creator: one(users, { fields: [vectorCollections.createdBy], references: [users.id] }),
}));
