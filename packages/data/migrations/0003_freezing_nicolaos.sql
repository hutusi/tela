ALTER TABLE `profiles` ADD `gravatar` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `gravatar_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `avatar_version` integer DEFAULT 0 NOT NULL;