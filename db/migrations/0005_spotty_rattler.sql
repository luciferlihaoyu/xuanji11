CREATE TABLE `kb_search_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query` text NOT NULL,
	`documentId` integer,
	`event` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kbSearchEvents_query_idx` ON `kb_search_events` (`query`);--> statement-breakpoint
CREATE INDEX `kbSearchEvents_doc_idx` ON `kb_search_events` (`documentId`);