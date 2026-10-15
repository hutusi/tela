CREATE TABLE `feed_folders` (
	`user_id` text NOT NULL,
	`feed_id` integer NOT NULL,
	`folder_id` text,
	`updated_at` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `feed_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `feed_folders_user_seq_idx` ON `feed_folders` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `feed_folders_folder_idx` ON `feed_folders` (`folder_id`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "folders_name_check" CHECK(length("folders"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE INDEX `folders_user_seq_idx` ON `folders` (`user_id`,`seq`);