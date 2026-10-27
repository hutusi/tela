/**
 * The API's v1 routes (ADR 0065), behind the bearer token. A stub until the v1 routes land: only
 * `GET /v1/me`, enough for an app to check a connection. Mounted at `/gateway/v1`.
 */
import { first } from '@tela/data'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../deps'
import type { GatewayEnv } from '../auth'

export function v1Routes(deps: ApiDeps) {
  const routes = new Hono<GatewayEnv>()

  routes.get('/me', async (c) => {
    const app = c.get('app')
    const profile = await first<{ handle: string }>(
      deps.db,
      sql`select handle from profiles where user_id = ${app.userId}`,
    )
    if (!profile) return c.json({ error: 'invalid_token' }, 401)
    return c.json({ handle: profile.handle, scope: app.scope })
  })

  return routes
}
