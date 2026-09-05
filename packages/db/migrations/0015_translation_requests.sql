CREATE TABLE "translation_requests" (
	"article_id" bigint NOT NULL,
	"target_lang" text NOT NULL,
	"requested_by" uuid,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"attempt" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_requests_article_id_target_lang_pk" PRIMARY KEY("article_id","target_lang")
);
--> statement-breakpoint
ALTER TABLE "translation_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "translation_requests" ADD CONSTRAINT "translation_requests_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_requests" ADD CONSTRAINT "translation_requests_requested_by_profiles_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_requests_requested_by_idx" ON "translation_requests" USING btree ("requested_by");