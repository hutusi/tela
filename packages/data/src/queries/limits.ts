/**
 * Tela's own limits: per member, for actions that create rows, fetch on a member's behalf or spend
 * model tokens; per email address, on the codes better-auth mails and checks. Fixed windows in D1
 * (`action_limits`), one upsert per check, because nothing in an isolate's memory survives to the
 * next request. better-auth limits its own endpoints per IP, separately (`rate_limit`).
 */
import { sql } from 'drizzle-orm'
import type { TelaDb } from '../db'

export type ActionLimit = { limit: number; windowSec: number }

/** The Postgres stack's member limits, unchanged; then the sign-in ones (ADR 0036). */
export const ACTION_LIMITS = {
  /** Discovery fetches arbitrary URLs on the member's behalf. */
  discover: { limit: 30, windowSec: 3600 },
  subscribe: { limit: 120, windowSec: 3600 },
  /** One import can add hundreds of feeds. */
  opmlImport: { limit: 5, windowSec: 3600 },
  claimStart: { limit: 10, windowSec: 3600 },
  claimVerify: { limit: 30, windowSec: 3600 },
  /** A body translation can cost a dozen model calls; a reader opens far fewer. */
  translate: { limit: 30, windowSec: 3600 },
  /** A member's whole history in one response (ADR 0031's "Your data"). */
  export: { limit: 10, windowSec: 3600 },
  /** A picture of their own (ADR 0033): each one is an object in R2 and a new address. */
  avatarUpload: { limit: 20, windowSec: 3600 },
  /**
   * Codes mailed to one address, from any IP and of any kind (sign-in, password reset, address
   * check). Each new code also brings three fresh tries, so this bounds the guesses as much as
   * the mail.
   */
  otpSend: { limit: 5, windowSec: 3600 },
  /**
   * Codes tried against one address from anywhere, on any endpoint that checks one. better-auth
   * counts per IP, and an IPv6 /48 is 65,536 of its buckets: enough to guess six digits within
   * minutes.
   */
  otpVerify: { limit: 10, windowSec: 3600 },
} as const satisfies Record<string, ActionLimit>

export type LimitedAction = keyof typeof ACTION_LIMITS

export type LimitResult = { allowed: boolean; retryAfterSec: number }

/** Count one attempt in the current window and say whether it is within the limit. */
export async function consumeLimit(
  db: TelaDb,
  action: LimitedAction,
  subject: string,
  now: number,
): Promise<LimitResult> {
  const rule: ActionLimit = ACTION_LIMITS[action]
  const windowMs = rule.windowSec * 1000
  const windowStart = Math.floor(now / windowMs) * windowMs
  const rows = await db.all<{ count: number }>(sql`
    insert into action_limits (key, window_start, count) values (${`${action}:${subject}`}, ${windowStart}, 1)
    on conflict (key, window_start) do update set count = count + 1
    returning count
  `)
  const count = rows[0]?.count ?? rule.limit + 1
  return {
    allowed: count <= rule.limit,
    retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  }
}
