CREATE TABLE `admin_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_key` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "admin_actions_detail_check" CHECK(json_valid("admin_actions"."detail"))
);
--> statement-breakpoint
CREATE INDEX `admin_actions_at_idx` ON `admin_actions` (`at`);--> statement-breakpoint
CREATE INDEX `admin_actions_target_idx` ON `admin_actions` (`target_kind`,`target_key`,`at`);--> statement-breakpoint
CREATE INDEX `admin_actions_group_idx` ON `admin_actions` (`group_id`);--> statement-breakpoint
ALTER TABLE `dead_letters` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `dead_letters` ADD `resolution` text;--> statement-breakpoint
ALTER TABLE `dead_letters` ADD `resolved_by` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `dead_letters_resolved_idx` ON `dead_letters` (`resolved_at`,`at`);--> statement-breakpoint
ALTER TABLE `site_claims` ADD `vouched_by` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `site_claims` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `feed_id` integer REFERENCES feeds(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `llm_calls_feed_created_idx` ON `llm_calls` (`feed_id`,`created_at`);--> statement-breakpoint
UPDATE `llm_calls` SET `feed_id` = (SELECT `feed_id` FROM `articles` WHERE `articles`.`id` = `llm_calls`.`article_id`) WHERE `feed_id` IS NULL AND `article_id` IS NOT NULL;--> statement-breakpoint
UPDATE `llm_calls` SET `feed_id` = (SELECT `feed_id` FROM `articles` WHERE `articles`.`content_key` = `llm_calls`.`content_key` ORDER BY `articles`.`id` LIMIT 1) WHERE `feed_id` IS NULL AND `content_key` IS NOT NULL;
