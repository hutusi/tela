/** Fetch scheduling math. Pure, so it is easy to test and reason about. */

export const MIN_INTERVAL_SEC = 30 * 60
export const MAX_INTERVAL_SEC = 24 * 60 * 60
export const MAX_BACKOFF_SEC = 7 * 24 * 60 * 60
const WEEK_SEC = 7 * 24 * 60 * 60

export function clampInterval(sec: number): number {
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.round(sec)))
}

/** Half the average gap between posts over the last week, clamped. */
export function baseIntervalSec(itemsLast7d: number): number {
  return clampInterval(WEEK_SEC / Math.max(itemsLast7d, 1) / 2)
}

export type NextIntervalInput = {
  currentSec: number
  itemsLast7d: number
  hadNewItems: boolean
  /** Publisher floor in seconds (ttl, sy:updatePeriod, Cache-Control max-age). */
  floorSec?: number | null
}

/** New items reset to the base interval; unchanged fetches back off gently. */
export function nextIntervalSec(input: NextIntervalInput): number {
  const base = baseIntervalSec(input.itemsLast7d)
  let next = input.hadNewItems ? base : Math.min(MAX_INTERVAL_SEC, input.currentSec * 1.5)
  if (input.floorSec && input.floorSec > next) next = input.floorSec
  return clampInterval(next)
}

/** ±10% jitter so feeds fetched together drift apart. */
export function withJitter(sec: number, random: () => number = Math.random): number {
  const factor = 0.9 + random() * 0.2
  return Math.round(sec * factor)
}

/** Exponential backoff on errors, capped at a week. */
export function backoffSec(intervalSec: number, errorCount: number): number {
  return Math.min(MAX_BACKOFF_SEC, Math.round(intervalSec * 2 ** Math.min(errorCount, 20)))
}

/** Retry-After as seconds, from either form. */
export function parseRetryAfter(header: string | null, now: Date): number | null {
  if (!header) return null
  const asNumber = Number(header)
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber)
  const asDate = new Date(header)
  if (Number.isNaN(asDate.getTime())) return null
  return Math.max(0, Math.round((asDate.getTime() - now.getTime()) / 1000))
}

/** max-age from Cache-Control, in seconds. */
export function cacheControlMaxAge(header: string | null): number | null {
  const m = header?.match(/max-age=(\d+)/i)
  return m ? Number(m[1]) : null
}

/** Number of consecutive errors after which a feed is considered dead. */
export const DEAD_AFTER_ERRORS = 30
