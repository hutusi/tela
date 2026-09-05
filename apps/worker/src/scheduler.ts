import { feeds } from '@tela/db'
import {
  abandonStaleAttempts,
  pruneRateLimits,
  type SweepPolicy,
  staleAttempts,
} from '@tela/db/queries'
import { DEAD_AFTER_ERRORS, reprobeRelayRegions } from '@tela/ingest'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
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
  const swept = await resweepStuckTranslations(ctx)
  if (due.length > 0 || swept.resent > 0 || swept.abandoned > 0) {
    log.info('scheduler tick', { due: due.length, enqueued, ...swept })
  }
}

/**
 * When an attempt counts as lost. The worker heartbeats after every chunk and a provider call
 * is abandoned after two minutes, so a live attempt writes at least every few minutes; the
 * handler flips a row to running as soon as it starts, so a `requested` row past the grace
 * period has no job.
 */
export const SWEEP_POLICY: SweepPolicy = {
  requestedMinutes: 5,
  runningMinutes: 15,
  maxResends: 2,
  abandonedMinutes: 60,
}

/**
 * ADR 0004's fallback for lost jobs. The web app inserts translate.body in the same
 * transaction as the `requested` status, so a `requested` row past the grace period lost its
 * job (expired, dead-lettered, or from before that change), and a `running` row without a
 * heartbeat lost its worker. Both get a replacement job; a dead running attempt is replaced
 * under a fresh id at most `maxResends` times, then the row is given up, which releases its
 * reservation.
 */
export async function resweepStuckTranslations(
  ctx: Pick<WorkerContext, 'db' | 'boss'>,
): Promise<{ resent: number; abandoned: number }> {
  const abandoned = await abandonStaleAttempts(ctx.db, SWEEP_POLICY)
  let resent = 0
  for (const row of await staleAttempts(ctx.db, SWEEP_POLICY)) {
    const id = await ctx.boss.send(
      QUEUES.translateBody,
      // The member is restored so recovered work still counts against their allowance.
      {
        articleId: row.articleId,
        targetLang: row.targetLang,
        onDemand: true,
        attempt: row.attempt,
        ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
      },
      { singletonKey: `${row.articleId}:${row.targetLang}`, priority: 10 },
    )
    if (id) resent += 1
  }
  return { resent, abandoned }
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
