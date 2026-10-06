ALTER TABLE `profiles` ADD `ui_locale_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `reading_lang_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `public_subscriptions_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `public_likes_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_article_states` ADD `read_updated_at` integer;--> statement-breakpoint
ALTER TABLE `sites` ADD `reviewed_at` integer;--> statement-breakpoint
INSERT INTO `counters` (`k`, `v`) SELECT 'seq', 1 WHERE EXISTS (SELECT 1 FROM `profiles` WHERE `reading_lang` IS NOT NULL AND `reading_lang` = `ui_locale`) ON CONFLICT (`k`) DO UPDATE SET `v` = `v` + 1;--> statement-breakpoint
UPDATE `profiles` SET `reading_lang` = NULL, `seq` = (SELECT `v` FROM `counters` WHERE `k` = 'seq') WHERE `reading_lang` IS NOT NULL AND `reading_lang` = `ui_locale`;