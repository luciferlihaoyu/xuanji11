CREATE TABLE `kb_document_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`documentId` integer NOT NULL,
	`versionNumber` integer NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`format` text DEFAULT 'markdown' NOT NULL,
	`tags` text,
	`contentHash` text NOT NULL,
	`source` text,
	`changedBy` integer,
	`changeReason` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`documentId`) REFERENCES `kb_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `kb_doc_versions_documentId_idx` ON `kb_document_versions` (`documentId`);--> statement-breakpoint
CREATE INDEX `kb_doc_versions_hash_idx` ON `kb_document_versions` (`contentHash`);