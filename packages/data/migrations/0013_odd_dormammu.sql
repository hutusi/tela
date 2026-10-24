ALTER TABLE `article_versions` ADD `pipeline_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `article_versions_pipeline_idx` ON `article_versions` (`pipeline_version`);