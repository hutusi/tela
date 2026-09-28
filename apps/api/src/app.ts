/**
 * tela-api's routes (ADR 0024). Portable: built from `ApiDeps`, so the Cloudflare entry and the
 * bun test suite run the same app. Reached only through tela-web, which forwards `/api/*`.
 */
import { schema } from '@tela/data'
import { CLIENT_HEADER, MIN_CLIENT, pushSchema } from '@tela/sync'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { type Auth, createAuth } from './auth'
import type { ApiDeps } from './deps'
import { translationRoutes } from './routes/translations'
import { answerPull } from './sync/pull'
import { applyPush } from './sync/push'

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

export function createApp(deps: ApiDeps): { app: Hono<ApiEnv>; auth: Auth } {
  const auth = createAuth(deps)
  const app = new Hono<ApiEnv>()

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

  if (deps.config.testMode) {
    // e2e reads sign-in codes here instead of from a real inbox. Test mode only.
    app.get('/api/test/outbox', (c) => {
      const outbox = (deps.mail as { outbox?: { to: string; text: string }[] }).outbox ?? []
      const email = c.req.query('email')
      return c.json(outbox.filter((m) => !email || m.to === email))
    })
  }

  app.use('/api/v1/*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    c.set('member', { id: session.user.id, email: session.user.email })
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

  /** A client older than the protocol it speaks is told to reload, not left misreading rows. */
  const tooOld = (version: string | undefined) => {
    const n = Number(version ?? '0')
    return !Number.isInteger(n) || n < MIN_CLIENT
  }

  app.get('/api/v1/sync', async (c) => {
    if (tooOld(c.req.header(CLIENT_HEADER))) return c.json({ error: 'upgrade' }, 409)
    const cursor = Number(c.req.query('cursor') ?? '0')
    if (!Number.isInteger(cursor) || cursor < 0) return c.json({ error: 'invalid_cursor' }, 400)
    const pull = await answerPull(deps.db, c.get('member').id, cursor, deps.clock.now())
    return c.json(pull, 200, { 'cache-control': 'no-store' })
  })

  app.post('/api/v1/mutations', async (c) => {
    if (tooOld(c.req.header(CLIENT_HEADER))) return c.json({ error: 'upgrade' }, 409)
    const body = pushSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_push' }, 400)
    const result = await applyPush(
      deps.db,
      c.get('member').id,
      body.data.mutations,
      deps.clock.now(),
    )
    return c.json(result, 200, { 'cache-control': 'no-store' })
  })

  app.route('/api/v1/translations', translationRoutes(deps))

  return { app, auth }
}
