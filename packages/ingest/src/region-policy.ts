/**
 * Fetch-region policy, the pure half of `region.ts` (no database), so the Workers pipeline can
 * import it without the Postgres layer.
 */
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
