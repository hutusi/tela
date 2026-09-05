ALTER TABLE "articles" ADD COLUMN "extract_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "added_by" uuid;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "served_origin" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "declared_feed_urls" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_added_by_profiles_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_user_id_created_at_idx" ON "llm_usage" USING btree ("user_id","created_at");--> statement-breakpoint
-- Rows from before provenance have no served origin, and a feed whose body never changes would
-- otherwise never be re-examined: make every active feed due for a full fetch.
UPDATE "feeds" SET "etag" = NULL, "last_modified" = NULL, "last_body_hash" = NULL, "next_fetch_at" = now() WHERE "status" = 'active';
