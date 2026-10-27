/**
 * The API's one way in (ADRs 0064, 0065): an access token in `Authorization: Bearer` (RFC 6750),
 * resolved in one batch that also counts the app's rate limits. Never a cookie, never a token in
 * the query string, and never a session: what passes here is an `AppPrincipal`, which no internal
 * route takes and which is never admin.
 */
import { type AppPrincipal, resolveToken } from '@tela/data'
import type { AppScope } from '@tela/shared'
import type { Context, MiddlewareHandler } from 'hono'
import type { ApiDeps } from '../deps'

export type { AppPrincipal }

export type GatewayEnv = { Variables: { app: AppPrincipal } }

/** The realm every challenge names. */
const REALM = 'tela'

/** How long an app is told to wait while the operator has stopped every app (`apps.enabled`). */
export const PAUSED_RETRY_SEC = 300

/**
 * RFC 6750 §2.1's `b64token`, after the scheme, which is case-insensitive. Anything else in the
 * header is no token at all.
 */
const BEARER = /^bearer +([A-Za-z0-9\-._~+/]+=*)$/i

/** The token an `Authorization` header carries, or null for none or one that is not a bearer. */
export function bearerToken(header: string | undefined): string | null {
  return header ? (BEARER.exec(header.trim())?.[1] ?? null) : null
}

/** A challenge (RFC 6750 §3): bare when no token came, with the error and scope otherwise. */
function challenge(error?: string, scope?: AppScope): string {
  const parts = [`realm="${REALM}"`]
  if (error) parts.push(`error="${error}"`)
  if (scope) parts.push(`scope="${scope}"`)
  return `Bearer ${parts.join(', ')}`
}

/** 401 `invalid_token`: no token, or one that does not resolve. */
export function invalidToken(c: Context, presented: boolean) {
  return c.json({ error: 'invalid_token' }, 401, {
    'www-authenticate': challenge(presented ? 'invalid_token' : undefined),
  })
}

/**
 * 403 `app_suspended`: the operator cut the app off for now. Its challenge names the error, as
 * every 403 here does (RFC 6750 §3; an extension code, since the token itself is good: an app
 * keeps it, and it works again once the app is restored).
 */
export function appSuspended(c: Context) {
  return c.json({ error: 'app_suspended' }, 403, {
    'www-authenticate': challenge('app_suspended'),
  })
}

/** 503 `apps_paused`: the operator has stopped every app. */
export function appsPaused(c: Context) {
  return c.json({ error: 'apps_paused' }, 503, { 'retry-after': String(PAUSED_RETRY_SEC) })
}

/** 429 `rate_limited`, with how long to wait. */
export function rateLimited(c: Context, retryAfterSec: number) {
  return c.json({ error: 'rate_limited' }, 429, { 'retry-after': String(retryAfterSec) })
}

/**
 * Resolve the bearer token and set `c.get('app')`, or answer: 401 for no token or a bad one, 503
 * while apps are stopped, 429 past the app's limits. Cookies are never read, so a browser's session
 * reaches nothing here.
 */
export function bearer(deps: Pick<ApiDeps, 'db' | 'clock'>): MiddlewareHandler<GatewayEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization')
    const token = bearerToken(header)
    if (!token) return invalidToken(c, header !== undefined)
    const resolved = await resolveToken(deps.db, token, deps.clock.now())
    if (!resolved.ok) {
      if (resolved.error === 'apps_paused') return appsPaused(c)
      if (resolved.error === 'app_suspended') return appSuspended(c)
      if (resolved.error === 'rate_limited') return rateLimited(c, resolved.retryAfterSec)
      return invalidToken(c, true)
    }
    c.set('app', resolved.principal)
    return next()
  }
}

/**
 * Hold a route to a scope: `write` refuses a read-only token with 403 `insufficient_scope`, naming
 * the scope it needs (RFC 6750 §3.1). The token's scope is already the lower of what the member
 * granted and the app's ceiling.
 */
export function requireScope(scope: AppScope): MiddlewareHandler<GatewayEnv> {
  return async (c, next) => {
    if (scope === 'write' && c.get('app').scope !== 'write') {
      return c.json({ error: 'insufficient_scope' }, 403, {
        'www-authenticate': challenge('insufficient_scope', scope),
      })
    }
    return next()
  }
}
