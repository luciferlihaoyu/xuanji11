ALTER TABLE `kb_documents` ADD `deletedAt` integer;--> statement-breakpoint
ALTER TABLE `kb_documents` ADD `deletedReason` text;--> statement-breakpoint
ALTER TABLE `kb_documents` ADD `mergedIntoId` integer;--> statement-breakpoint
CREATE INDEX `kbDocuments_deletedAt_idx` ON `kb_documents` (`deletedAt`);