CREATE TABLE `app_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'code' NOT NULL,
	`app_id` integer NOT NULL,
	`user_id` text,
	`scope` text NOT NULL,
	`email` integer DEFAULT false NOT NULL,
	`redirect_uri` text,
	`code_challenge` text,
	`minted_token_id` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`minted_token_id`) REFERENCES `app_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "app_codes_kind_check" CHECK("app_codes"."kind" in ('code', 'device')),
	CONSTRAINT "app_codes_scope_check" CHECK("app_codes"."scope" in ('read', 'write'))
);
--> statement-breakpoint
CREATE INDEX `app_codes_expires_idx` ON `app_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `app_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`email` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer,
	`ended_at` integer,
	`end_reason` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "app_grants_scope_check" CHECK("app_grants"."scope" in ('read', 'write')),
	CONSTRAINT "app_grants_end_reason_check" CHECK("app_grants"."end_reason" is null or "app_grants"."end_reason" in ('disconnected', 'password', 'link', 'signOutEverywhere', 'operatorSignOut', 'suspended', 'closed', 'appEnded', 'reuse', 'revoked', 'replaced'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_grants_live_idx` ON `app_grants` (`app_id`,`user_id`) WHERE "app_grants"."ended_at" is null;--> statement-breakpoint
CREATE INDEX `app_grants_user_idx` ON `app_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `app_refresh_spent` (
	`hash` text PRIMARY KEY NOT NULL,
	`token_id` integer NOT NULL,
	`replaced_at` integer NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `app_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_refresh_spent_token_idx` ON `app_refresh_spent` (`token_id`);--> statement-breakpoint
CREATE TABLE `app_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`grant_id` integer NOT NULL,
	`kind` text DEFAULT 'oauth' NOT NULL,
	`scope` text NOT NULL,
	`email` integer DEFAULT false NOT NULL,
	`access_hash` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_hash` text,
	`refresh_idle_expires_at` integer,
	`rotated_at` integer,
	`pristine` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`ended_at` integer,
	`end_reason` text,
	FOREIGN KEY (`grant_id`) REFERENCES `app_grants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "app_tokens_kind_check" CHECK("app_tokens"."kind" in ('oauth', 'personal')),
	CONSTRAINT "app_tokens_scope_check" CHECK("app_tokens"."scope" in ('read', 'write')),
	CONSTRAINT "app_tokens_end_reason_check" CHECK("app_tokens"."end_reason" is null or "app_tokens"."end_reason" in ('disconnected', 'password', 'link', 'signOutEverywhere', 'operatorSignOut', 'suspended', 'closed', 'appEnded', 'reuse', 'revoked', 'replaced'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_tokens_accessHash_unique` ON `app_tokens` (`access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_tokens_refreshHash_unique` ON `app_tokens` (`refresh_hash`);--> statement-breakpoint
CREATE INDEX `app_tokens_grant_idx` ON `app_tokens` (`grant_id`);--> statement-breakpoint
CREATE TABLE `apps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`developer` text NOT NULL,
	`contact_email` text NOT NULL,
	`homepage_url` text,
	`privacy_url` text,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`grant_types` text DEFAULT '["code"]' NOT NULL,
	`max_scope` text DEFAULT 'read' NOT NULL,
	`allow_email` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`owner_user_id` text,
	`per_member_per_min` integer,
	`per_app_per_min` integer,
	`max_connections` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`approved_at` integer,
	`suspended_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "apps_status_check" CHECK("apps"."status" in ('draft', 'approved', 'suspended')),
	CONSTRAINT "apps_max_scope_check" CHECK("apps"."max_scope" in ('read', 'write')),
	CONSTRAINT "apps_redirect_uris_check" CHECK(json_valid("apps"."redirect_uris")),
	CONSTRAINT "apps_grant_types_check" CHECK(json_valid("apps"."grant_types")),
	CONSTRAINT "apps_name_check" CHECK(length("apps"."name") between 1 and 80),
	CONSTRAINT "apps_developer_check" CHECK(length("apps"."developer") between 1 and 300),
	CONSTRAINT "apps_urls_check" CHECK(coalesce(length("apps"."homepage_url"), 0) <= 500
        and coalesce(length("apps"."privacy_url"), 0) <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_clientId_unique` ON `apps` (`client_id`);--> statement-breakpoint
CREATE INDEX `apps_status_idx` ON `apps` (`status`);--> statement-breakpoint
CREATE TABLE `post_opens` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`content_key` text NOT NULL,
	`opened_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `day`, `content_key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_opens_day_idx` ON `post_opens` (`day`);