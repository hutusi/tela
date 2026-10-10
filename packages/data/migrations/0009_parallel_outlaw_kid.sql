-- Widens site_claims_method_check (ADR 0045). SQLite changes a CHECK only by rebuilding the
-- table. The checks name their columns bare: qualified with `__new_site_claims`, as drizzle-kit
-- writes them, the rename fails ("no such column: __new_site_claims.method"). Nothing references
-- site_claims, so its foreign keys need deferring only for D1, which ignores foreign_keys=OFF.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_site_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`method` text NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_checked_at` integer,
	`error` text,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	`vouched_by` text,
	`reviewed_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vouched_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "site_claims_method_check" CHECK("method" in ('meta', 'rel_me', 'link', 'github', 'dns')),
	CONSTRAINT "site_claims_status_check" CHECK("status" in ('pending', 'verified', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_site_claims`("id", "site_id", "user_id", "method", "token", "status", "last_checked_at", "error", "verified_at", "created_at", "vouched_by", "reviewed_at", "seq") SELECT "id", "site_id", "user_id", "method", "token", "status", "last_checked_at", "error", "verified_at", "created_at", "vouched_by", "reviewed_at", "seq" FROM `site_claims`;--> statement-breakpoint
DROP TABLE `site_claims`;--> statement-breakpoint
ALTER TABLE `__new_site_claims` RENAME TO `site_claims`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE UNIQUE INDEX `site_claims_site_user_idx` ON `site_claims` (`site_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `site_claims_user_idx` ON `site_claims` (`user_id`);