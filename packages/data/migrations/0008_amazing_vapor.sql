CREATE INDEX `articles_sort_idx` ON `articles` (`sort_at`,`id`);--> statement-breakpoint
CREATE INDEX `recommendations_created_idx` ON `recommendations` (`created_at`);