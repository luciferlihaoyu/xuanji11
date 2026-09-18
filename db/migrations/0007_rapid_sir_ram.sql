CREATE TABLE `kb_eval_cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query` text NOT NULL,
	`expectedDocIds` text NOT NULL,
	`note` text,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kbEvalCases_query_idx` ON `kb_eval_cases` (`query`);
