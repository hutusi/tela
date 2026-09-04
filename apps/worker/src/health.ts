/**
 * Operational signals for logs and alerts: queue depth per pg-boss queue, dead-letter growth,
 * and feeds the scheduler should have fetched by now. Logged every five minutes from the
 * scheduler role as one JSON line so a log-based alert can key on it.
 */
import { type Db, feeds } from '@tela/db'
import { and, eq, lt, sql } from 'drizzle-orm'
import { log } from './logger'

export type QueueHealth = {
  name: string
  queued: number
  active: number
  retrying: number
  completed1h: number
  failed1h: number
  /** Age of the oldest job still waiting, in seconds. */
  oldestQueuedSec: number | null
}

export type FeedHealth = {
  active: number
  paused: number
  dead: number
  /** Active feeds whose next_fetch_at passed more than 15 minutes ago: the scheduler or fetchers are behind. */
  overdue: number
  relayed: number
}

const DEAD_SUFFIX = '.dead'
export const OVERDUE_AFTER_MIN = 15
export const STALE_QUEUE_AFTER_SEC = 600

/** Per-queue counts from pgboss.job; empty when the queue schema does not exist yet. */
export async function queueHealth(db: Db): Promise<QueueHealth[]> {
  const rows = await db
    .execute<{
      name: string
      queued: number
      active: number
      retrying: number
      completed_1h: number
      failed_1h: number
      oldest_queued_sec: number | null
    }>(sql`
      select name,
             count(*) filter (where state = 'created')::int as queued,
             count(*) filter (where state = 'active')::int as active,
             count(*) filter (where state = 'retry')::int as retrying,
             count(*) filter (where state = 'completed' and completed_on > now() - interval '1 hour')::int as completed_1h,
             count(*) filter (where state = 'failed' and completed_on > now() - interval '1 hour')::int as failed_1h,
             extract(epoch from now() - min(created_on) filter (where state = 'created'))::int as oldest_queued_sec
      from pgboss.job
      where name not like '__pgboss__%'
      group by name
      order by name
    `)
    .catch((err: unknown) => {
      if (/pgboss\.job|does not exist/i.test(String(err))) return []
      throw err
    })
  return rows.map((r) => ({
    name: r.name,
    queued: Number(r.queued),
    active: Number(r.active),
    retrying: Number(r.retrying),
    completed1h: Number(r.completed_1h),
    failed1h: Number(r.failed_1h),
    oldestQueuedSec: r.oldest_queued_sec === null ? null : Number(r.oldest_queued_sec),
  }))
}

export async function feedHealth(db: Db, now: Date = new Date()): Promise<FeedHealth> {
  const overdueBefore = new Date(now.getTime() - OVERDUE_AFTER_MIN * 60_000)
  const [counts] = await db
    .select({
      active: sql<number>`count(*) filter (where ${feeds.status} = 'active')::int`,
      paused: sql<number>`count(*) filter (where ${feeds.status} = 'paused')::int`,
      dead: sql<number>`count(*) filter (where ${feeds.status} = 'dead')::int`,
      relayed: sql<number>`count(*) filter (where ${feeds.fetchRegion} = 'cn')::int`,
    })
    .from(feeds)
  const [overdue] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(feeds)
    .where(and(eq(feeds.status, 'active'), lt(feeds.nextFetchAt, overdueBefore)))
  return {
    active: counts?.active ?? 0,
    paused: counts?.paused ?? 0,
    dead: counts?.dead ?? 0,
    overdue: overdue?.n ?? 0,
    relayed: counts?.relayed ?? 0,
  }
}

/** What an alert should key on: dead-letter growth, stuck queues, a scheduler that fell behind. */
export function healthProblems(queues: QueueHealth[], feedsHealth: FeedHealth): string[] {
  const problems: string[] = []
  for (const q of queues) {
    if (q.name.endsWith(DEAD_SUFFIX)) {
      if (q.queued > 0) problems.push(`${q.name}: ${q.queued} dead-lettered jobs`)
      continue
    }
    if (q.failed1h > 0) problems.push(`${q.name}: ${q.failed1h} failed in the last hour`)
    if ((q.oldestQueuedSec ?? 0) > STALE_QUEUE_AFTER_SEC) {
      problems.push(`${q.name}: oldest job waiting ${q.oldestQueuedSec}s`)
    }
  }
  if (feedsHealth.overdue > 0) problems.push(`${feedsHealth.overdue} active feeds overdue`)
  return problems
}

/** One log line per check; `warn` level when something needs a look. */
export async function logHealth(db: Db): Promise<string[]> {
  const [queues, feedsHealth] = await Promise.all([queueHealth(db), feedHealth(db)])
  const problems = healthProblems(queues, feedsHealth)
  const fields = {
    feeds: feedsHealth,
    queues: Object.fromEntries(
      queues.map((q) => [
        q.name,
        {
          queued: q.queued,
          active: q.active,
          retrying: q.retrying,
          done1h: q.completed1h,
          failed1h: q.failed1h,
          oldestSec: q.oldestQueuedSec,
        },
      ]),
    ),
    problems,
  }
  if (problems.length > 0) log.warn('health check', fields)
  else log.info('health check', fields)
  return problems
}
