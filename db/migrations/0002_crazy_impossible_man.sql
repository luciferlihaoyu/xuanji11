CREATE TABLE `kb_ingestion_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`idempotencyKey` text NOT NULL,
	`documentId` integer NOT NULL,
	`source` text NOT NULL,
	`externalId` text,
	`contentHash` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`documentId`) REFERENCES `kb_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kb_ingestion_keys_idempotencyKey_unique` ON `kb_ingestion_keys` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `kb_ingestion_keys_documentId_idx` ON `kb_ingestion_keys` (`documentId`);--> statement-breakpoint
CREATE INDEX `kb_ingestion_keys_hash_idx` ON `kb_ingestion_keys` (`contentHash`);