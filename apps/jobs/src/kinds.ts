/**
 * Every kind of background work, in one table: how it is found (a due query over domain state),
 * how long a claim holds, how it backs off, which queue carries it, what runs it, and how its
 * domain row is retired when attempts run out (ADR 0021).
 */
import {
  type Backoff,
  currentSeq,
  dueBodies,
  dueErasures,
  dueExtractions,
  dueFeeds,
  dueGravatarChecks,
  duePendingFeeds,
  dueReprocessing,
  dueTitles,
  FEED_FETCH_TTL_MS,
  failDueTitles,
  GRAVATAR_CHECK_TTL_MS,
  type LeaseKind,
  type QueueName,
  settleBodyUsage,
  settleExtraction,
  type TelaDb,
  TRANSLATE_BODY_TTL_MS,
} from '@tela/data'
import {
  dueAssets,
  dueClaims,
  dueWebsub,
  extractArticleJob,
  gravatarCheckJob,
  ingestFeed,
  reprocessArticleJob,
  siteAssetsJob,
  verifyClaimJob,
  websubSubscribeJob,
} from '@tela/ingest/pipeline'
import { PIPELINE_VERSION } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import { ERASE_TTL_MS, eraseMemberJob } from './erase'
import { PENDING_FEEDS_TTL_MS, pendingFeedsJob } from './pending-feeds'
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
    ttlMs: FEED_FETCH_TTL_MS,
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
  'article.reprocess': {
    // Each current version made under an older PIPELINE_VERSION, made again from its raw HTML
    // (ADR 0055). Nothing is fetched, so no host to wait for: the limit is the only pace, a few
    // thousand stored posts an hour, newest first, beside extraction on its queue.
    queue: 'extract',
    ttlMs: 2 * MIN,
    limit: 50,
    backoff: { baseMs: 10 * MIN, maxMs: 6 * 60 * MIN, maxAttempts: 3 },
    due: () => dueReprocessing(),
    run: reprocessArticleJob,
    // A body the pipeline keeps failing on keeps the version it has; stamped so it stops being due.
    exhausted: (db, key) => [
      db.run(sql`
        update article_versions set pipeline_version = ${PIPELINE_VERSION}
        where article_id = ${Number(key)}
          and version = (select current_version from articles where id = ${Number(key)})
      `),
    ],
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
  'member.gravatar': {
    // Whether Gravatar has a picture for a member who shows theirs (ADR 0033). One host for every
    // member, so they are asked one at a time, a couple of seconds apart.
    queue: 'misc',
    ttlMs: GRAVATAR_CHECK_TTL_MS,
    limit: 50,
    backoff: { baseMs: 10 * MIN, maxMs: 24 * 60 * MIN, maxAttempts: 3 },
    due: (now) => dueGravatarChecks(now),
    run: gravatarCheckJob,
    // Asked often enough: stamp it, and the answer it had (none, if never) waits a week.
    exhausted: (db, key, now) => [
      db.run(sql`update profiles set gravatar_checked_at = ${now} where user_id = ${key}`),
    ],
  },
  'member.pendingFeeds': {
    // An import's feeds new to Tela beyond the member's day, added on the days after (ADR 0063).
    // Keyed by member; nothing is fetched, so no host. Due only while a run would move something:
    // the day and the cap have room, or a waiting feed is one Tela has now.
    queue: 'misc',
    ttlMs: PENDING_FEEDS_TTL_MS,
    limit: 50,
    backoff: { baseMs: 10 * MIN, maxMs: 6 * 60 * MIN, maxAttempts: 3 },
    due: (now) => duePendingFeeds(now),
    run: pendingFeedsJob,
    // A batch that keeps failing is a bug, not a member's doing: their feeds wait a day, visibly.
    exhausted: (db, key, now) => [
      db.run(sql`
        update pending_feeds set queued_at = ${now + 24 * 60 * MIN}
        where user_id = ${key} and queued_at <= ${now}
      `),
    ],
  },
  'member.erase': {
    // What a closed account's own devices held (ADR 0058), once no signed copy of its session
    // can be read. A member at a time per claim is plenty: accounts close rarely.
    queue: 'misc',
    ttlMs: ERASE_TTL_MS,
    limit: 10,
    backoff: { baseMs: 10 * MIN, maxMs: 6 * 60 * MIN, maxAttempts: 3 },
    due: (now) => dueErasures(now),
    run: eraseMemberJob,
    // Nothing to mark: an erasure is never called finished when it is not. Its dead letter is the
    // record that it stopped, and `dueErasures` waits on it until the console retries.
    exhausted: () => [],
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
    // The day's budgets are read as the due query runs (ADR 0057); the env value is only what a
    // background budget of null falls back to.
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
    ttlMs: TRANSLATE_BODY_TTL_MS,
    limit: 20,
    backoff: { baseMs: MIN, maxMs: 30 * MIN, maxAttempts: 3 },
    // A request put off to the next day waits for its `due_at` (ADR 0057).
    due: (now) => dueBodies(now),
    run: translateBodyJob,
    // Also what retires a body whose every start died. The reservation goes back and what the
    // chunks spent is charged, before the flip that the settle's state filter reads.
    exhausted: (db, key, now) => {
      const split = key.lastIndexOf(':')
      const contentKey = key.slice(0, split)
      const lang = key.slice(split + 1)
      return [
        settleBodyUsage(db, contentKey, lang, now),
        db.run(sql`
          update body_translations set state = 'failed', reserved_tokens = 0, due_at = null,
            updated_at = ${now}, seq = ${currentSeq}
          where content_key = ${contentKey} and lang = ${lang} and state in ('requested', 'running')
        `),
      ]
    },
  },
}
