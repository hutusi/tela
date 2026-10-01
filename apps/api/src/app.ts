/**
 * tela-api's routes (ADR 0024). Portable: built from `ApiDeps`, so the Cloudflare entry and the
 * bun test suite run the same app. Reached only through tela-web, which forwards `/api/*`.
 */
import { schema } from '@tela/data'
import { CLIENT_HEADER, MEMBER_HEADER, MIN_CLIENT, pushSchema } from '@tela/sync'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { type Auth, createAuth } from './auth'
import type { ApiDeps } from './deps'
import { avatarRoutes } from './routes/avatars'
import { claimRoutes } from './routes/claims'
import { curate } from './routes/curate'
import { feedRoutes } from './routes/feeds'
import { memberRoutes } from './routes/members'
import { publicRoutes } from './routes/public'
import { socialRoutes } from './routes/social'
import { translationRoutes } from './routes/translations'
import { websubRoutes } from './routes/websub'
import { checkGravatarSoon } from './sync/gravatar'
import { answerPull } from './sync/pull'
import { applyPush, asksGravatar } from './sync/push'

export type Member = { id: string; email: string }
export type ApiEnv = { Variables: { member: Member } }

/** Constant-time comparison, so a wrong token takes as long as a nearly right one. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

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
   * Invite a member: create the account (registration is otherwise closed) and mail a sign-in
   * code. Operators call it with `bun run admin invite <email>`; D1 credentials never leave
   * Cloudflare.
   */
  app.post('/api/admin/invite', async (c) => {
    const token = deps.config.adminToken
    const given = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
    if (!token || !sameSecret(given, token)) return c.json({ error: 'forbidden' }, 403)
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown })
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!EMAIL.test(email)) return c.json({ error: 'invalid_email' }, 400)
    const ctx = await auth.$context
    const existing = await ctx.internalAdapter.findUserByEmail(email)
    const user =
      existing?.user ??
      (await ctx.internalAdapter.createUser(
        { email, name: email.split('@')[0] ?? email, emailVerified: false },
        { method: 'admin' },
      ))
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    return c.json({ userId: user.id, created: !existing })
  })

  /** Add a curated blog's feed and feature it in Discover (`bun run admin curate`). */
  app.post('/api/admin/curate', async (c) => {
    const token = deps.config.adminToken
    const given = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
    if (!token || !sameSecret(given, token)) return c.json({ error: 'forbidden' }, 403)
    const body = await c.req
      .json<{ feedUrl?: unknown; topics?: unknown }>()
      .catch(() => ({}) as { feedUrl?: unknown; topics?: unknown })
    if (typeof body.feedUrl !== 'string') return c.json({ error: 'invalid_url' }, 400)
    const topics = Array.isArray(body.topics)
      ? body.topics.filter((t): t is string => typeof t === 'string')
      : []
    const result = await curate(deps, body.feedUrl, topics)
    return 'error' in result ? c.json(result, 422) : c.json(result)
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
  app.route('/api/v1/public', publicRoutes(deps))
  // Hubs, not members, call this; the signature is the authorization.
  app.route('/api/websub', websubRoutes(deps))

  /**
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
    if (c.req.path.startsWith('/api/v1/public/')) return next()
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

  app.route('/api/v1/translations', translationRoutes(deps))
  app.route('/api/v1/feeds', feedRoutes(deps))
  app.route('/api/v1/claims', claimRoutes(deps))
  app.route('/api/v1', memberRoutes(deps))
  app.route('/api/v1', socialRoutes(deps))

  return { app, auth }
}
