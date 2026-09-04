ALTER TYPE "public"."translation_status" ADD VALUE 'pending' BEFORE 'requested';--> statement-breakpoint
ALTER TABLE "article_translations" ALTER COLUMN "status" SET DEFAULT 'pending';