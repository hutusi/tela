-- Custom SQL migration file, put your code below! --
-- Trigram indexes back the search page: ILIKE '%term%' on site names, hosts, and article titles
-- stays an index scan, and similarity() ranks site matches. pg_trgm handles multibyte text, so
-- CJK substrings work without a separate tokenizer (PGroonga can replace this later).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sites_title_trgm_idx" ON "sites" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sites_home_url_trgm_idx" ON "sites" USING gin ("home_url" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feeds_title_trgm_idx" ON "feeds" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "articles_title_trgm_idx" ON "articles" USING gin ("title" gin_trgm_ops);
