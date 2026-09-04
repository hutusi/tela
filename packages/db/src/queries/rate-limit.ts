import { lt, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { rateLimits } from '../schema'

export type RateLimitRule = { limit: number; windowSec: number }

/** Per-member ceilings for actions that create rows or make outbound requests. */
export const RATE_LIMITS = {
  /** Feed discovery fetches arbitrary URLs on the member's behalf. */
  discover: { limit: 30, windowSec: 3600 },
  subscribe: { limit: 120, windowSec: 3600 },
  /** One import can add hundreds of feeds. */
  opmlImport: { limit: 5, windowSec: 3600 },
  claimStart: { limit: 10, windowSec: 3600 },
  claimVerify: { limit: 30, windowSec: 3600 },
} as const satisfies Record<string, RateLimitRule>

export type RateLimitAction = keyof typeof RATE_LIMITS

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  /** Seconds until the current window ends. */
  retryAfterSec: number
}

/** Count one attempt in the current fixed window and report whether it is within the rule. */
export async function consumeRateLimit(
  db: Db,
  action: RateLimitAction,
  subject: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const rule: RateLimitRule = RATE_LIMITS[action]
  const windowMs = rule.windowSec * 1000
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)
  const [row] = await db
    .insert(rateLimits)
    .values({ key: `${action}:${subject}`, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count })
  const count = row?.count ?? rule.limit + 1
  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSec: Math.max(
      1,
      Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000),
    ),
  }
}

/** Drop windows that started more than a day ago; nothing reads them after they close. */
export async function pruneRateLimits(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000)
  const rows = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, cutoff))
    .returning({ key: rateLimits.key })
  return rows.length
}
