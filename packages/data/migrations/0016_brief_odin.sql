-- Adds the report target `app` (ADR 0067), which widens reports_target_kind_check. SQLite changes
-- a CHECK only by rebuilding the table. As in migration 0009, the checks name their columns bare
-- (qualified with `__new_reports`, as drizzle-kit writes them, the rename fails), and foreign keys
-- are deferred, which D1 needs since it ignores foreign_keys=OFF. Nothing references reports, so
-- the drop cascades nowhere. `apps` only gains columns: changing one of its CHECKs would rebuild
-- it, and on D1 that DROP TABLE would cascade into every connection, token and code.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reporter_id` text,
	`target_kind` text NOT NULL,
	`target_key` text NOT NULL,
	`reason` text NOT NULL,
	`details` text,
	`url` text,
	`state` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	FOREIGN KEY (`reporter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "reports_target_kind_check" CHECK("target_kind" in ('profile', 'blogroll', 'site', 'recommendation', 'app')),
	CONSTRAINT "reports_reason_check" CHECK("reason" in ('spam', 'abuse', 'impersonation', 'copyright', 'illegal', 'other')),
	CONSTRAINT "reports_state_check" CHECK("state" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "reports_details_check" CHECK("details" is null or length("details") <= 1000)
);
--> statement-breakpoint
INSERT INTO `__new_reports`("id", "reporter_id", "target_kind", "target_key", "reason", "details", "url", "state", "created_at", "resolved_at", "resolved_by") SELECT "id", "reporter_id", "target_kind", "target_key", "reason", "details", "url", "state", "created_at", "resolved_at", "resolved_by" FROM `reports`;--> statement-breakpoint
DROP TABLE `reports`;--> statement-breakpoint
ALTER TABLE `__new_reports` RENAME TO `reports`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE INDEX `reports_state_created_idx` ON `reports` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_target_idx` ON `reports` (`target_kind`,`target_key`);--> statement-breakpoint
CREATE INDEX `reports_reporter_idx` ON `reports` (`reporter_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `apps` ADD `developer_id` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `reviewed_by` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `review_requested_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `review_note` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `review_wants_email` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `terms_at` integer;--> statement-breakpoint
CREATE INDEX `apps_developer_idx` ON `apps` (`developer_id`);--> statement-breakpoint
-- Every app so far was registered by the operator, so each counts as reviewed, by whoever last
-- created or approved it in the console (the admin ledger, as migration 0010 carried decisions).
UPDATE `apps` SET `reviewed_at` = coalesce(`approved_at`, `created_at`),
  `reviewed_by` = (SELECT `actor_id` FROM `admin_actions`
    WHERE `target_kind` = 'app' AND `target_key` = CAST(`apps`.`id` AS TEXT)
      AND `action` IN ('app.create', 'app.approve')
    ORDER BY `id` DESC LIMIT 1);
