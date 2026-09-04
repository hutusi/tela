import { sql } from 'drizzle-orm'
import {
  bigint,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { anonRole, authenticatedRole } from 'drizzle-orm/supabase'
import { contentModeEnum, feedFormatEnum, feedStatusEnum, fetchRegionEnum } from './enums'
import { sites } from './sites'

/** The fetch unit. Scheduling state lives here; the scheduler scans (status, next_fetch_at). */
export const feeds = pgTable(
  'feeds',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    siteId: bigint('site_id', { mode: 'number' })
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    feedUrl: text('feed_url').notNull(),
    format: feedFormatEnum('format'),
    title: text('title'),
    description: text('description'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastBodyHash: text('last_body_hash'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    nextFetchAt: timestamp('next_fetch_at', { withTimezone: true }).notNull().defaultNow(),
    fetchIntervalSec: integer('fetch_interval_sec').notNull().default(3600),
    fetchRegion: fetchRegionEnum('fetch_region').notNull().default('global'),
    /** When fetch_region last changed; cn feeds are re-probed from global after a week. */
    regionFlippedAt: timestamp('region_flipped_at', { withTimezone: true }),
    errorCount: integer('error_count').notNull().default(0),
    /** Consecutive timeouts/resets; only these count toward flipping fetch_region to cn. */
    timeoutStreak: integer('timeout_streak').notNull().default(0),
    lastError: text('last_error'),
    /** Newest published_at seen in the feed, for scheduling and "new items" detection. */
    lastItemAt: timestamp('last_item_at', { withTimezone: true }),
    status: feedStatusEnum('status').notNull().default('active'),
    contentMode: contentModeEnum('content_mode').notNull().default('unknown'),
    hubUrl: text('hub_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('feeds_feed_url_key').on(t.feedUrl),
    index('feeds_site_id_idx').on(t.siteId),
    index('feeds_schedule_idx').on(t.status, t.nextFetchAt),
    pgPolicy('feeds_select_public', {
      for: 'select',
      to: [anonRole, authenticatedRole],
      using: sql`true`,
    }),
  ],
)
