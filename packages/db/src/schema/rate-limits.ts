import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Fixed-window counters behind abuse limits on member actions (discover, subscribe, OPML import,
 * claims). Keyed by `<action>:<subject>` and the window start; the daily maintenance job prunes
 * old windows. Service role only: RLS is on and no policy grants access.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
).enableRLS()
