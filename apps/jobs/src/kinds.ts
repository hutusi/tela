/**
 * Every kind of background work, in one table: how it is found (a due query over domain state),
 * how long a claim holds, how it backs off, which queue carries it, what runs it, and how its
 * domain row is retired when attempts run out (ADR 0021).
 */
import {
  type Backoff,
  dueExtractions,
  dueFeeds,
  type LeaseKind,
  settleExtraction,
  type TelaDb,
} from '@tela/data'
import {
  dueAssets,
  dueClaims,
  dueWebsub,
  extractArticleJob,
  type IngestContext,
  ingestFeed,
  siteAssetsJob,
  verifyClaimJob,
  websubSubscribeJob,
} from '@tela/ingest/pipeline'
import { type SQL, sql } from 'drizzle-orm'

export const QUEUES = ['fetch', 'extract', 'translate', 'misc'] as const
export type QueueName = (typeof QUEUES)[number]

/** What a queue message carries: exactly enough to fence the work to its claim. */
export type JobMessage = { kind: LeaseKind; key: string; owner: string }
export type JobQueues = { [Q in QueueName]: JobMessage }

/** What a step reports. `retry` asks the runner to back the lease off. */
export type StepResult = { status: string; error?: string }

export type KindSpec = {
  /** Whether this deployment does this kind at all; a disabled kind is never claimed. */
  enabled?: (ctx: IngestContext) => boolean
  queue: QueueName
  ttlMs: number
  /** Most items one tick claims. */
  limit: number
  backoff: Backoff
  due: (now: number) => SQL
  run: (
    ctx: IngestContext,
    lease: { kind: LeaseKind; key: string; owner: string },
  ) => Promise<StepResult>
  /** Statements that stop an exhausted item being due again (beside its dead letter). */
  exhausted: (db: TelaDb, key: string, now: number) => ReturnType<TelaDb['run']>[]
}

const MIN = 60_000

export const KINDS: Partial<Record<LeaseKind, KindSpec>> = {
  'feed.fetch': {
    queue: 'fetch',
    // A fetch is a 20 s request plus parsing; the lease outlives both with room to spare.
    ttlMs: 3 * MIN,
    limit: 500,
    backoff: { baseMs: MIN, maxMs: 6 * 60 * MIN, maxAttempts: 5 },
    due: dueFeeds,
    run: ingestFeed,
    // A fetch that keeps throwing is a bug, not a dead blog: try again tomorrow, visibly.
    exhausted: (db, key, now) => [
      db.run(
        sql`update feeds set next_fetch_at = ${now + 24 * 60 * MIN} where id = ${Number(key)}`,
      ),
    ],
  },
  'article.extract': {
    queue: 'extract',
    ttlMs: 2 * MIN,
    limit: 200,
    backoff: { baseMs: 5 * MIN, maxMs: 6 * 60 * MIN, maxAttempts: 4 },
    due: () => dueExtractions(),
    run: extractArticleJob,
    exhausted: (db, key) => [settleExtraction(db, Number(key), 'failed')],
  },
  'site.assets': {
    // Without an asset store nothing could be stored, and every site would stay due forever.
    enabled: (ctx) => ctx.assets !== undefined,
    queue: 'misc',
    ttlMs: 2 * MIN,
    limit: 50,
    backoff: { baseMs: 10 * MIN, maxMs: 24 * 60 * MIN, maxAttempts: 3 },
    due: () => dueAssets(),
    run: siteAssetsJob,
    // Looked for often enough: stamp it so it stops being due.
    exhausted: (db, key, now) => [
      db.run(sql`update sites set assets_checked_at = ${now} where id = ${Number(key)}`),
    ],
  },
  'site.claim': {
    queue: 'misc',
    // The home page, then up to 20 declared feeds under a 90 s budget.
    ttlMs: 4 * MIN,
    limit: 20,
    backoff: { baseMs: MIN, maxMs: 30 * MIN, maxAttempts: 3 },
    due: () => dueClaims(),
    run: verifyClaimJob,
    exhausted: (db, key, now) => [
      db.run(sql`
        update site_claims set status = 'failed', error = 'verification kept failing; try again',
          last_checked_at = ${now}
        where id = ${Number(key)} and status = 'pending'
      `),
    ],
  },
  'websub.subscribe': {
    enabled: (ctx) => ctx.websub === true && ctx.publicUrl !== undefined,
    queue: 'misc',
    ttlMs: MIN,
    limit: 50,
    backoff: { baseMs: 10 * MIN, maxMs: 24 * 60 * MIN, maxAttempts: 3 },
    due: dueWebsub,
    run: (ctx, lease) => websubSubscribeJob(ctx, lease),
    exhausted: (db, key, now) => [
      db.run(
        sql`update websub_subscriptions set status = 'failed', updated_at = ${now} where feed_id = ${Number(key)}`,
      ),
    ],
  },
}
