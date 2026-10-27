/**
 * A member's ways in (ADR 0036), at `/api/v1/account`, behind the member check every `/api/v1`
 * route has:
 *
 * - `GET /` is what they have: their address, whether they have a password, the providers linked,
 *   and whether the session is fresh enough to add a way in.
 * - `POST /password {newPassword, currentPassword?}` sets the first password, on a fresh session,
 *   or changes it, given the current one.
 * - `POST /link {provider}` starts linking Google or GitHub, on a fresh session: it answers where
 *   to send the browser, and sets the cookie that ties the provider's return to it.
 * - `POST /unlink {accountId}` removes a linked provider, on a fresh session.
 * - `POST /sign-out-everywhere` ends every session the member has but this one, and every app
 *   connected to the account (ADR 0064).
 * - `POST /delete/code` mails a code to delete the account, and `POST /delete {code}` deletes it
 *   with that code (ADR 0058), then clears this browser's cookies.
 *
 * Live answers, not synced rows: these are security state, decided on the server, and a device's
 * copy would be out of date exactly when it matters. Every call reads the session from D1, not the
 * five-minute signed copy the other routes trust, so a session that a reset or "sign out
 * everywhere" ended can do nothing here while its copy lives on. Setting or changing the password
 * ends the member's other sessions and connected apps, and every change mails them a notice; a
 * link does both at the provider's return (`auth.ts`), and is written there only while the browser
 * that comes back still holds one of the member's sessions, read from D1 as here. tela-api's own
 * calls to better-auth pass none of its limits, so each change is counted per member, once it is
 * known to be one: a refusal for a stale session or an account that is not the member's spends
 * nothing.
 */
import {
  closeAccount,
  closureKey,
  consumeLimit,
  first,
  type LimitedAction,
  memberAllowances,
  newGroupId,
  nextUtcDay,
  writeClosure,
} from '@tela/data'
import type { AccountUsage } from '@tela/shared'
import { isAPIError } from 'better-auth/api'
import { sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiEnv, Member } from '../app'
import { type Auth, endOtherSessions, FRESH_SECONDS, notifyMember, PASSWORD_LENGTH } from '../auth'
import type { ApiDeps } from '../deps'
import { type AccountChange, deleteAccountMail } from '../mail'
import { mailLocale } from '../mail-locale'

/** The session a call came with, as D1 has it now: its token, and when it was made (ms). */
type Session = { token: string; createdAt: number }
type AccountEnv = { Variables: ApiEnv['Variables'] & { session: Session } }

/** The providers a member may link, each once its app is configured. */
const PROVIDERS = ['google', 'github'] as const
type Provider = (typeof PROVIDERS)[number]
const isProvider = (value: unknown): value is Provider =>
  PROVIDERS.some((provider) => provider === value)

/**
 * Whether the session was made within `freshAge`, as better-auth judges it for its own fresh-only
 * endpoints. It stamps a session with the wall clock, not tela-api's, so it is read against that.
 */
const isFresh = (session: Session) => Date.now() - session.createdAt < FRESH_SECONDS * 1000

/** A JSON object's fields; anything else, `null` and malformed JSON included, has none. */
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null)
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

/**
 * better-auth's refusal of a call tela-api made for the member, answered as Tela answers: its code
 * in lowercase (`invalid_password` for a wrong current password), with its status. Anything that
 * is not a refusal is thrown on.
 */
function refused(c: Context, err: unknown) {
  if (!isAPIError(err)) throw err
  const code = typeof err.body?.code === 'string' ? err.body.code.toLowerCase() : 'refused'
  return c.json({ error: code }, err.statusCode as ContentfulStatusCode)
}

/** How long a code to delete the account holds, and how many tries it takes, as a sign-in code. */
export const DELETE_CODE_MS = 60 * 60_000
export const DELETE_CODE_TRIES = 3
/**
 * Where the code is kept: Tela's own row in better-auth's `verification` table, named as
 * better-auth names its codes (`<type>-otp-<address>`), so closing the account deletes it with
 * theirs. No better-auth endpoint checks a type it does not know, so none can spend it.
 */
export const deleteCodeIdentifier = (address: string) => `account-delete-otp-${address}`

/** Six digits, each as likely as any other: 32-bit draws above the last whole million are redrawn. */
export function drawDeleteCode(): string {
  const limit = 4_294_000_000
  for (;;) {
    const [n = limit] = crypto.getRandomValues(new Uint32Array(1))
    if (n < limit) return String(n % 1_000_000).padStart(6, '0')
  }
}

/** A code as stored: its SHA-256, never the code, as better-auth stores its own (`hashed`). */
async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function accountRoutes(deps: ApiDeps, auth: Auth) {
  const { db } = deps
  const routes = new Hono<AccountEnv>()

  const spend = async (action: LimitedAction, member: Member) =>
    (await consumeLimit(db, action, member.id, deps.clock.now())).allowed

  /**
   * Tell the member what changed, in their interface language, never the browser's: the notice is
   * for whoever holds the address. A notice that fails to go is logged: the change is made.
   */
  const notify = (member: Member, change: AccountChange) => notifyMember(deps, member, change)

  /** The linked providers, oldest first, and whether a password is set. */
  const waysIn = async (headers: Headers) => {
    const accounts = await auth.api.listUserAccounts({ headers })
    const linked = accounts
      .filter((account) => isProvider(account.providerId))
      .map((account) => ({
        id: account.id,
        provider: account.providerId,
        since: account.createdAt.getTime(),
      }))
      .sort((a, b) => a.since - b.since)
    return { linked, hasPassword: accounts.some((account) => account.providerId === 'credential') }
  }

  /**
   * `GET /usage`: what the member has used of their limits today (ADR 0063), live, for Settings
   * and for the cap the reader checks before it subscribes. Registered before the session check
   * below, which it does not need: it is no security state, and the member check every `/api/v1`
   * route has already names the member. An admin's limits do not apply to them, so they read as
   * none (`exempt` says why).
   */
  routes.get('/usage', async (c) => {
    const now = deps.clock.now()
    const used = await memberAllowances(db, c.get('member').id, now)
    const none = (limit: number | null) => (used.exempt ? null : limit)
    const answer: AccountUsage = {
      translations: {
        perDay: none(used.translations.perDay),
        usedToday: used.translations.usedToday,
        waiting: used.translations.waiting,
        resetsAt: nextUtcDay(now),
      },
      feeds: {
        perDay: none(used.feeds.perDay),
        addedToday: used.feeds.addedToday,
        pending: used.feeds.pending,
      },
      subscriptions: { max: none(used.subscriptions.max), count: used.subscriptions.count },
      exempt: used.exempt,
    }
    return c.json(answer, 200, { 'cache-control': 'no-store' })
  })

  routes.use('*', async (c, next) => {
    const found = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    })
    if (!found || found.user.id !== c.get('member').id) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    c.set('session', { token: found.session.token, createdAt: found.session.createdAt.getTime() })
    return next()
  })

  routes.get('/', async (c) => {
    const { linked, hasPassword } = await waysIn(c.req.raw.headers)
    const fresh = isFresh(c.get('session'))
    return c.json({ email: c.get('member').email, hasPassword, linked, fresh }, 200, {
      'cache-control': 'no-store',
    })
  })

  /**
   * The first password needs a fresh session, as any way in added does; a new one needs the
   * current one instead, which better-auth checks (400 `invalid_password`). Either way the
   * member's other sessions end. A password of the wrong length is refused before it is counted.
   */
  routes.post('/password', async (c) => {
    const body = await readBody(c)
    const { newPassword, currentPassword } = body
    if (typeof newPassword !== 'string') return c.json({ error: 'new_password_required' }, 400)
    if (newPassword.length < PASSWORD_LENGTH.min) {
      return c.json({ error: 'password_too_short' }, 400)
    }
    if (newPassword.length > PASSWORD_LENGTH.max) {
      return c.json({ error: 'password_too_long' }, 400)
    }
    const member = c.get('member')
    const headers = c.req.raw.headers
    const { hasPassword } = await waysIn(headers)
    let change: () => Promise<unknown>
    if (hasPassword) {
      if (typeof currentPassword !== 'string') {
        return c.json({ error: 'current_password_required' }, 400)
      }
      change = () => auth.api.changePassword({ headers, body: { newPassword, currentPassword } })
    } else {
      if (!isFresh(c.get('session'))) return c.json({ error: 'session_not_fresh' }, 403)
      change = () => auth.api.setPassword({ headers, body: { newPassword } })
    }
    if (!(await spend('passwordChange', member))) return c.json({ error: 'rate_limited' }, 429)
    try {
      await change()
    } catch (err) {
      return refused(c, err)
    }
    // The password is changed by now, and neither failure below undoes it: each is logged, as at
    // a link's return, and the member is told whether or not the other sessions ended.
    await endOtherSessions(
      db,
      member.id,
      c.get('session').token,
      'password',
      deps.clock.now(),
    ).catch((err) => console.error('sessions not ended', member.id, err))
    await notify(member, { kind: hasPassword ? 'password-changed' : 'password-set' })
    return c.json({ ok: true })
  })

  /**
   * Start linking a provider: better-auth writes the OAuth state, naming the member, and its
   * cookie, which is passed on. Where the provider returns to is fixed here, so nothing a client
   * sends can send the member elsewhere: `/settings?linked=<provider>`, or `/settings?error=` with
   * better-auth's code (`account_already_linked_to_different_user`, say). 404 `unknown_provider`
   * for one Tela does not offer.
   */
  routes.post('/link', async (c) => {
    const { provider } = await readBody(c)
    if (!isProvider(provider) || !deps.config.oauth?.[provider]) {
      return c.json({ error: 'unknown_provider' }, 404)
    }
    if (!isFresh(c.get('session'))) return c.json({ error: 'session_not_fresh' }, 403)
    const member = c.get('member')
    if (!(await spend('accountLink', member))) return c.json({ error: 'rate_limited' }, 429)
    try {
      const { headers, response } = await auth.api.linkSocialAccount({
        headers: c.req.raw.headers,
        body: {
          provider,
          callbackURL: `/settings?linked=${provider}`,
          errorCallbackURL: '/settings',
          disableRedirect: true,
        },
        returnHeaders: true,
      })
      for (const cookie of headers.getSetCookie()) c.header('set-cookie', cookie, { append: true })
      return c.json({ url: response.url }, 200, { 'cache-control': 'no-store' })
    } catch (err) {
      return refused(c, err)
    }
  })

  /**
   * Remove a linked provider. Only a provider: a password is changed or reset, not removed here.
   * 404 `not_found` for any account that is not one of the member's providers.
   */
  routes.post('/unlink', async (c) => {
    const { accountId } = await readBody(c)
    if (!isFresh(c.get('session'))) return c.json({ error: 'session_not_fresh' }, 403)
    const headers = c.req.raw.headers
    const account = (await waysIn(headers)).linked.find((a) => a.id === accountId)
    if (!account) return c.json({ error: 'not_found' }, 404)
    const member = c.get('member')
    if (!(await spend('accountUnlink', member))) return c.json({ error: 'rate_limited' }, 429)
    try {
      await auth.api.unlinkAccount({ headers, body: { accountId: account.id } })
    } catch (err) {
      return refused(c, err)
    }
    await notify(member, { kind: 'unlinked', provider: account.provider })
    return c.json({ ok: true })
  })

  /**
   * End every session the member has but this one, fresh or not, and say how many. Not counted:
   * anyone holding one of the member's sessions could spend the count, and keep the member from
   * ending that very session.
   */
  routes.post('/sign-out-everywhere', async (c) => {
    const ended = await endOtherSessions(
      db,
      c.get('member').id,
      c.get('session').token,
      'signOutEverywhere',
      deps.clock.now(),
    )
    return c.json({ ended })
  })

  /** An admin's account is not deleted from Settings: the console is ungranted first (ADR 0058). */
  const isAdmin = async (member: Member) =>
    (
      await first<{ is_admin: number }>(
        db,
        sql`select is_admin from profiles where user_id = ${member.id}`,
      )
    )?.is_admin === 1

  /**
   * Mail a code to delete the account, to the address it signs in with: a fresh one each time,
   * replacing any before it. Counted as every code mailed to an address is (`otpSend`, ADR 0036),
   * so this cannot mail an address more than a sign-in can. The code is in the language this
   * browser chose, else the account's, as a sign-in code is.
   */
  routes.post('/delete/code', async (c) => {
    const member = c.get('member')
    if (await isAdmin(member)) return c.json({ error: 'admin' }, 403)
    const address = member.email.toLowerCase()
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'otpSend', address, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    const code = drawDeleteCode()
    const identifier = deleteCodeIdentifier(address)
    const value = JSON.stringify({ hash: await hashCode(code), tries: 0 })
    await db.batch([
      db.run(sql`delete from verification where identifier = ${identifier}`),
      db.run(sql`
        insert into verification (id, identifier, value, expires_at, created_at, updated_at)
        values (${crypto.randomUUID()}, ${identifier}, ${value}, ${now + DELETE_CODE_MS}, ${now},
          ${now})
      `),
    ])
    const account = await first<{ ui_locale: string | null }>(
      db,
      sql`select ui_locale from profiles where user_id = ${member.id}`,
    )
    const locale = mailLocale({
      cookie: c.req.header('cookie'),
      acceptLanguage: c.req.header('accept-language'),
      account: account?.ui_locale,
    })
    await deps.mail.send(deleteAccountMail({ to: member.email, code, locale }))
    return c.json({ sent: true }, 200, { 'cache-control': 'no-store' })
  })

  /**
   * Delete the account with the code just mailed (ADR 0058). Each try is counted as every code
   * checked against an address is (`otpVerify`), and spends one of the code's three, so a wrong
   * code is answered as such until the code is used up. The closure is recorded before the account
   * closes, so a closing that fails is still re-applied after a restore; then the account closes in
   * one batch (`closeAccount`), and this browser's cookies are cleared. Every other device is
   * refused from its next call (`guarded` in app.ts).
   */
  routes.post('/delete', async (c) => {
    const member = c.get('member')
    const { code } = await readBody(c)
    const entered = typeof code === 'string' ? code.trim() : ''
    if (!/^\d{6}$/.test(entered)) return c.json({ error: 'invalid_code' }, 400)
    if (await isAdmin(member)) return c.json({ error: 'admin' }, 403)
    const address = member.email.toLowerCase()
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'otpVerify', address, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    const tried = await db.all<{ value: string }>(sql`
      update verification set value = json_set(value, '$.tries', json_extract(value, '$.tries') + 1),
        updated_at = ${now}
      where identifier = ${deleteCodeIdentifier(address)} and expires_at > ${now}
        and (case when json_valid(value) then json_extract(value, '$.tries') end) < ${DELETE_CODE_TRIES}
      returning value
    `)
    const stored = tried[0] ? (JSON.parse(tried[0].value) as { hash?: unknown }).hash : undefined
    if (stored === undefined || stored !== (await hashCode(entered))) {
      return c.json({ error: 'invalid_code' }, 400)
    }
    await writeClosure(deps.blobs, member.id, now)
    const closed = await closeAccount(db, {
      userId: member.id,
      actor: member.id,
      action: 'account.delete',
      group: newGroupId(),
      now,
      refuseAdmin: true,
    })
    if (closed === 'admin') {
      // Made an admin since it was read: nothing closed, so no closure may stand for a restore.
      await deps.blobs.delete(closureKey(member.id))
      return c.json({ error: 'admin' }, 403)
    }
    // The session is gone by now; better-auth's sign-out still expires this browser's cookies.
    const { headers } = await auth.api.signOut({ headers: c.req.raw.headers, returnHeaders: true })
    for (const cookie of headers.getSetCookie()) c.header('set-cookie', cookie, { append: true })
    return c.json({ deleted: true }, 200, { 'cache-control': 'no-store' })
  })

  return routes
}
