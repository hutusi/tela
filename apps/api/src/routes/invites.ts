/**
 * Invite codes (ADR 0034): joining with one, a member's five, and the operator's own.
 *
 * - `POST /api/v1/join {code, email}` is a visitor's, with no session. It mails through
 *   `auth.api`, which better-auth's limiter never sees, so it counts its own: per IP, per address
 *   and per code.
 * - `GET`, `POST /api/v1/invites` and `DELETE /api/v1/invites/:code` are a member's, live answers
 *   like the dashboard rather than synced rows: an invite list holds other people's state, and a
 *   code is minted and counted against the five by the server, the moment it exists.
 * - `POST`, `GET /api/admin/codes` and `DELETE /api/admin/codes/:code` are the operator's
 *   (`bun run admin code|codes|revoke`).
 */
import {
  ACTION_LIMITS,
  consumeLimit,
  createMemberCode,
  createOperatorCode,
  holdJoin,
  type LimitedAction,
  listMemberCodes,
  listOperatorCodes,
  livePlaces,
  revokeCode,
  revokeOperatorCode,
} from '@tela/data'
import { INVITE_ALLOWANCE, isOperatorCode, normalizeInviteCode } from '@tela/shared'
import { getIP } from 'better-auth/api'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { Auth } from '../auth'
import type { ApiDeps } from '../deps'
import { languageHeaders } from '../mail-locale'
import { fromOperator } from '../operator'

/**
 * An address better-auth will mail and sign in: zod's `email()`, which its endpoints check. Tested
 * before anything is held, so no hold is written for an address that could never finish.
 */
const ADDRESS =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/
/** No deliverable address is longer (RFC 5321). */
const ADDRESS_MAX = 254
/** better-auth's bucket for a request whose IP it cannot tell, which all such requests share. */
const NO_IP = 'no-trusted-ip'
/** Draws of a member's code before giving up: among 30^12, even one clash is not expected. */
const DRAWS = 3
/** An operator code's places, as the schema checks them. */
const MAX_USES = 100_000

/** A JSON object's fields; anything else, `null` and malformed JSON included, has none. */
async function readBody(c: {
  req: { json(): Promise<unknown> }
}): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null)
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

/** A visitor's join, and a member's codes, at `/api/v1`, whose session check skips `/join`. */
export function inviteRoutes(deps: ApiDeps, auth: Auth) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  /**
   * Join with a code (ADR 0034): hold the address beside it for a day, then mail it a sign-in code,
   * which says it is invited. The hold takes no place: signing in takes one. An address that has an
   * account is mailed an ordinary sign-in code, and takes neither a hold nor a place; the answer is
   * the same 200, so it says nothing of who is a member. 400 `invalid_code` for a code that is
   * unknown or revoked (one answer for both), 409 `code_used` once everyone it was for has joined.
   */
  routes.post('/join', async (c) => {
    const body = await readBody(c)
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (email.length > ADDRESS_MAX || !ADDRESS.test(email)) {
      return c.json({ error: 'invalid_email' }, 400)
    }
    const code = normalizeInviteCode(body.code)
    if (!code) return c.json({ error: 'invalid_code' }, 400)
    const now = deps.clock.now()
    // Per IP first, before the code is looked up: the limit is the client's own, and it bounds
    // guesses at codes.
    const ip = getIP(c.req.raw, auth.options) ?? NO_IP
    if (!(await consumeLimit(db, 'joinIp', ip, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    // The rest are shared, so only a join with a live code spends them: junk spends no address's
    // hour nor any code's, not even a word's before the operator makes it a code, and the 400 says
    // no more than a 200 or 409 would. The address's come first, so a client hammering one address
    // spends none of the code's, and its mails count with the login page's (`otpSend`). A code
    // allows as many as it has places, and never fewer than twice what one client may send.
    const places = await livePlaces(db, code)
    if (places === null) return c.json({ error: 'invalid_code' }, 400)
    const limits: [LimitedAction, string, number?][] = [
      ['joinAddress', email],
      ['otpSend', email],
      ['joinCode', code, Math.max(ACTION_LIMITS.joinCode.limit, places)],
    ]
    for (const [action, subject, limit] of limits) {
      if (!(await consumeLimit(db, action, subject, now, limit)).allowed) {
        return c.json({ error: 'rate_limited' }, 429)
      }
    }
    const outcome = await holdJoin(db, { code, email, now })
    if (outcome === 'invalid') return c.json({ error: 'invalid_code' }, 400)
    if (outcome === 'used') return c.json({ error: 'code_used' }, 409)
    // The mail gate (`auth.ts`) finds the hold, or the account, and mails accordingly, in the
    // joiner's language: their language cookie and Accept-Language go along, and nothing else of
    // their request does.
    await auth.api.sendVerificationOTP({
      body: { email, type: 'sign-in' },
      headers: languageHeaders(c.req.raw.headers),
    })
    return c.json({ ok: true })
  })

  /** The member's codes that count toward their five, and who joined with each, by handle. */
  routes.get('/invites', async (c) => {
    const codes = await listMemberCodes(db, c.get('member').id)
    return c.json({ allowance: INVITE_ALLOWANCE, codes }, 200, { 'cache-control': 'no-store' })
  })

  /** A new code, while fewer than five of the member's count: 409 `allowance_used` past that. */
  routes.post('/invites', async (c) => {
    const member = c.get('member')
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'inviteCreate', member.id, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    for (let draw = 0; draw < DRAWS; draw++) {
      const made = await createMemberCode(db, { userId: member.id, now })
      if (made.ok) return c.json({ code: made.code, createdAt: now, joinedAt: null, handle: null })
      if (made.reason === 'allowance') return c.json({ error: 'allowance_used' }, 409)
    }
    return c.json({ error: 'try_again' }, 503)
  })

  /**
   * Revoke one of the member's own codes nobody has joined with: its place among the five is free
   * again, and the addresses waiting on it can no longer sign in with it. 404 for any other code.
   */
  routes.delete('/invites/:code', async (c) => {
    const code = normalizeInviteCode(c.req.param('code'))
    const userId = c.get('member').id
    if (!code || !(await revokeCode(db, { code, userId, now: deps.clock.now() }))) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({ ok: true })
  })

  return routes
}

/** The operator's codes, behind `ADMIN_TOKEN`. Mounted at `/api/admin/codes`. */
export function operatorCodeRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.use('*', async (c, next) => {
    if (!fromOperator(c, deps.config.adminToken)) return c.json({ error: 'forbidden' }, 403)
    return next()
  })

  /**
   * A code of the operator's own text with `uses` places (one when not given). The text is
   * normalized like any code typed in, and may not have a member code's shape, which is how a code
   * says whose it is. 409 `code_exists` for a code that exists already, whoever made it.
   */
  routes.post('/', async (c) => {
    const body = await readBody(c)
    const code = normalizeInviteCode(body.code)
    if (!code) return c.json({ error: 'invalid_code' }, 400)
    if (!isOperatorCode(code)) return c.json({ error: 'member_shaped' }, 400)
    const uses = body.uses === undefined ? 1 : body.uses
    if (typeof uses !== 'number' || !Number.isInteger(uses) || uses < 1 || uses > MAX_USES) {
      return c.json({ error: 'invalid_uses' }, 400)
    }
    if (!(await createOperatorCode(db, { code, maxUses: uses, now: deps.clock.now() }))) {
      return c.json({ error: 'code_exists' }, 409)
    }
    return c.json({ code, maxUses: uses })
  })

  routes.get('/', async (c) =>
    c.json({ codes: await listOperatorCodes(db, deps.clock.now()) }, 200, {
      'cache-control': 'no-store',
    }),
  )

  /**
   * Withdraw an operator code, used or not: nobody else joins with it, and its holds are cancelled.
   * Those who joined keep their accounts. 404 for an unknown, revoked or member's code.
   */
  routes.delete('/:code', async (c) => {
    const code = normalizeInviteCode(c.req.param('code'))
    if (!code || !(await revokeOperatorCode(db, { code, now: deps.clock.now() }))) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({ ok: true })
  })

  return routes
}
