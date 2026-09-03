CREATE TYPE "public"."claim_method" AS ENUM('meta', 'rel_me', 'dns');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('pending', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."content_mode" AS ENUM('unknown', 'full', 'summary');--> statement-breakpoint
CREATE TYPE "public"."extracted_from" AS ENUM('feed', 'readability');--> statement-breakpoint
CREATE TYPE "public"."feed_format" AS ENUM('rss', 'atom', 'rdf', 'json');--> statement-breakpoint
CREATE TYPE "public"."feed_status" AS ENUM('active', 'paused', 'dead');--> statement-breakpoint
CREATE TYPE "public"."fetch_region" AS ENUM('global', 'cn');--> statement-breakpoint
CREATE TYPE "public"."site_listing" AS ENUM('private', 'listed', 'featured', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."translation_status" AS ENUM('requested', 'running', 'done', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "article_contents" (
	"article_id" bigint PRIMARY KEY NOT NULL,
	"html" text NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extracted_from" "extracted_from" DEFAULT 'feed' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_contents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "article_translations" (
	"article_id" bigint NOT NULL,
	"target_lang" text NOT NULL,
	"content_hash" text,
	"status" "translation_status" DEFAULT 'requested' NOT NULL,
	"title" text,
	"excerpt" text,
	"html" text,
	"failed_block_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_translations_article_id_target_lang_pk" PRIMARY KEY("article_id","target_lang")
);
--> statement-breakpoint
ALTER TABLE "article_translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "articles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "articles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"feed_id" bigint NOT NULL,
	"dedup_key" text NOT NULL,
	"url" text,
	"title" text DEFAULT '' NOT NULL,
	"author" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_lang" text,
	"excerpt" text,
	"content_hash" text,
	"content_version" integer DEFAULT 1 NOT NULL,
	"word_count" integer,
	"reading_minutes" integer,
	"like_count" integer DEFAULT 0 NOT NULL,
	"recommend_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "articles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "translations" (
	"source_hash" text NOT NULL,
	"target_lang" text NOT NULL,
	"tagged_text" text NOT NULL,
	"source_lang_hint" text,
	"model" text NOT NULL,
	"norm_version" integer NOT NULL,
	"chars" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translations_source_hash_target_lang_pk" PRIMARY KEY("source_hash","target_lang")
);
--> statement-breakpoint
ALTER TABLE "translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_usage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job" text NOT NULL,
	"article_id" bigint,
	"target_lang" text,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site_claims" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "site_claims_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"site_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "claim_method" NOT NULL,
	"token" text NOT NULL,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"error" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feeds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feeds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"site_id" bigint NOT NULL,
	"feed_url" text NOT NULL,
	"format" "feed_format",
	"title" text,
	"description" text,
	"etag" text,
	"last_modified" text,
	"last_body_hash" text,
	"last_fetched_at" timestamp with time zone,
	"next_fetch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetch_interval_sec" integer DEFAULT 3600 NOT NULL,
	"fetch_region" "fetch_region" DEFAULT 'global' NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"status" "feed_status" DEFAULT 'active' NOT NULL,
	"content_mode" "content_mode" DEFAULT 'unknown' NOT NULL,
	"hub_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feeds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"ui_locale" text DEFAULT 'en' NOT NULL,
	"reading_lang" text DEFAULT 'en' NOT NULL,
	"public_subscriptions" boolean DEFAULT false NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_handle_format" CHECK ("profiles"."handle" ~ '^[a-z0-9_]{3,30}$'),
	CONSTRAINT "profiles_bio_length" CHECK (char_length("profiles"."bio") <= 280)
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sites" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"home_url" text NOT NULL,
	"title" text,
	"description" text,
	"favicon_key" text,
	"cover_key" text,
	"primary_lang" text,
	"listing" "site_listing" DEFAULT 'private' NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"reader_count" integer DEFAULT 0 NOT NULL,
	"translation_opt_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recommendations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"article_id" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendations_note_length" CHECK (char_length("recommendations"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" uuid NOT NULL,
	"feed_id" bigint NOT NULL,
	"watermark_id" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_user_id_feed_id_pk" PRIMARY KEY("user_id","feed_id")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_article_states" (
	"user_id" uuid NOT NULL,
	"article_id" bigint NOT NULL,
	"read_at" timestamp with time zone,
	"liked_at" timestamp with time zone,
	CONSTRAINT "user_article_states_user_id_article_id_pk" PRIMARY KEY("user_id","article_id")
);
--> statement-breakpoint
ALTER TABLE "user_article_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "article_contents" ADD CONSTRAINT "article_contents_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_claims" ADD CONSTRAINT "site_claims_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_claims" ADD CONSTRAINT "site_claims_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_claimed_by_profiles_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article_states" ADD CONSTRAINT "user_article_states_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_article_states" ADD CONSTRAINT "user_article_states_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_translations_status_idx" ON "article_translations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_feed_dedup_key" ON "articles" USING btree ("feed_id","dedup_key");--> statement-breakpoint
CREATE INDEX "articles_feed_id_id_idx" ON "articles" USING btree ("feed_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "articles_feed_published_idx" ON "articles" USING btree ("feed_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "llm_usage_created_at_idx" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "site_claims_site_id_idx" ON "site_claims" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "site_claims_user_id_idx" ON "site_claims" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feeds_feed_url_key" ON "feeds" USING btree ("feed_url");--> statement-breakpoint
CREATE INDEX "feeds_site_id_idx" ON "feeds" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "feeds_schedule_idx" ON "feeds" USING btree ("status","next_fetch_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_handle_key" ON "profiles" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "profiles_created_at_idx" ON "profiles" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_home_url_key" ON "sites" USING btree ("home_url");--> statement-breakpoint
CREATE INDEX "sites_listing_idx" ON "sites" USING btree ("listing");--> statement-breakpoint
CREATE INDEX "sites_claimed_by_idx" ON "sites" USING btree ("claimed_by");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_user_article_key" ON "recommendations" USING btree ("user_id","article_id");--> statement-breakpoint
CREATE INDEX "recommendations_article_id_idx" ON "recommendations" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "recommendations_user_created_idx" ON "recommendations" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subscriptions_feed_id_idx" ON "subscriptions" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "user_article_states_liked_idx" ON "user_article_states" USING btree ("user_id","liked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "article_contents_select_public" ON "article_contents" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "article_translations_select_public" ON "article_translations" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "articles_select_public" ON "articles" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "translations_select_public" ON "translations" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "site_claims_select_own" ON "site_claims" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "site_claims"."user_id");--> statement-breakpoint
CREATE POLICY "feeds_select_public" ON "feeds" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "profiles_select_public" ON "profiles" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "profiles_update_own" ON "profiles" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "profiles"."id") WITH CHECK ((select auth.uid()) = "profiles"."id");--> statement-breakpoint
CREATE POLICY "sites_select_public" ON "sites" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "recommendations_select_public" ON "recommendations" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "recommendations_insert_own" ON "recommendations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "recommendations"."user_id");--> statement-breakpoint
CREATE POLICY "recommendations_update_own" ON "recommendations" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "recommendations"."user_id") WITH CHECK ((select auth.uid()) = "recommendations"."user_id");--> statement-breakpoint
CREATE POLICY "recommendations_delete_own" ON "recommendations" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "recommendations"."user_id");--> statement-breakpoint
CREATE POLICY "subscriptions_own" ON "subscriptions" AS PERMISSIVE FOR ALL TO "authenticated" USING ((select auth.uid()) = "subscriptions"."user_id") WITH CHECK ((select auth.uid()) = "subscriptions"."user_id");--> statement-breakpoint
CREATE POLICY "user_article_states_own" ON "user_article_states" AS PERMISSIVE FOR ALL TO "authenticated" USING ((select auth.uid()) = "user_article_states"."user_id") WITH CHECK ((select auth.uid()) = "user_article_states"."user_id");