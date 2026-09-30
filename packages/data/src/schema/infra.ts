/**
 * The machinery every other table leans on: the sync sequence, the one lease primitive, and what
 * the platform keeps about its own health (ADR 0021).
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { ms } from './columns'

/**
 * Named counters. `seq` stamps every synced row: a batch that writes one bumps it first, and a
 * reader's cursor is the last value it has seen.
 */
export const counters = sqliteTable('counters', {
  k: text().primaryKey(),
  v: integer().notNull().default(0),
})

/**
 * Always empty. A fenced batch's first statement inserts NULL here unless its lease is still
 * held; the NOT NULL violation then aborts the whole batch on D1 and libSQL alike.
 */
export const leaseFence = sqliteTable('lease_fence', {
  x: integer().notNull(),
})

/**
 * Who is working on what, for every kind of background work. A row exists while an item is held
 * or backing off; success deletes it.
 */
export const leases = sqliteTable(
  'leases',
  {
    kind: text().notNull(),
    key: text().notNull(),
    owner: text().notNull(),
    /** Held until this instant (epoch ms); 0 once released for a retry. */
    until: ms().notNull(),
    attempts: integer().notNull().default(0),
    /** A failed item is not claimed again before this instant (exponential backoff). */
    notBefore: ms().notNull().default(0),
    /** Origin host, for per-host politeness: one live lease per host at a time. */
    host: text(),
    lastError: text(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.key] }),
    index('leases_host_until_idx').on(t.host, t.until),
    index('leases_until_idx').on(t.until),
  ],
)

/** Work that exhausted its attempts. Nothing retries it; the weekly digest reports it. */
export const deadLetters = sqliteTable(
  'dead_letters',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull(),
    key: text().notNull(),
    attempts: integer().notNull(),
    error: text(),
    at: ms().notNull(),
  },
  (t) => [index('dead_letters_at_idx').on(t.at)],
)

/**
 * Fixed-window counters per action and member (no memory survives between isolates). Not
 * better-auth's `rate_limit`, which only limits its own endpoints.
 */
export const actionLimits = sqliteTable(
  'action_limits',
  {
    key: text().notNull(),
    windowStart: ms().notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
)

/** Client mutation ids already applied, so a replayed push changes nothing. */
export const appliedMutations = sqliteTable(
  'applied_mutations',
  {
    userId: text().notNull(),
    mid: text().notNull(),
    appliedAt: ms().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.mid] }),
    index('applied_mutations_at_idx').on(t.appliedAt),
  ],
)

/** Rows a reader must drop that no longer exist to say so themselves. */
export const tombstones = sqliteTable(
  'tombstones',
  {
    seq: integer().notNull(),
    userId: text(),
    feedId: integer(),
    entity: text().notNull(),
    key: text().notNull(),
  },
  (t) => [
    index('tombstones_user_seq_idx').on(t.userId, t.seq),
    index('tombstones_feed_seq_idx').on(t.feedId, t.seq),
  ],
)

/** Last time each periodic job finished, and what it saw; the dead-man's switch reads it. */
export const opsHeartbeats = sqliteTable(
  'ops_heartbeats',
  {
    name: text().primaryKey(),
    at: ms().notNull(),
    info: text().notNull().default('{}'),
  },
  (t) => [check('ops_heartbeats_info_check', sql`json_valid(${t.info})`)],
)
