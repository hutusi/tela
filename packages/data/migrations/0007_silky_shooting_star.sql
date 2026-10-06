ALTER TABLE `profiles` ADD `ui_locale_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `reading_lang_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `public_subscriptions_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `public_likes_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_article_states` ADD `read_updated_at` integer;--> statement-breakpoint
ALTER TABLE `sites` ADD `review` text CONSTRAINT "sites_review_check" CHECK("review" in ('listed', 'dismissed'));--> statement-breakpoint
ALTER TABLE `sites` ADD `reviewed_at` integer;--> statement-breakpoint
INSERT INTO `counters` (`k`, `v`) SELECT 'seq', 1 WHERE EXISTS (SELECT 1 FROM `profiles` WHERE `reading_lang` IS NOT NULL AND `reading_lang` = `ui_locale`) ON CONFLICT (`k`) DO UPDATE SET `v` = `v` + 1;--> statement-breakpoint
UPDATE `profiles` SET `reading_lang` = NULL, `seq` = (SELECT `v` FROM `counters` WHERE `k` = 'seq') WHERE `reading_lang` IS NOT NULL AND `reading_lang` = `ui_locale`;--> statement-breakpoint
UPDATE `sites` SET `review` = CASE WHEN `listing` = 'rejected' THEN 'dismissed' ELSE 'listed' END, `reviewed_at` = coalesce((SELECT max(`at`) FROM `admin_actions` WHERE `target_kind` = 'site' AND `target_key` = cast(`sites`.`id` AS text) AND `action` IN ('site.feature', 'site.list', 'site.hide')), `created_at`) WHERE `listing` IN ('featured', 'rejected') OR (`listing` = 'listed' AND `claimed_by` IS NULL);