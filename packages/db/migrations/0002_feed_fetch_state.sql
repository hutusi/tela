ALTER TABLE "feeds" ADD COLUMN "timeout_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "last_item_at" timestamp with time zone;