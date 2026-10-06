/** Blogs and the feeds they publish, plus the machinery that verifies and follows them. */
import {
  CLAIM_METHODS,
  CLAIM_STATUSES,
  CONTENT_MODES,
  FEED_FORMATS,
  FEED_STATUSES,
  FETCH_REGIONS,
  SITE_LISTINGS,
  WEBSUB_STATUSES,
} from '@tela/shared'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { flag, ms, oneOf, seq, validJson } from './columns'

export const sites = sqliteTable(
  'sites',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    /** Normalized origin; the identity of a blog. */
    homeUrl: text().notNull().unique(),
    title: text(),
    description: text(),
    faviconKey: text(),
    primaryLang: text(),
    listing: text({ enum: SITE_LISTINGS }).notNull().default('private'),
    claimedBy: text().references(() => user.id, { onDelete: 'set null' }),
    claimedAt: ms(),
    /** Feed URLs the home page declares; read whole, so JSON rather than a join table. */
    declaredFeedUrls: text().notNull().default('[]'),
    readerCount: integer().notNull().default(0),
    translationOptOut: flag(),
    assetsCheckedAt: ms(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    seq: seq(),
  },
  (t) => [
    check('sites_listing_check', oneOf(t.listing, SITE_LISTINGS)),
    check('sites_declared_feed_urls_check', validJson(t.declaredFeedUrls)),
    index('sites_listing_idx').on(t.listing),
    index('sites_claimed_by_idx').on(t.claimedBy),
  ],
)

/** Topics are filtered on (Discover's chips), so they are rows, not a JSON array. */
export const siteTopics = sqliteTable(
  'site_topics',
  {
    siteId: integer()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    topic: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.topic] }), index('site_topics_topic_idx').on(t.topic)],
)

export const feeds = sqliteTable(
  'feeds',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    siteId: integer()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    feedUrl: text().notNull().unique(),
    /** Host of feed_url, for per-host politeness through the lease table. */
    host: text().notNull(),
    format: text({ enum: FEED_FORMATS }),
    title: text(),
    description: text(),
    etag: text(),
    lastModified: text(),
    lastBodyHash: text(),
    lastFetchedAt: ms(),
    nextFetchAt: ms().notNull(),
    fetchIntervalSec: integer().notNull().default(3600),
    fetchRegion: text({ enum: FETCH_REGIONS }).notNull().default('global'),
    regionFlippedAt: ms(),
    errorCount: integer().notNull().default(0),
    timeoutStreak: integer().notNull().default(0),
    lastError: text(),
    lastItemAt: ms(),
    status: text({ enum: FEED_STATUSES }).notNull().default('active'),
    contentMode: text({ enum: CONTENT_MODES }).notNull().default('unknown'),
    hubUrl: text(),
    addedBy: text().references(() => user.id, { onDelete: 'set null' }),
    servedOrigin: text(),
    /**
     * The feed this one turned out to be another address for: the same blog, listing the same
     * posts (ADR 0028). Set with `status = 'paused'`, so nothing fetches it; adding or importing
     * its URL subscribes to this feed instead.
     */
    mergedInto: integer().references((): AnySQLiteColumn => feeds.id, { onDelete: 'set null' }),
    /**
     * The latest WebSub ping. The feed is due while this is set; a fetch clears it only when the
     * ping came before the fetch started, so a ping arriving mid-fetch is not lost.
     */
    refetchRequestedAt: ms(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    seq: seq(),
  },
  (t) => [
    check('feeds_format_check', oneOf(t.format, FEED_FORMATS)),
    check('feeds_fetch_region_check', oneOf(t.fetchRegion, FETCH_REGIONS)),
    check('feeds_status_check', oneOf(t.status, FEED_STATUSES)),
    check('feeds_content_mode_check', oneOf(t.contentMode, CONTENT_MODES)),
    index('feeds_status_next_fetch_idx').on(t.status, t.nextFetchAt),
    index('feeds_site_idx').on(t.siteId),
  ],
)

export const siteClaims = sqliteTable(
  'site_claims',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    siteId: integer()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    method: text({ enum: CLAIM_METHODS }).notNull(),
    token: text().notNull(),
    status: text({ enum: CLAIM_STATUSES }).notNull().default('pending'),
    lastCheckedAt: ms(),
    error: text(),
    verifiedAt: ms(),
    createdAt: ms().notNull(),
    /**
     * An operator who vouched for the claim (ADR 0039): its check skips only the proof, and still
     * reads the home page for the feeds it declares. A member's own re-check clears it.
     */
    vouchedBy: text().references(() => user.id, { onDelete: 'set null' }),
    /** When an operator last decided on it; a failed claim checked since needs review again. */
    reviewedAt: ms(),
    seq: seq(),
  },
  (t) => [
    check('site_claims_method_check', oneOf(t.method, CLAIM_METHODS)),
    check('site_claims_status_check', oneOf(t.status, CLAIM_STATUSES)),
    uniqueIndex('site_claims_site_user_idx').on(t.siteId, t.userId),
    index('site_claims_user_idx').on(t.userId),
  ],
)

export const websubSubscriptions = sqliteTable(
  'websub_subscriptions',
  {
    feedId: integer()
      .primaryKey()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    hubUrl: text().notNull(),
    topicUrl: text().notNull(),
    secret: text().notNull(),
    status: text({ enum: WEBSUB_STATUSES }).notNull().default('pending'),
    leaseUntil: ms(),
    lastError: text(),
    requestedAt: ms(),
    verifiedAt: ms(),
    updatedAt: ms().notNull(),
  },
  (t) => [check('websub_subscriptions_status_check', oneOf(t.status, WEBSUB_STATUSES))],
)
