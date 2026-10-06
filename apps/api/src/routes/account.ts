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
 * - `POST /sign-out-everywhere` ends every session the member has but this one.
 *
 * Live answers, not synced rows: these are security state, decided on the server, and a device's
 * copy would be out of date exactly when it matters. Every call reads the session from D1, not the
 * five-minute signed copy the other routes trust, so a session that a reset or "sign out
 * everywhere" ended can do nothing here while its copy lives on. Setting or changing the password
 * ends the member's other sessions, and every change mails them a notice; a link does both at the
 * provider's return (`auth.ts`), and is written there only while the browser that comes back still
 * holds one of the member's sessions, read from D1 as here. tela-api's own calls to better-auth
 * pass none of its limits, so each change is counted per member, once it is known to be one: a
 * refusal for a stale session or an account that is not the member's spends nothing.
 */
import { consumeLimit, type LimitedAction } from '@tela/data'
import { isAPIError } from 'better-auth/api'
import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiEnv, Member } from '../app'
import { type Auth, endOtherSessions, FRESH_SECONDS, notifyMember, PASSWORD_LENGTH } from '../auth'
import type { ApiDeps } from '../deps'
import type { AccountChange } from '../mail'

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
    await endOtherSessions(db, member.id, c.get('session').token).catch((err) =>
      console.error('sessions not ended', member.id, err),
    )
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
    const ended = await endOtherSessions(db, c.get('member').id, c.get('session').token)
    return c.json({ ended })
  })

  return routes
}
