DROP POLICY "profiles_update_own" ON "profiles" CASCADE;--> statement-breakpoint
DROP POLICY "recommendations_insert_own" ON "recommendations" CASCADE;--> statement-breakpoint
DROP POLICY "recommendations_update_own" ON "recommendations" CASCADE;--> statement-breakpoint
DROP POLICY "recommendations_delete_own" ON "recommendations" CASCADE;--> statement-breakpoint
DROP POLICY "subscriptions_own" ON "subscriptions" CASCADE;--> statement-breakpoint
DROP POLICY "user_article_states_own" ON "user_article_states" CASCADE;--> statement-breakpoint
CREATE POLICY "article_contents_select_member" ON "article_contents" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "article_translations_select_member" ON "article_translations" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "articles_select_member" ON "articles" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "feeds_select_member" ON "feeds" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "sites_select_member" ON "sites" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "subscriptions_own" ON "subscriptions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "subscriptions"."user_id");--> statement-breakpoint
CREATE POLICY "user_article_states_own" ON "user_article_states" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "user_article_states"."user_id");--> statement-breakpoint
ALTER POLICY "article_contents_select_public" ON "article_contents" TO anon USING (exists (select 1 from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id where a.id = "article_contents"."article_id" and s.listing in ('listed', 'featured')));--> statement-breakpoint
ALTER POLICY "article_translations_select_public" ON "article_translations" TO anon USING (exists (select 1 from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id where a.id = "article_translations"."article_id" and s.listing in ('listed', 'featured')));--> statement-breakpoint
ALTER POLICY "articles_select_public" ON "articles" TO anon USING (exists (select 1 from feeds f join sites s on s.id = f.site_id where f.id = "articles"."feed_id" and s.listing in ('listed', 'featured')));--> statement-breakpoint
ALTER POLICY "feeds_select_public" ON "feeds" TO anon USING (exists (select 1 from sites s where s.id = "feeds"."site_id" and s.listing in ('listed', 'featured')));--> statement-breakpoint
ALTER POLICY "sites_select_public" ON "sites" TO anon USING ("sites"."listing" in ('listed', 'featured'));