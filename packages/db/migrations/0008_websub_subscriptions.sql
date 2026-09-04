CREATE TYPE "public"."websub_status" AS ENUM('pending', 'active', 'failed');--> statement-breakpoint
CREATE TABLE "websub_subscriptions" (
	"feed_id" bigint PRIMARY KEY NOT NULL,
	"hub_url" text NOT NULL,
	"topic_url" text NOT NULL,
	"secret" text NOT NULL,
	"status" "websub_status" DEFAULT 'pending' NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "websub_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "websub_subscriptions" ADD CONSTRAINT "websub_subscriptions_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;