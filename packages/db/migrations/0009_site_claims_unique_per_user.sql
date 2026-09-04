-- Claims are unique per (site, user). The old select-then-insert could leave duplicates under
-- concurrent requests; keep the verified claim, otherwise the newest, so the index can be built.
DELETE FROM "site_claims" AS c
USING "site_claims" AS k
WHERE c."site_id" = k."site_id" AND c."user_id" = k."user_id" AND c."id" <> k."id"
  AND (
    (k."status" = 'verified' AND c."status" <> 'verified')
    OR ((k."status" = 'verified') = (c."status" = 'verified') AND k."id" > c."id")
  );--> statement-breakpoint
DROP INDEX IF EXISTS "site_claims_site_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "site_claims_site_user_key" ON "site_claims" USING btree ("site_id","user_id");