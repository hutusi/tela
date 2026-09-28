/**
 * Every kind of background work, in one table: how it is found (a due query over domain state),
 * how long a claim holds, how it backs off, which queue carries it, what runs it, and how its
 * domain row is retired when attempts run out (ADR 0021).
 */
import {
  type Backoff,
  currentSeq,
  dueBodies,
  dueExtractions,
  dueFeeds,
  dueTitles,
  failDueTitles,
  type LeaseKind,
  type QueueName,
  settleExtraction,
  type TelaDb,
} from '@tela/data'
import {
  dueAssets,
  dueClaims,
  dueWebsub,
  extractArticleJob,
  ingestFeed,
  siteAssetsJob,
  verifyClaimJob,
  websubSubscribeJob,
} from '@tela/ingest/pipeline'
import { type SQL, sql } from 'drizzle-orm'
import { translateBodyJob } from './translation/body'
import { TITLE_TTL_MS, type TranslationContext, translateTitlesJob } from './translation/titles'

export { type JobMessage, type JobQueues, QUEUES, type QueueName } from '@tela/data'

/** What a step reports. `retry` asks the runner to back the lease off. */
export type StepResult = { status: string; error?: string }

/** What every job runs against: the ingest context plus the translator and its budgets. */
export type WorkContext = TranslationContext

export type KindSpec = {
  /** Whether this deployment does this kind at all; a disabled kind is never claimed. */
  enabled?: (ctx: WorkContext) => boolean
  queue: QueueName
  ttlMs: number
  /** Most items one tick claims. */
  limit: number
  backoff: Backoff
  due: (now: number, ctx: WorkContext) => SQL
  run: (
    ctx: WorkContext,
    lease: { kind: LeaseKind; key: string; owner: string },
  ) => Promise<StepResult>
  /**
   * Statements that stop an exhausted item being due again (beside its dead letter). The batch
   * bumps the sync sequence, so a statement that writes a synced row stamps `seq: currentSeq`.
   */
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
        sql`update feeds set next_fetch_at = ${now + 24 * 60 * MIN}, seq = ${currentSeq} where id = ${Number(key)}`,
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
      db.run(
        sql`update sites set assets_checked_at = ${now}, seq = ${currentSeq} where id = ${Number(key)}`,
      ),
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
          last_checked_at = ${now}, seq = ${currentSeq}
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
  'translate.title': {
    enabled: (ctx) => ctx.translator !== undefined,
    // Background work: a queue of its own would only compete with bodies, which readers wait on.
    queue: 'misc',
    // Keyed by feed: one job translates up to TITLES_PER_JOB of its titles, a call per language.
    ttlMs: TITLE_TTL_MS,
    limit: 100,
    backoff: { baseMs: 5 * MIN, maxMs: 6 * 60 * MIN, maxAttempts: 4 },
    due: (now, ctx) => dueTitles(now, ctx.backgroundBudget ?? 0),
    run: translateTitlesJob,
    // The provider kept failing on this batch: record it failed so the sweep stops until the
    // titles change.
    exhausted: (db, key, now) => [failDueTitles(db, Number(key), now)],
  },
  'translate.body': {
    enabled: (ctx) => ctx.translator !== undefined,
    // Bodies have the translate queue to themselves: a reader is waiting on every one.
    queue: 'translate',
    // Held for the first chunk; each chunk's batch extends it for the next.
    ttlMs: 4 * MIN,
    limit: 20,
    backoff: { baseMs: MIN, maxMs: 30 * MIN, maxAttempts: 3 },
    due: () => dueBodies(),
    run: translateBodyJob,
    exhausted: (db, key, now) => {
      const split = key.lastIndexOf(':')
      return [
        db.run(sql`
          update body_translations set state = 'failed', updated_at = ${now}, seq = ${currentSeq}
          where content_key = ${key.slice(0, split)} and lang = ${key.slice(split + 1)}
        `),
      ]
    },
  },
}
