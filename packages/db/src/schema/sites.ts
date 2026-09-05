import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { anonRole, authenticatedRole } from 'drizzle-orm/supabase'
import { siteListingEnum } from './enums'
import { profiles } from './profiles'

/**
 * A blog or personal website: the community-facing entity. Feeds hang off it.
 * home_url is the normalized origin (https://example.com), unique.
 */
export const sites = pgTable(
  'sites',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    homeUrl: text('home_url').notNull(),
    title: text('title'),
    description: text('description'),
    faviconKey: text('favicon_key'),
    coverKey: text('cover_key'),
    primaryLang: text('primary_lang'),
    listing: siteListingEnum('listing').notNull().default('private'),
    claimedBy: uuid('claimed_by').references(() => profiles.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    topics: text('topics').array().notNull().default(sql`'{}'::text[]`),
    /** Feed URLs the home page declared (rel=alternate) when the claim was verified. */
    declaredFeedUrls: text('declared_feed_urls').array().notNull().default(sql`'{}'::text[]`),
    readerCount: integer('reader_count').notNull().default(0),
    translationOptOut: boolean('translation_opt_out').notNull().default(false),
    /** When the assets job last looked for a favicon and cover (success or not). */
    assetsCheckedAt: timestamp('assets_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('sites_home_url_key').on(t.homeUrl),
    index('sites_listing_idx').on(t.listing),
    index('sites_claimed_by_idx').on(t.claimedBy),
    pgPolicy('sites_select_public', {
      for: 'select',
      to: anonRole,
      using: sql`${t.listing} in ('listed', 'featured')`,
    }),
    pgPolicy('sites_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: sql`true`,
    }),
  ],
)
