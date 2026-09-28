CREATE TABLE `article_titles` (
	`article_id` integer NOT NULL,
	`lang` text NOT NULL,
	`feed_id` integer NOT NULL,
	`title` text,
	`excerpt` text,
	`status` text NOT NULL,
	`source_hash` text NOT NULL,
	`model` text,
	`updated_at` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`article_id`, `lang`),
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "article_titles_status_check" CHECK("article_titles"."status" in ('done', 'echo', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `article_titles_feed_seq_idx` ON `article_titles` (`feed_id`,`seq`);--> statement-breakpoint
CREATE TABLE `article_versions` (
	`article_id` integer NOT NULL,
	`version` integer NOT NULL,
	`provenance` text NOT NULL,
	`content_key` text NOT NULL,
	`raw_key` text,
	`norm_version` integer NOT NULL,
	`body_chars` integer NOT NULL,
	`excerpt` text,
	`word_count` integer DEFAULT 0 NOT NULL,
	`reading_minutes` integer DEFAULT 0 NOT NULL,
	`lang` text,
	`source_url` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`article_id`, `version`),
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "article_versions_provenance_check" CHECK("article_versions"."provenance" in ('feed', 'readability'))
);
--> statement-breakpoint
CREATE INDEX `article_versions_content_key_idx` ON `article_versions` (`content_key`);--> statement-breakpoint
CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`dedup_key` text NOT NULL,
	`url` text,
	`url_host` text,
	`title` text DEFAULT '' NOT NULL,
	`author` text,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`sort_at` integer NOT NULL,
	`source_lang` text,
	`excerpt` text,
	`current_version` integer,
	`content_key` text,
	`word_count` integer DEFAULT 0 NOT NULL,
	`reading_minutes` integer DEFAULT 0 NOT NULL,
	`extract_state` text DEFAULT 'none' NOT NULL,
	`title_hash` text,
	`like_count` integer DEFAULT 0 NOT NULL,
	`recommend_count` integer DEFAULT 0 NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "articles_extract_state_check" CHECK("articles"."extract_state" in ('none', 'due', 'done', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_feed_dedup_idx` ON `articles` (`feed_id`,`dedup_key`);--> statement-breakpoint
CREATE INDEX `articles_feed_seq_idx` ON `articles` (`feed_id`,`seq`);--> statement-breakpoint
CREATE INDEX `articles_feed_sort_idx` ON `articles` (`feed_id`,`sort_at`,`id`);--> statement-breakpoint
CREATE INDEX `articles_content_key_idx` ON `articles` (`content_key`);--> statement-breakpoint
CREATE INDEX `articles_fetched_at_idx` ON `articles` (`fetched_at`);--> statement-breakpoint
CREATE INDEX `articles_extract_state_idx` ON `articles` (`extract_state`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `block_translations` (
	`source_hash` text NOT NULL,
	`target_lang` text NOT NULL,
	`source_lang` text DEFAULT 'und' NOT NULL,
	`tagged_text` text NOT NULL,
	`model` text NOT NULL,
	`norm_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`source_hash`, `target_lang`, `source_lang`)
);
--> statement-breakpoint
CREATE TABLE `body_translations` (
	`content_key` text NOT NULL,
	`lang` text NOT NULL,
	`state` text NOT NULL,
	`request_id` text,
	`requested_by` text,
	`reserved_tokens` integer DEFAULT 0 NOT NULL,
	`reserved_day` text,
	`chunk_keys` text DEFAULT '[]' NOT NULL,
	`object_key` text,
	`failed_leaves` text DEFAULT '[]' NOT NULL,
	`model` text,
	`updated_at` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`content_key`, `lang`),
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "body_translations_state_check" CHECK("body_translations"."state" in ('requested', 'running', 'done', 'partial', 'failed', 'skipped')),
	CONSTRAINT "body_translations_chunk_keys_check" CHECK(json_valid("body_translations"."chunk_keys")),
	CONSTRAINT "body_translations_failed_leaves_check" CHECK(json_valid("body_translations"."failed_leaves"))
);
--> statement-breakpoint
CREATE INDEX `body_translations_state_idx` ON `body_translations` (`state`);--> statement-breakpoint
CREATE INDEX `body_translations_seq_idx` ON `body_translations` (`seq`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` date,
	`refreshTokenExpiresAt` date,
	`scope` text,
	`password` text,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`display_name` text,
	`bio` text,
	`ui_locale` text,
	`reading_lang` text,
	`public_subscriptions` integer DEFAULT false NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "profiles_handle_check" CHECK(length("profiles"."handle") between 3 and 30 and "profiles"."handle" not glob '*[^a-z0-9_]*'),
	CONSTRAINT "profiles_bio_check" CHECK("profiles"."bio" is null or length("profiles"."bio") <= 280)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_handle_unique` ON `profiles` (`handle`);--> statement-breakpoint
CREATE TABLE `rateLimit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`lastRequest` bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rateLimit_key_unique` ON `rateLimit` (`key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` date NOT NULL,
	`token` text NOT NULL,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_prefs` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_prefs_value_json_check" CHECK(json_valid("user_prefs"."value_json"))
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` date NOT NULL,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `applied_mutations` (
	`user_id` text NOT NULL,
	`mid` text NOT NULL,
	`applied_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `mid`)
);
--> statement-breakpoint
CREATE INDEX `applied_mutations_at_idx` ON `applied_mutations` (`applied_at`);--> statement-breakpoint
CREATE TABLE `counters` (
	`k` text PRIMARY KEY NOT NULL,
	`v` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dead_letters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`attempts` integer NOT NULL,
	`error` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dead_letters_at_idx` ON `dead_letters` (`at`);--> statement-breakpoint
CREATE TABLE `lease_fence` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leases` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`owner` text NOT NULL,
	`until` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` integer DEFAULT 0 NOT NULL,
	`host` text,
	`last_error` text,
	PRIMARY KEY(`kind`, `key`)
);
--> statement-breakpoint
CREATE INDEX `leases_host_until_idx` ON `leases` (`host`,`until`);--> statement-breakpoint
CREATE INDEX `leases_until_idx` ON `leases` (`until`);--> statement-breakpoint
CREATE TABLE `ops_heartbeats` (
	`name` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`info` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "ops_heartbeats_info_check" CHECK(json_valid("ops_heartbeats"."info"))
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `window_start`)
);
--> statement-breakpoint
CREATE TABLE `tombstones` (
	`seq` integer NOT NULL,
	`user_id` text,
	`feed_id` integer,
	`entity` text NOT NULL,
	`key` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tombstones_user_seq_idx` ON `tombstones` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `tombstones_feed_seq_idx` ON `tombstones` (`feed_id`,`seq`);--> statement-breakpoint
CREATE TABLE `highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`article_id` integer NOT NULL,
	`content_key` text NOT NULL,
	`side` text NOT NULL,
	`lang` text,
	`leaf_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`quote` text NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`suffix` text DEFAULT '' NOT NULL,
	`note` text,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "highlights_side_check" CHECK("highlights"."side" in ('original', 'translation')),
	CONSTRAINT "highlights_range_check" CHECK("highlights"."start" >= 0 and "highlights"."end" > "highlights"."start"),
	CONSTRAINT "highlights_note_check" CHECK("highlights"."note" is null or length("highlights"."note") <= 2000)
);
--> statement-breakpoint
CREATE INDEX `highlights_user_seq_idx` ON `highlights` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `highlights_user_article_idx` ON `highlights` (`user_id`,`article_id`);--> statement-breakpoint
CREATE TABLE `recommendations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`article_id` integer NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recommendations_note_check" CHECK("recommendations"."note" is null or length("recommendations"."note") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recommendations_user_article_idx` ON `recommendations` (`user_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `recommendations_article_idx` ON `recommendations` (`article_id`);--> statement-breakpoint
CREATE INDEX `recommendations_user_seq_idx` ON `recommendations` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`user_id` text NOT NULL,
	`feed_id` integer NOT NULL,
	`watermark_id` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `feed_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subscriptions_feed_idx` ON `subscriptions` (`feed_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_user_seq_idx` ON `subscriptions` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `user_article_states` (
	`user_id` text NOT NULL,
	`article_id` integer NOT NULL,
	`read_at` integer,
	`liked_at` integer,
	`liked_updated_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `article_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_article_states_user_seq_idx` ON `user_article_states` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `user_article_states_user_liked_idx` ON `user_article_states` (`user_id`,`liked_at`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`feed_url` text NOT NULL,
	`host` text NOT NULL,
	`format` text,
	`title` text,
	`description` text,
	`etag` text,
	`last_modified` text,
	`last_body_hash` text,
	`last_fetched_at` integer,
	`next_fetch_at` integer NOT NULL,
	`fetch_interval_sec` integer DEFAULT 3600 NOT NULL,
	`fetch_region` text DEFAULT 'global' NOT NULL,
	`region_flipped_at` integer,
	`error_count` integer DEFAULT 0 NOT NULL,
	`timeout_streak` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_item_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`content_mode` text DEFAULT 'unknown' NOT NULL,
	`hub_url` text,
	`added_by` text,
	`served_origin` text,
	`refetch_requested_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "feeds_format_check" CHECK("feeds"."format" in ('rss', 'atom', 'rdf', 'json')),
	CONSTRAINT "feeds_fetch_region_check" CHECK("feeds"."fetch_region" in ('global', 'cn')),
	CONSTRAINT "feeds_status_check" CHECK("feeds"."status" in ('active', 'paused', 'dead')),
	CONSTRAINT "feeds_content_mode_check" CHECK("feeds"."content_mode" in ('unknown', 'full', 'summary'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_feedUrl_unique` ON `feeds` (`feed_url`);--> statement-breakpoint
CREATE INDEX `feeds_status_next_fetch_idx` ON `feeds` (`status`,`next_fetch_at`);--> statement-breakpoint
CREATE INDEX `feeds_site_idx` ON `feeds` (`site_id`);--> statement-breakpoint
CREATE TABLE `site_claims` (
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
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_claims_method_check" CHECK("site_claims"."method" in ('meta', 'rel_me', 'dns')),
	CONSTRAINT "site_claims_status_check" CHECK("site_claims"."status" in ('pending', 'verified', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_claims_site_user_idx` ON `site_claims` (`site_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `site_claims_user_idx` ON `site_claims` (`user_id`);--> statement-breakpoint
CREATE TABLE `site_topics` (
	`site_id` integer NOT NULL,
	`topic` text NOT NULL,
	PRIMARY KEY(`site_id`, `topic`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_topics_topic_idx` ON `site_topics` (`topic`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`home_url` text NOT NULL,
	`title` text,
	`description` text,
	`favicon_key` text,
	`primary_lang` text,
	`listing` text DEFAULT 'private' NOT NULL,
	`claimed_by` text,
	`claimed_at` integer,
	`declared_feed_urls` text DEFAULT '[]' NOT NULL,
	`reader_count` integer DEFAULT 0 NOT NULL,
	`translation_opt_out` integer DEFAULT false NOT NULL,
	`assets_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`claimed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sites_listing_check" CHECK("sites"."listing" in ('private', 'listed', 'featured', 'rejected')),
	CONSTRAINT "sites_declared_feed_urls_check" CHECK(json_valid("sites"."declared_feed_urls"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_homeUrl_unique` ON `sites` (`home_url`);--> statement-breakpoint
CREATE INDEX `sites_listing_idx` ON `sites` (`listing`);--> statement-breakpoint
CREATE INDEX `sites_claimed_by_idx` ON `sites` (`claimed_by`);--> statement-breakpoint
CREATE TABLE `websub_subscriptions` (
	`feed_id` integer PRIMARY KEY NOT NULL,
	`hub_url` text NOT NULL,
	`topic_url` text NOT NULL,
	`secret` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_until` integer,
	`last_error` text,
	`requested_at` integer,
	`verified_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "websub_subscriptions_status_check" CHECK("websub_subscriptions"."status" in ('pending', 'active', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`content_key` text,
	`article_id` integer,
	`target_lang` text,
	`user_id` text,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `llm_calls_created_idx` ON `llm_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `llm_calls_user_created_idx` ON `llm_calls` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`subject` text NOT NULL,
	`day` text NOT NULL,
	`reserved` integer DEFAULT 0 NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`subject`, `day`)
);
