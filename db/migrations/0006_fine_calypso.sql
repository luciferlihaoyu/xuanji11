CREATE TABLE `local_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`passwordHash` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`lastSignInAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_accounts_username_unique` ON `local_accounts` (`username`);