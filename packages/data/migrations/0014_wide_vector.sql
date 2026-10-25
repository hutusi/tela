CREATE TABLE `ops_alerts` (
	`day` text NOT NULL,
	`name` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`day`, `name`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "settings_value_check" CHECK(json_valid("settings"."value"))
);
--> statement-breakpoint
CREATE TABLE `reports` (
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
	CONSTRAINT "reports_target_kind_check" CHECK("reports"."target_kind" in ('profile', 'blogroll', 'site', 'recommendation')),
	CONSTRAINT "reports_reason_check" CHECK("reports"."reason" in ('spam', 'abuse', 'impersonation', 'copyright', 'illegal', 'other')),
	CONSTRAINT "reports_state_check" CHECK("reports"."state" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "reports_details_check" CHECK("reports"."details" is null or length("reports"."details") <= 1000)
);
--> statement-breakpoint
CREATE INDEX `reports_state_created_idx` ON `reports` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_target_idx` ON `reports` (`target_kind`,`target_key`);--> statement-breakpoint
CREATE INDEX `reports_reporter_idx` ON `reports` (`reporter_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pending_feeds` (
	`user_id` text NOT NULL,
	`feed_url` text NOT NULL,
	`title` text,
	`queued_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `feed_url`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_feeds_queued_idx` ON `pending_feeds` (`queued_at`);--> statement-breakpoint
CREATE TABLE `robots_rules` (
	`origin` text PRIMARY KEY NOT NULL,
	`status` integer NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `articles` ADD `extract_refused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `body_translations` ADD `due_at` integer;--> statement-breakpoint
ALTER TABLE `profiles` ADD `suspended_at` integer;--> statement-breakpoint
ALTER TABLE `profiles` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `profiles` ADD `erased_at` integer;--> statement-breakpoint
CREATE INDEX `profiles_created_idx` ON `profiles` (`created_at`);--> statement-breakpoint
ALTER TABLE `sites` ADD `feed_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_daily` ADD `requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `usage_daily_day_idx` ON `usage_daily` (`day`);--> statement-breakpoint
CREATE INDEX `feeds_added_by_created_idx` ON `feeds` (`added_by`,`created_at`);