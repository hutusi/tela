/**
 * What tela-web's edge asks tela-api before it serves a member content (ADR 0066), over the
 * service binding with only the member's forwarded cookie: none of a browser's `x-tela-*`
 * headers, so it sits outside the `/api/v1/*` member checks. tela-web's edge refuses the path to
 * browsers (`/api/edge/*`), so only the edge itself reaches it.
 *
 * `POST /api/edge/opens` with `{ keys }` answers an `OpensDecision`: which content keys the
 * session's member may have now, under the day's limit on posts from blogs they do not follow. An
 * admin is exempt, as from every member limit; a closed or suspended account is signed out (401),
 * whatever copy of its session the cookie still carries.
 */
import { admitOpens, first } from '@tela/data'
import { OPENS_KEYS_MAX } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { Auth } from '../auth'
import type { ApiDeps } from '../deps'

const CONTENT_KEY = /^[0-9a-f]{32}$/

/** The keys a decision may name: a list of content keys, a bundle's worth at most. */
export function opensKeys(body: unknown): string[] | null {
  const keys = (body as { keys?: unknown } | null)?.keys
  if (!Array.isArray(keys) || keys.length > OPENS_KEYS_MAX) return null
  if (!keys.every((k): k is string => typeof k === 'string' && CONTENT_KEY.test(k))) return null
  return keys
}

export function edgeRoutes(deps: ApiDeps, auth: Auth) {
  const routes = new Hono<ApiEnv>()

  routes.post('/opens', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const keys = opensKeys(await c.req.json().catch(() => null))
    if (!keys) return c.json({ error: 'invalid_keys' }, 400)
    const userId = session.user.id
    // Standing and the admin flag in one read: the signed session copy outlives a closing by up
    // to five minutes, and an admin is exempt only while the profile says so.
    const profile = await first<{ is_admin: number; barred: number }>(
      deps.db,
      sql`select is_admin, (deleted_at is not null or suspended_at is not null) as barred
        from profiles where user_id = ${userId}`,
    )
    if (profile?.barred) return c.json({ error: 'unauthorized' }, 401)
    const decision = await admitOpens(deps.db, {
      userId,
      exempt: profile?.is_admin === 1,
      keys,
      now: deps.clock.now(),
    })
    return c.json(decision, 200, { 'cache-control': 'no-store' })
  })

  return routes
}
