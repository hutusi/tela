/**
 * Fetch-region policy. A feed starts in the global region. After repeated timeouts, while the
 * worker's own connectivity is confirmed by a control URL, it is routed through the relay
 * (`fetch_region = 'cn'`). Once a week it is probed from the global region again so feeds that
 * became reachable do not stay on the relay forever. Only timeouts count: 4xx/5xx are the origin
 * answering, not the network path.
 */
import { type Db, feeds } from '@tela/db'
import { and, eq, sql } from 'drizzle-orm'

export const RELAY_AFTER_TIMEOUTS = 3
export const RELAY_REPROBE_DAYS = 7

export type RegionPolicy = {
  /** True when this worker has a relay configured. */
  relayAvailable: boolean
  /** Confirms the worker can reach the internet, so the timeouts are about the origin. */
  controlOk: () => Promise<boolean>
}

/** Whether this timeout should move the feed onto the relay (before consulting the control URL). */
export function timeoutsWarrantRelay(
  feed: { fetchRegion: 'global' | 'cn'; timeoutStreak: number },
  policy: RegionPolicy | undefined,
): boolean {
  if (!policy?.relayAvailable) return false
  if (feed.fetchRegion !== 'global') return false
  return feed.timeoutStreak + 1 >= RELAY_AFTER_TIMEOUTS
}

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
