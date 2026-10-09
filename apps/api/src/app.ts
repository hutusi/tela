/**
 * tela-api's routes (ADR 0024). Portable: built from `ApiDeps`, so the Cloudflare entry and the
 * bun test suite run the same app. Reached only through tela-web, which forwards `/api/*`.
 */
import { audit, bumpSeq, currentSeq, first, newGroupId, schema } from '@tela/data'
import { CLIENT_HEADER, MEMBER_HEADER, MIN_CLIENT, pushSchema } from '@tela/sync'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { type Auth, createAuth } from './auth'
import type { ApiDeps } from './deps'
import { fromOperator } from './operator'
import { accountRoutes } from './routes/account'
import { adminRoutes } from './routes/admin'
import { runBatch } from './routes/admin/framework'
import { avatarRoutes } from './routes/avatars'
import { claimRoutes } from './routes/claims'
import { curate } from './routes/curate'
import { feedRoutes } from './routes/feeds'
import { inviteMember } from './routes/invite-member'
import { inviteRoutes, operatorCodeRoutes } from './routes/invites'
import { memberRoutes } from './routes/members'
import { pictureRoutes } from './routes/picture'
import { publicRoutes } from './routes/public'
import { socialRoutes } from './routes/social'
import { translationRoutes } from './routes/translations'
import { websubRoutes } from './routes/websub'
import { checkGravatarSoon } from './sync/gravatar'
import { answerPull } from './sync/pull'
import { applyPush, asksGravatar } from './sync/push'

export type Member = { id: string; email: string }
export type ApiEnv = { Variables: { member: Member } }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The better-auth endpoints Tela uses, under `/api/auth` (ADR 0036): the session tela-web asks
 * for, a code mailed and signed in with, a password sign-in, the two reset steps, and a provider's
 * start and return. Signing out is served on its own, guarded, below. Everything else better-auth
 * mounts is a 404, because several of its endpoints act for a member in ways Tela never offers:
 * `/update-user` would let a member put any URL in `user.image`, and so in the signed session
 * cookie tela-web trusts.
 */
export const AUTH_ENDPOINTS = [
  ['GET', '/get-session'],
  ['POST', '/email-otp/send-verification-otp'],
  ['POST', '/sign-in/email-otp'],
  ['POST', '/sign-in/email'],
  ['POST', '/email-otp/request-password-reset'],
  ['POST', '/email-otp/reset-password'],
  ['POST', '/sign-in/social'],
  ['GET', '/callback/:provider{google|github}'],
] as const

/**
 * The endpoints that check a mailed code, and the refusals better-auth gives only while a code is
 * stored for the address: an expired one, and one tried three times. A stranger's code is never
 * stored (the mail gate deletes it, and a reset makes none), so a stranger only ever hears
 * `INVALID_OTP`; answered as better-auth answers them, the two would tell a guesser who is a member
 * after four wrong tries (ADR 0036). Each is answered as that wrong code instead, which is also
 * what it means to the person typing: ask for a new one.
 */
const CODE_CHECKS: ReadonlySet<string> = new Set([
  '/sign-in/email-otp',
  '/email-otp/reset-password',
])
const ONLY_A_MEMBER_HEARS: ReadonlySet<string> = new Set(['OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'])
// Byte for byte as better-auth writes it, keys in its order.
const WRONG_CODE = { message: 'Invalid OTP', code: 'INVALID_OTP' }

async function asWrongCode(answer: Response): Promise<Response> {
  if (answer.status !== 400 && answer.status !== 403) return answer
  const body = (await answer
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null
  if (typeof body?.code !== 'string' || !ONLY_A_MEMBER_HEARS.has(body.code)) return answer
  const headers = new Headers(answer.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify(WRONG_CODE), { status: 400, headers })
}

/** A client older than the protocol is told to reload, not left misreading rows. */
function tooOld(version: string | undefined): boolean {
  const n = Number(version ?? '0')
  return !Number.isInteger(n) || n < MIN_CLIENT
}

export function createApp(deps: ApiDeps): { app: Hono<ApiEnv>; auth: Auth } {
  const auth = createAuth(deps)
  const app = new Hono<ApiEnv>()

  // Signing out names the member too, in the same request that ends the session: a tab still
  // holding the account another tab signed out of must not end the session that tab started. A
  // client on protocol 2 or later that names someone else, or no one, is refused. Only shells
  // older than that sign out unchecked: they cannot name anyone, and refusing them would leave a
  // member signed in who asked not to be.
  app.post('/api/auth/sign-out', async (c) => {
    if (!tooOld(c.req.header(CLIENT_HEADER))) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers })
      if (session && c.req.header(MEMBER_HEADER) !== session.user.id) {
        return c.json({ error: 'account_changed' }, 409)
      }
    }
    return auth.handler(c.req.raw)
  })
  for (const [method, path] of AUTH_ENDPOINTS) {
    app.on(method, `/api/auth${path}`, async (c) => {
      const answer = await auth.handler(c.req.raw)
      return CODE_CHECKS.has(path) ? asWrongCode(answer) : answer
    })
  }
  app.all('/api/auth/*', (c) => c.json({ error: 'not_found' }, 404))

  app.get('/api/health', async (c) => {
    const started = Date.now()
    try {
      await deps.db.run(sql`select 1`)
      return c.json({ ok: true, databaseMs: Date.now() - started }, 200, {
        'cache-control': 'no-store',
      })
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 200) : 'unknown'
      return c.json({ ok: false, error }, 503, { 'cache-control': 'no-store' })
    }
  })

  /**
   * Invite a member: create the account and mail a sign-in code. Operators call it with
   * `bun run admin invite <email>`; D1 credentials never leave Cloudflare. The account passes the
   * same gate as everyone's (ADR 0034): the route writes the operator's invitation to the address,
   * an hour long, and creating the user claims it. An address that has an account is only mailed
   * a fresh code, and given no invitation it could keep.
   */
  app.post('/api/admin/invite', async (c) => {
    if (!fromOperator(c, deps.config.adminToken)) return c.json({ error: 'forbidden' }, 403)
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown })
    const invited = await inviteMember(deps, auth, typeof body.email === 'string' ? body.email : '')
    if (!invited) return c.json({ error: 'invalid_email' }, 400)
    return c.json(invited)
  })

  /**
   * Add a curated blog's feed, and feature it in Discover or list it (`bun run admin curate`).
   * `featured` is required: an older script that left it out would feature the whole list again.
   */
  app.post('/api/admin/curate', async (c) => {
    if (!fromOperator(c, deps.config.adminToken)) return c.json({ error: 'forbidden' }, 403)
    type Body = { feedUrl?: unknown; topics?: unknown; featured?: unknown; title?: unknown }
    const body = await c.req.json<Body>().catch(() => ({}) as Body)
    if (typeof body.feedUrl !== 'string') return c.json({ error: 'invalid_url' }, 400)
    if (typeof body.featured !== 'boolean') return c.json({ error: 'featured_required' }, 400)
    const title = typeof body.title === 'string' ? body.title.trim() : null
    if (body.title !== undefined && (!title || title.length > 200)) {
      return c.json({ error: 'invalid_title' }, 400)
    }
    const topics = Array.isArray(body.topics)
      ? body.topics.filter((t): t is string => typeof t === 'string')
      : []
    const result = await curate(deps, body.feedUrl, topics, body.featured, title)
    return 'error' in result ? c.json(result, 422) : c.json(result)
  })

  /** The operator's invite codes (`bun run admin code|codes|revoke`, ADR 0034). */
  app.route('/api/admin/codes', operatorCodeRoutes(deps))

  /**
   * Open or close the admin console for a member (`bun run admin grant|ungrant`, ADR 0039). Only
   * the operator's token grants it, so a member signed in to the console cannot make another
   * admin. The profile's seq moves, so the member's devices learn it on their next pull.
   */
  app.post('/api/admin/admins', async (c) => {
    if (!fromOperator(c, deps.config.adminToken)) return c.json({ error: 'forbidden' }, 403)
    const body = await c.req
      .json<{ email?: unknown; admin?: unknown }>()
      .catch(() => ({}) as { email?: unknown; admin?: unknown })
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!EMAIL.test(email) || typeof body.admin !== 'boolean') {
      return c.json({ error: 'invalid' }, 400)
    }
    const admin = body.admin
    const found = await first<{ id: string; is_admin: number }>(
      deps.db,
      sql`select u.id, p.is_admin from user u join profiles p on p.user_id = u.id
        where u.email = ${email}`,
    )
    if (!found) return c.json({ error: 'not_found' }, 404)
    const now = deps.clock.now()
    const flag = admin ? 1 : 0
    const target = sql`from profiles where user_id = ${found.id} and is_admin <> ${flag}`
    await runBatch(deps.db, [
      bumpSeq(deps.db),
      audit(
        deps.db,
        {
          group: newGroupId(),
          actor: null,
          action: admin ? 'admin.grant' : 'admin.ungrant',
          targetKind: 'member',
          targetKey: found.id,
          at: now,
        },
        { from: sql`json_object('isAdmin', is_admin = 1)`, to: { isAdmin: admin } },
        target,
      ),
      deps.db.run(sql`
        update profiles set is_admin = ${flag}, updated_at = ${now}, seq = ${currentSeq}
        where user_id = ${found.id} and is_admin <> ${flag}
      `),
    ])
    return c.json({ userId: found.id, admin, changed: found.is_admin !== flag })
  })

  if (deps.config.testMode) {
    // e2e reads sign-in codes here instead of from a real inbox. Test mode only.
    app.get('/api/test/outbox', (c) => {
      const outbox = (deps.mail as { outbox?: { to: string; text: string }[] }).outbox ?? []
      const email = c.req.query('email')
      return c.json(outbox.filter((m) => !email || m.to === email))
    })
    // …and run tela-jobs' sweeps when a step needs their work done.
    // `?refetch=1` makes every feed due first, for a spec that changed a fixture feed.
    app.post('/api/test/cycle', async (c) => {
      if (!deps.cycle) return c.json({ error: 'no_jobs' }, 404)
      return c.json(await deps.cycle({ refetch: c.req.query('refetch') === '1' }))
    })
  }

  // Anyone may read these; tela-web caches them at the edge.
  app.route('/api/v1/public/avatars', avatarRoutes(deps))
  app.route('/api/v1/public', publicRoutes(deps, auth))
  // Hubs, not members, call this; the signature is the authorization.
  app.route('/api/websub', websubRoutes(deps))

  /**
   * Joining with an invite code is a visitor's: `/api/v1/join` needs no session (ADR 0034).
   *
   * Every other /api/v1 route acts for the session's member, and runs only for a client that
   * names that member. Tabs share the cookie, so after another tab signs in as someone else the
   * cookie is theirs while this tab's screen, rows and unsent changes are still the first
   * account's; answered, its pull would mix the two and its push, profile save or claim would act
   * for the first account as the second. The checks run in this order:
   *
   * 1. `/api/v1/me` passes: it is how a tab learns who is signed in, and says only that.
   * 2. A client older than `MIN_CLIENT` is told to upgrade. It names no one, and `upgrade` is the
   *    only 409 the first shell knows: `account_changed` would have it retry for ever.
   * 3. A client that names anyone else, or no one, is told the account changed. It forgets what
   *    it holds and starts over as the session's member. Told to upgrade, a current client would
   *    reload into the same state.
   */
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path.startsWith('/api/v1/public/') || c.req.path === '/api/v1/join') return next()
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const member = { id: session.user.id, email: session.user.email }
    c.set('member', member)
    if (c.req.path === '/api/v1/me') return next()
    if (tooOld(c.req.header(CLIENT_HEADER))) return c.json({ error: 'upgrade' }, 409)
    if (c.req.header(MEMBER_HEADER) !== member.id) return c.json({ error: 'account_changed' }, 409)
    return next()
  })

  app.get('/api/v1/me', async (c) => {
    const member = c.get('member')
    const [profile] = await deps.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, member.id))
      .limit(1)
    return c.json({ id: member.id, email: member.email, profile: profile ?? null })
  })

  app.get('/api/v1/sync', async (c) => {
    const cursor = Number(c.req.query('cursor') ?? '0')
    if (!Number.isInteger(cursor) || cursor < 0) return c.json({ error: 'invalid_cursor' }, 400)
    const pull = await answerPull(deps.db, c.get('member').id, cursor, deps.clock.now())
    return c.json(pull, 200, { 'cache-control': 'no-store' })
  })

  app.post('/api/v1/mutations', async (c) => {
    const body = pushSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_push' }, 400)
    const member = c.get('member').id
    const result = await applyPush(deps.db, member, body.data.mutations, deps.clock.now())
    if (asksGravatar(body.data.mutations, result.applied)) await checkGravatarSoon(deps, member)
    return c.json(result, 200, { 'cache-control': 'no-store' })
  })

  app.route('/api/v1/admin', adminRoutes(deps, auth))
  app.route('/api/v1/translations', translationRoutes(deps))
  app.route('/api/v1/feeds', feedRoutes(deps))
  app.route('/api/v1/claims', claimRoutes(deps))
  app.route('/api/v1', memberRoutes(deps))
  app.route('/api/v1', pictureRoutes(deps))
  app.route('/api/v1', socialRoutes(deps))
  app.route('/api/v1', inviteRoutes(deps, auth))
  app.route('/api/v1/account', accountRoutes(deps, auth))

  return { app, auth }
}
