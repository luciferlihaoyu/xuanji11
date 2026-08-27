CREATE TABLE `agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'assistant' NOT NULL,
	`avatarUrl` text,
	`status` text DEFAULT 'active' NOT NULL,
	`config` text,
	`permissions` text,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agents_created_by_idx` ON `agents` (`createdBy`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`keyHash` text NOT NULL,
	`keyPrefix` text NOT NULL,
	`agentId` integer NOT NULL,
	`permissions` text,
	`scopes` text,
	`isActive` text DEFAULT 'true' NOT NULL,
	`expiresAt` integer,
	`lastUsedAt` integer,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_keyHash_unique` ON `api_keys` (`keyHash`);--> statement-breakpoint
CREATE INDEX `apiKeys_agentId_idx` ON `api_keys` (`agentId`);--> statement-breakpoint
CREATE INDEX `apiKeys_keyPrefix_idx` ON `api_keys` (`keyPrefix`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entityType` text NOT NULL,
	`entityId` integer NOT NULL,
	`action` text NOT NULL,
	`actorId` integer,
	`details` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `auditLogs_entity_idx` ON `audit_logs` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `auditLogs_actor_idx` ON `audit_logs` (`actorId`);--> statement-breakpoint
CREATE TABLE `backup_job_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`relativePath` text NOT NULL,
	`size` integer,
	`checksum` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`jobId`) REFERENCES `backup_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `backupJobFiles_jobId_idx` ON `backup_job_files` (`jobId`);--> statement-breakpoint
CREATE TABLE `backup_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target` text NOT NULL,
	`sourcePath` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress` integer DEFAULT 0,
	`filesTotal` integer DEFAULT 0,
	`filesDone` integer DEFAULT 0,
	`filesFailed` integer DEFAULT 0,
	`manifest` text,
	`config` text,
	`cron` text,
	`enabled` text DEFAULT 'false' NOT NULL,
	`nextRunAt` integer,
	`keepLastN` integer DEFAULT 7,
	`maxRetries` integer DEFAULT 3,
	`retryCount` integer DEFAULT 0,
	`error` text,
	`startedAt` integer,
	`completedAt` integer,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `backupJobs_target_idx` ON `backup_jobs` (`target`);--> statement-breakpoint
CREATE INDEX `backupJobs_status_idx` ON `backup_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `backupJobs_createdBy_idx` ON `backup_jobs` (`createdBy`);--> statement-breakpoint
CREATE INDEX `backupJobs_enabled_nextRun_idx` ON `backup_jobs` (`enabled`,`nextRunAt`);--> statement-breakpoint
CREATE TABLE `data_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`lastSyncAt` integer,
	`lastError` text,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dataSources_type_idx` ON `data_sources` (`type`);--> statement-breakpoint
CREATE INDEX `dataSources_createdBy_idx` ON `data_sources` (`createdBy`);--> statement-breakpoint
CREATE TABLE `document_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`documentId` integer NOT NULL,
	`itemId` integer,
	`content` text NOT NULL,
	`chunkIndex` integer DEFAULT 0 NOT NULL,
	`embedding` text,
	`embeddingModel` text,
	`metadata` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`documentId`) REFERENCES `kb_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `documentChunks_documentId_idx` ON `document_chunks` (`documentId`);--> statement-breakpoint
CREATE INDEX `documentChunks_itemId_idx` ON `document_chunks` (`itemId`);--> statement-breakpoint
CREATE TABLE `ingestion_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`externalId` text,
	`name` text NOT NULL,
	`mimeType` text,
	`size` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`sourceUrl` text,
	`storagePath` text,
	`documentId` integer,
	`metadata` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`jobId`) REFERENCES `ingestion_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ingestionItems_jobId_idx` ON `ingestion_items` (`jobId`);--> statement-breakpoint
CREATE INDEX `ingestionItems_status_idx` ON `ingestion_items` (`status`);--> statement-breakpoint
CREATE INDEX `ingestionItems_documentId_idx` ON `ingestion_items` (`documentId`);--> statement-breakpoint
CREATE TABLE `ingestion_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sourceType` text NOT NULL,
	`sourceId` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`totalItems` integer DEFAULT 0,
	`processedItems` integer DEFAULT 0,
	`failedItems` integer DEFAULT 0,
	`error` text,
	`retryCount` integer DEFAULT 0,
	`metadata` text,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ingestionJobs_sourceType_idx` ON `ingestion_jobs` (`sourceType`);--> statement-breakpoint
CREATE INDEX `ingestionJobs_status_idx` ON `ingestion_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `ingestionJobs_createdBy_idx` ON `ingestion_jobs` (`createdBy`);--> statement-breakpoint
CREATE TABLE `kb_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`folderId` integer,
	`title` text NOT NULL,
	`content` text,
	`format` text DEFAULT 'markdown' NOT NULL,
	`tags` text,
	`metadata` text,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`folderId`) REFERENCES `kb_folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `kbDocuments_createdBy_idx` ON `kb_documents` (`createdBy`);--> statement-breakpoint
CREATE INDEX `kbDocuments_folderId_idx` ON `kb_documents` (`folderId`);--> statement-breakpoint
CREATE TABLE `kb_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`parentId` integer,
	`icon` text DEFAULT 'folder',
	`sortOrder` integer DEFAULT 0,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`parentId`) REFERENCES `kb_folders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `kbFolders_createdBy_idx` ON `kb_folders` (`createdBy`);--> statement-breakpoint
CREATE INDEX `kbFolders_parentId_idx` ON `kb_folders` (`parentId`);--> statement-breakpoint
CREATE TABLE `knowledge_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sourceId` integer NOT NULL,
	`targetId` integer NOT NULL,
	`label` text,
	`type` text DEFAULT 'related' NOT NULL,
	`weight` real DEFAULT 1,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sourceId`) REFERENCES `knowledge_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`targetId`) REFERENCES `knowledge_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `knowledgeEdges_targetId_idx` ON `knowledge_edges` (`targetId`);--> statement-breakpoint
CREATE INDEX `knowledgeEdges_sourceId_idx` ON `knowledge_edges` (`sourceId`);--> statement-breakpoint
CREATE TABLE `knowledge_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`type` text DEFAULT 'concept' NOT NULL,
	`posX` real DEFAULT 0,
	`posY` real DEFAULT 0,
	`style` text,
	`metadata` text,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `knowledgeNodes_createdBy_idx` ON `knowledge_nodes` (`createdBy`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`authToken` text,
	`enabled` integer DEFAULT true NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `restore_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`backupJobId` integer NOT NULL,
	`targetPath` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress` integer DEFAULT 0,
	`filesTotal` integer DEFAULT 0,
	`filesDone` integer DEFAULT 0,
	`filesFailed` integer DEFAULT 0,
	`manifestVerified` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`startedAt` integer,
	`completedAt` integer,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`backupJobId`) REFERENCES `backup_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `restoreJobs_backupJobId_idx` ON `restore_jobs` (`backupJobId`);--> statement-breakpoint
CREATE INDEX `restoreJobs_status_idx` ON `restore_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `system_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`category` text DEFAULT 'general',
	`updatedBy` integer,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_settings_key_unique` ON `system_settings` (`key`);--> statement-breakpoint
CREATE INDEX `systemSettings_key_idx` ON `system_settings` (`key`);--> statement-breakpoint
CREATE INDEX `systemSettings_category_idx` ON `system_settings` (`category`);--> statement-breakpoint
CREATE TABLE `uploaded_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`originalName` text NOT NULL,
	`mimeType` text,
	`size` integer,
	`storagePath` text NOT NULL,
	`metadata` text,
	`uploadedBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`uploadedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `uploadedFiles_uploadedBy_idx` ON `uploaded_files` (`uploadedBy`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`unionId` text NOT NULL,
	`name` text,
	`email` text,
	`avatar` text,
	`role` text DEFAULT 'user' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`lastSignInAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_unionId_unique` ON `users` (`unionId`);--> statement-breakpoint
CREATE TABLE `vector_collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`model` text DEFAULT 'text-embedding-3-small',
	`dimension` integer DEFAULT 1536,
	`status` text DEFAULT 'ready' NOT NULL,
	`documentCount` integer DEFAULT 0,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vectorCollections_createdBy_idx` ON `vector_collections` (`createdBy`);--> statement-breakpoint
CREATE TABLE `workflow_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflowId` integer NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`positionX` real DEFAULT 0,
	`positionY` real DEFAULT 0,
	`config` text,
	`connections` text,
	`sortOrder` integer DEFAULT 0,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workflowId`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflowNodes_workflowId_idx` ON `workflow_nodes` (`workflowId`);--> statement-breakpoint
CREATE TABLE `workflow_run_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`runId` integer NOT NULL,
	`nodeId` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`startedAt` integer,
	`completedAt` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`runId`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`nodeId`) REFERENCES `workflow_nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflowRunNodes_runId_idx` ON `workflow_run_nodes` (`runId`);--> statement-breakpoint
CREATE INDEX `workflowRunNodes_nodeId_idx` ON `workflow_run_nodes` (`nodeId`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflowId` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`triggeredBy` text DEFAULT 'manual' NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`startedAt` integer,
	`completedAt` integer,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workflowId`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflowRuns_workflowId_idx` ON `workflow_runs` (`workflowId`);--> statement-breakpoint
CREATE INDEX `workflowRuns_status_idx` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`canvas` text,
	`triggers` text,
	`createdBy` integer,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflows_createdBy_idx` ON `workflows` (`createdBy`);