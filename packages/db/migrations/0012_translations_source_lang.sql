-- The source language joins the cache key (ADR 0005/0006). drizzle-kit emitted the key change
-- before the column; the order here is the one that runs.
ALTER TABLE "translations" ADD COLUMN "source_lang" text DEFAULT 'und' NOT NULL;--> statement-breakpoint
-- Rows written before this migration carried the language only as a hint; it becomes the key.
UPDATE "translations" SET "source_lang" = coalesce("source_lang_hint", 'und');--> statement-breakpoint
ALTER TABLE "translations" DROP CONSTRAINT "translations_source_hash_target_lang_pk";--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_source_hash_target_lang_source_lang_pk" PRIMARY KEY("source_hash","target_lang","source_lang");
