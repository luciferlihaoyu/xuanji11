-- Add lifecycle tables for ingestion, chunks, backup/restore, and workflow runs
-- This migration is additive only; existing tables are not modified.

CREATE TABLE IF NOT EXISTS `ingestion_jobs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `sourceType` enum('upload','datasource','backup','manual') NOT NULL,
  `sourceId` varchar(255) DEFAULT NULL,
  `status` enum('pending','running','completed','failed','cancelled') DEFAULT 'pending' NOT NULL,
  `totalItems` int DEFAULT 0,
  `processedItems` int DEFAULT 0,
  `failedItems` int DEFAULT 0,
  `error` text DEFAULT NULL,
  `retryCount` int DEFAULT 0,
  `metadata` json DEFAULT NULL,
  `createdBy` bigint unsigned DEFAULT NULL,
  `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updatedAt` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ingestionJobs_sourceType_idx` (`sourceType`),
  KEY `ingestionJobs_status_idx` (`status`),
  KEY `ingestionJobs_createdBy_idx` (`createdBy`)
);

CREATE TABLE IF NOT EXISTS `ingestion_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `jobId` bigint unsigned NOT NULL,
  `externalId` varchar(500) DEFAULT NULL,
  `name` varchar(500) NOT NULL,
  `mimeType` varchar(255) DEFAULT NULL,
  `size` bigint unsigned DEFAULT NULL,
  `status` enum('pending','parsing','chunking','indexing','completed','failed','unsupported') DEFAULT 'pending' NOT NULL,
  `error` text DEFAULT NULL,
  `sourceUrl` text DEFAULT NULL,
  `storagePath` text DEFAULT NULL,
  `documentId` bigint unsigned DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updatedAt` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ingestionItems_jobId_idx` (`jobId`),
  KEY `ingestionItems_status_idx` (`status`),
  KEY `ingestionItems_documentId_idx` (`documentId`)
);

CREATE TABLE IF NOT EXISTS `document_chunks` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `documentId` bigint unsigned NOT NULL,
  `itemId` bigint unsigned DEFAULT NULL,
  `content` text NOT NULL,
  `chunkIndex` int DEFAULT 0 NOT NULL,
  `embedding` json DEFAULT NULL,
  `embeddingModel` varchar(255) DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`),
  KEY `documentChunks_documentId_idx` (`documentId`),
  KEY `documentChunks_itemId_idx` (`itemId`)
);

CREATE TABLE IF NOT EXISTS `backup_jobs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `target` varchar(100) NOT NULL,
  `sourcePath` text NOT NULL,
  `status` enum('pending','running','completed','failed','partial') DEFAULT 'pending' NOT NULL,
  `progress` int DEFAULT 0,
  `filesTotal` int DEFAULT 0,
  `filesDone` int DEFAULT 0,
  `filesFailed` int DEFAULT 0,
  `manifest` json DEFAULT NULL,
  `error` text DEFAULT NULL,
  `startedAt` timestamp NULL DEFAULT NULL,
  `completedAt` timestamp NULL DEFAULT NULL,
  `createdBy` bigint unsigned DEFAULT NULL,
  `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updatedAt` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`),
  KEY `backupJobs_target_idx` (`target`),
  KEY `backupJobs_status_idx` (`status`),
  KEY `backupJobs_createdBy_idx` (`createdBy`)
);

CREATE TABLE IF NOT EXISTS `backup_job_files` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `jobId` bigint unsigned NOT NULL,
  `relativePath` text NOT NULL,
  `size` bigint unsigned DEFAULT NULL,
  `checksum` varchar(255) DEFAULT NULL,
  `status` enum('pending','uploaded','failed') DEFAULT 'pending' NOT NULL,
  `error` text DEFAULT NULL,
  `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`),
  KEY `backupJobFiles_jobId_idx` (`jobId`)
);

CREATE TABLE IF NOT EXISTS `restore_jobs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `backupJobId` bigint unsigned NOT NULL,
  `targetPath` text NOT NULL,
  `status` enum('pending','running','completed','failed','partial') DEFAULT 'pending' NOT NULL,
  `progress` int DEFAULT 0,
  `filesTotal` int DEFAULT 0,
  `filesDone` int DEFAULT 0,
  `filesFailed` int DEFAULT 0,
  `manifestVerified` enum('pending','passed','failed') DEFAULT 'pending' NOT NULL,
  `error` text DEFAULT NULL,
  `startedAt` timestamp NULL DEFAULT NULL,
  `completedAt` timestamp NULL DEFAULT NULL,
  `createdBy` bigint unsigned DEFAULT NULL,
  `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updatedAt` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`),
  KEY `restoreJobs_backupJobId_idx` (`backupJobId`),
  KEY `restoreJobs_status_idx` (`status`)
);

CREATE TABLE IF NOT EXISTS `workflow_runs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `workflowId` bigint unsigned NOT NULL,
  `status` enum('pending','running','completed','failed','cancelled') DEFAULT 'pending' NOT NULL,
  `triggeredBy` enum('manual','api','cron','webhook') DEFAULT 'manual' NOT NULL,
  `input` json DEFAULT NULL,
  `output` json DEFAULT NULL,
  `error` text DEFAULT NULL,
  `startedAt` timestamp NULL DEFAULT NULL,
  `completedAt` timestamp NULL DEFAULT NULL,
  `createdBy` bigint unsigned DEFAULT NULL,
  `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`),
  KEY `workflowRuns_workflowId_idx` (`workflowId`),
  KEY `workflowRuns_status_idx` (`status`)
);

CREATE TABLE IF NOT EXISTS `workflow_run_nodes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `runId` bigint unsigned NOT NULL,
  `nodeId` bigint unsigned NOT NULL,
  `status` enum('pending','running','completed','failed','skipped') DEFAULT 'pending' NOT NULL,
  `input` json DEFAULT NULL,
  `output` json DEFAULT NULL,
  `error` text DEFAULT NULL,
  `startedAt` timestamp NULL DEFAULT NULL,
  `completedAt` timestamp NULL DEFAULT NULL,
  `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`id`),
  KEY `workflowRunNodes_runId_idx` (`runId`),
  KEY `workflowRunNodes_nodeId_idx` (`nodeId`)
);
