import { feeds } from '@tela/db'
import { pruneRateLimits } from '@tela/db/queries'
import { DEAD_AFTER_ERRORS, reprobeRelayRegions } from '@tela/ingest'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import type { WorkerContext } from './context'
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
  if (due.length > 0) log.info('scheduler tick', { due: due.length, enqueued })
}

/** Daily: give dead feeds another chance once a week, and re-probe relay-routed feeds directly. */
export async function maintenanceDaily(ctx: WorkerContext) {
  const reprobed = await reprobeRelayRegions(ctx.db)
  const prunedLimits = await pruneRateLimits(ctx.db)
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
  })
}
