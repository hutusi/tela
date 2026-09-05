CREATE TABLE "translation_requests" (
	"article_id" bigint NOT NULL,
	"target_lang" text NOT NULL,
	"requested_by" uuid,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"resends" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_requests_article_id_target_lang_pk" PRIMARY KEY("article_id","target_lang")
);
--> statement-breakpoint
ALTER TABLE "translation_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "article_translations" ADD COLUMN "attempt" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "translation_requests" ADD CONSTRAINT "translation_requests_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_requests" ADD CONSTRAINT "translation_requests_requested_by_profiles_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_requests_requested_by_idx" ON "translation_requests" USING btree ("requested_by");--> statement-breakpoint
-- Translations in flight predate attempts: no request row and no attempt id, so nothing may run
-- them under the new guards. Fail them (no html) so their readers ask again.
UPDATE "article_translations" SET "status" = 'failed', "html" = NULL, "updated_at" = now() WHERE "status" IN ('requested', 'running');
