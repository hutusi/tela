/**
 * Fetch-region policy. A feed starts in the global region. After repeated timeouts, while the
 * worker's own connectivity is confirmed by a control URL, it is routed through the relay
 * (`fetch_region = 'cn'`). Once a week it is probed from the global region again so feeds that
 * became reachable do not stay on the relay forever. Only timeouts count: 4xx/5xx are the origin
 * answering, not the network path.
 */
import { type Db, feeds } from '@tela/db'
import { and, eq, sql } from 'drizzle-orm'
import { RELAY_REPROBE_DAYS } from './region-policy'

export {
  RELAY_AFTER_TIMEOUTS,
  RELAY_REPROBE_DAYS,
  type RegionPolicy,
  timeoutsWarrantRelay,
} from './region-policy'

/** Daily: send relay-routed feeds back to the global region after a week; timeouts flip them again. */
export async function reprobeRelayRegions(db: Db, now: Date = new Date()): Promise<number[]> {
  const cutoff = new Date(now.getTime() - RELAY_REPROBE_DAYS * 24 * 3600 * 1000)
  const rows = await db
    .update(feeds)
    .set({ fetchRegion: 'global', regionFlippedAt: now, timeoutStreak: 0 })
    .where(
      and(
        eq(feeds.fetchRegion, 'cn'),
        sql`coalesce(${feeds.regionFlippedAt}, ${feeds.createdAt}) <= ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: feeds.id })
  return rows.map((r) => r.id)
}
