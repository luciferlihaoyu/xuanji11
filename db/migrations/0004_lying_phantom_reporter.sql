CREATE TABLE `kb_review_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`documentId` integer,
	`relatedDocumentId` integer,
	`title` text NOT NULL,
	`payload` text,
	`confidence` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolverNote` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolvedAt` integer
);
--> statement-breakpoint
CREATE INDEX `kb_review_items_status_idx` ON `kb_review_items` (`status`);--> statement-breakpoint
CREATE INDEX `kb_review_items_kind_idx` ON `kb_review_items` (`kind`);--> statement-breakpoint
CREATE INDEX `kb_review_items_documentId_idx` ON `kb_review_items` (`documentId`);