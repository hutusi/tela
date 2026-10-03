CREATE TABLE `invite_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`created_by` text,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invite_codes_code_check" CHECK(length("invite_codes"."code") between 4 and 32 and "invite_codes"."code" not glob '*[^A-Z0-9]*'),
	CONSTRAINT "invite_codes_max_uses_check" CHECK("invite_codes"."max_uses" between 1 and 100000)
);
--> statement-breakpoint
CREATE INDEX `invite_codes_created_by_idx` ON `invite_codes` (`created_by`);--> statement-breakpoint
CREATE TABLE `invite_redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	`user_id` text,
	`settled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`code`) REFERENCES `invite_codes`(`code`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_redemptions_code_email_idx` ON `invite_redemptions` (`code`,`email`);--> statement-breakpoint
CREATE INDEX `invite_redemptions_email_idx` ON `invite_redemptions` (`email`);--> statement-breakpoint
CREATE INDEX `invite_redemptions_code_redeemed_idx` ON `invite_redemptions` (`code`,`redeemed_at`);--> statement-breakpoint
CREATE INDEX `invite_redemptions_user_idx` ON `invite_redemptions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_idx` ON `account` (`provider_id`,`account_id`);