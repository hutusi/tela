/**
 * Tela's own limits: per member, for actions that create rows, fetch on a member's behalf, spend
 * model tokens or change how they sign in; per email address, on the codes better-auth mails and
 * checks and on password sign-ins; per IP, code and address, on joins with an invite code; per IP,
 * on handle checks. Fixed windows in D1 (`action_limits`), one upsert per check, because nothing in
 * an isolate's memory survives to the next request. better-auth limits its own endpoints per IP,
 * separately (`rate_limit`).
 */
import { sql } from 'drizzle-orm'
import type { TelaDb } from '../db'

export type ActionLimit = { limit: number; windowSec: number }

/** The Postgres stack's member limits, unchanged; then the sign-in ones (ADRs 0036, 0034). */
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
  /**
   * A body converted between the Chinese scripts costs no call (ADR 0038), and a Traditional
   * reader opens one with every Simplified post, so it has its own bucket: counted against the
   * paid one, a morning's reading would refuse the next real translation.
   */
  convert: { limit: 600, windowSec: 3600 },
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
  /**
   * Passwords tried against one address from anywhere (ADR 0036), beside better-auth's five a
   * minute per IP. A locked-out address still has its code, which these never count.
   */
  passwordSignIn: { limit: 10, windowSec: 900 },
  /**
   * Joins with an invite code (ADR 0034). Each mails a code through tela-api's own call to
   * better-auth, which its limiter never sees, so `/api/v1/join` counts them here: per IP (an
   * IPv6 /64, as better-auth keys it), per address (and in `otpSend`), and per code.
   */
  joinIp: { limit: 10, windowSec: 3600 },
  joinAddress: { limit: 3, windowSec: 3600 },
  /**
   * The least a code allows: one with more places allows as many joins an hour as it has, so a
   * code for a crowd lets the crowd in. Twice `joinIp`, so no one client spends a code's hour.
   */
  joinCode: { limit: 20, windowSec: 3600 },
  /** A member's new invite codes: five count at once, but every revoked one stays a row. */
  inviteCreate: { limit: 20, windowSec: 3600 },
  /**
   * Whether a handle is free, per IP, asked as For writers' card is typed: a name takes a few dozen
   * debounced checks, so this is room for anyone choosing one, not for walking the namespace.
   */
  handleCheck: { limit: 300, windowSec: 3600 },
  /**
   * A member's ways in (ADR 0036), changed through tela-api's own calls to better-auth, which its
   * limiter never sees. A password set or changed costs a hash or two, and a change with the wrong
   * current password is a guess at it; a link writes an OAuth state row; an unlink mails a notice.
   */
  passwordChange: { limit: 5, windowSec: 900 },
  accountLink: { limit: 10, windowSec: 3600 },
  accountUnlink: { limit: 10, windowSec: 3600 },
} as const satisfies Record<string, ActionLimit>

export type LimitedAction = keyof typeof ACTION_LIMITS

export type LimitResult = { allowed: boolean; retryAfterSec: number }

/**
 * Count one attempt in the current window and say whether it is within the limit: the action's,
 * or `limit` when the subject has its own (an invite code's places).
 */
export async function consumeLimit(
  db: TelaDb,
  action: LimitedAction,
  subject: string,
  now: number,
  limit: number = ACTION_LIMITS[action].limit,
): Promise<LimitResult> {
  const rule: ActionLimit = ACTION_LIMITS[action]
  const windowMs = rule.windowSec * 1000
  const windowStart = Math.floor(now / windowMs) * windowMs
  const rows = await db.all<{ count: number }>(sql`
    insert into action_limits (key, window_start, count) values (${`${action}:${subject}`}, ${windowStart}, 1)
    on conflict (key, window_start) do update set count = count + 1
    returning count
  `)
  const count = rows[0]?.count ?? limit + 1
  return {
    allowed: count <= limit,
    retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  }
}
