CREATE TABLE `blogroll_blogs` (
	`blogroll_id` text NOT NULL,
	`feed_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`note` text,
	`note_at` integer DEFAULT 0 NOT NULL,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`blogroll_id`, `feed_id`),
	FOREIGN KEY (`blogroll_id`) REFERENCES `blogrolls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "blogroll_blogs_note_check" CHECK("blogroll_blogs"."note" is null or length("blogroll_blogs"."note") between 1 and 280)
);
--> statement-breakpoint
CREATE INDEX `blogroll_blogs_user_seq_idx` ON `blogroll_blogs` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `blogroll_blogs_feed_idx` ON `blogroll_blogs` (`feed_id`);--> statement-breakpoint
CREATE TABLE `blogrolls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`public_version` integer DEFAULT 0 NOT NULL,
	`public_since` integer,
	`hidden_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "blogrolls_name_check" CHECK(length("blogrolls"."name") between 1 and 60),
	CONSTRAINT "blogrolls_description_check" CHECK(length("blogrolls"."description") <= 280)
);
--> statement-breakpoint
CREATE INDEX `blogrolls_user_seq_idx` ON `blogrolls` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `blogrolls_discover_idx` ON `blogrolls` (`is_public`,`public_since`,`id`);