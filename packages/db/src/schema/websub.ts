import { bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { websubStatusEnum } from './enums'
import { feeds } from './feeds'

/**
 * One WebSub subscription per feed that advertises a hub. The worker asks the hub to notify
 * `/api/websub/<feedId>`; the hub verifies by GET (status → active with a lease) and later POSTs
 * signed pings that enqueue an immediate fetch. Service role only.
 */
export const websubSubscriptions = pgTable('websub_subscriptions', {
  feedId: bigint('feed_id', { mode: 'number' })
    .primaryKey()
    .references(() => feeds.id, { onDelete: 'cascade' }),
  hubUrl: text('hub_url').notNull(),
  topicUrl: text('topic_url').notNull(),
  /** Shared with the hub; signs every notification (X-Hub-Signature). */
  secret: text('secret').notNull(),
  status: websubStatusEnum('status').notNull().default('pending'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  lastError: text('last_error'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}).enableRLS()
