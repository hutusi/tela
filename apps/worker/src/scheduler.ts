import { articleTranslations, feeds, translationRequests } from '@tela/db'
import { pruneRateLimits } from '@tela/db/queries'
import { DEAD_AFTER_ERRORS, reprobeRelayRegions } from '@tela/ingest'
import { and, asc, eq, lt, lte, sql } from 'drizzle-orm'
import type { WorkerContext } from './context'
import { queueWebsubRenewals } from './jobs/websub'
import { log } from './logger'
import { QUEUES } from './queues'

/** Every minute: enqueue a fetch for each due feed (singleton per feed, so never twice). */
export async function schedulerTick(ctx: WorkerContext) {
  const due = await ctx.db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.status, 'active'), lte(feeds.nextFetchAt, sql`now()`)))
    .orderBy(asc(feeds.nextFetchAt))
    .limit(ctx.config.SCHEDULER_BATCH)
  let enqueued = 0
  for (const { id } of due) {
    const jobId = await ctx.boss.send(
      QUEUES.feedFetch,
      { feedId: id },
      { singletonKey: String(id) },
    )
    if (jobId) enqueued += 1
  }
  const resentTranslations = await resweepStuckTranslations(ctx)
  if (due.length > 0 || resentTranslations > 0) {
    log.info('scheduler tick', { due: due.length, enqueued, resentTranslations })
  }
}

/** How long a body translation may sit `requested` before the scheduler re-sends its job. */
export const STUCK_REQUEST_MINUTES = 5

/**
 * ADR 0004's fallback for lost jobs. The web app inserts translate.body in the same
 * transaction as the `requested` status, so a stuck row means the job itself was lost (expired,
 * dead-lettered, or from before that change). The handler flips a row to `running` as soon as it
 * starts, so `requested` past the grace period is a reliable signal; the singleton key makes a
 * re-send a no-op while a job for that article and language is still queued.
 */
export async function resweepStuckTranslations(
  ctx: Pick<WorkerContext, 'db' | 'boss'>,
): Promise<number> {
  const rows = await ctx.db
    .select({
      articleId: articleTranslations.articleId,
      targetLang: articleTranslations.targetLang,
      requestedBy: translationRequests.requestedBy,
    })
    .from(articleTranslations)
    .leftJoin(
      translationRequests,
      and(
        eq(translationRequests.articleId, articleTranslations.articleId),
        eq(translationRequests.targetLang, articleTranslations.targetLang),
      ),
    )
    .where(
      and(
        eq(articleTranslations.status, 'requested'),
        lt(
          articleTranslations.updatedAt,
          sql`now() - make_interval(mins => ${STUCK_REQUEST_MINUTES})`,
        ),
      ),
    )
    .orderBy(asc(articleTranslations.updatedAt))
    .limit(200)
  let sent = 0
  for (const row of rows) {
    const id = await ctx.boss.send(
      QUEUES.translateBody,
      // The member is restored so recovered work still counts against their allowance.
      {
        articleId: row.articleId,
        targetLang: row.targetLang,
        onDemand: true,
        ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
      },
      { singletonKey: `${row.articleId}:${row.targetLang}`, priority: 10 },
    )
    if (id) sent += 1
  }
  return sent
}

/** Daily: give dead feeds another chance once a week, and re-probe relay-routed feeds directly. */
export async function maintenanceDaily(ctx: WorkerContext) {
  const reprobed = await reprobeRelayRegions(ctx.db)
  const prunedLimits = await pruneRateLimits(ctx.db)
  const websubRenewals = await queueWebsubRenewals(ctx)
  const revived = await ctx.db
    .update(feeds)
    .set({
      status: 'active',
      errorCount: DEAD_AFTER_ERRORS - 5,
      nextFetchAt: sql`now()`,
    })
    .where(and(eq(feeds.status, 'dead'), lte(feeds.lastFetchedAt, sql`now() - interval '7 days'`)))
    .returning({ id: feeds.id })
  log.info('maintenance daily', {
    revivedDeadFeeds: revived.length,
    reprobedRegions: reprobed.length,
    prunedRateLimits: prunedLimits,
    websubRenewals,
  })
}
