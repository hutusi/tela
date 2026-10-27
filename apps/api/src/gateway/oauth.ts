/**
 * Tela's authorization server's own endpoints on the API host (ADR 0064): the token endpoint
 * (RFC 6749 §3.2, PKCE per RFC 7636, refresh tokens rotated), revocation (RFC 7009) and the
 * metadata (RFC 8414). Public native clients only: no client secret, no implicit or password
 * grant. The authorization endpoint is the reader's `/connect`, which needs the member's session;
 * its questions to tela-api are `routes/connect.ts`.
 *
 * Every answer here is form-in, JSON-out, `no-store`, and refusals use RFC 6749 §5.2's codes.
 */
import {
  consumeLimit,
  exchangeCode,
  first,
  type IssuedTokens,
  revokeToken,
  rotateRefresh,
  settingSql,
} from '@tela/data'
import { getIP } from 'better-auth/api'
import { sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Auth } from '../auth'
import type { ApiDeps } from '../deps'
import { appsPaused, type GatewayEnv, rateLimited } from './auth'
import { isVerifier, scopeText } from './authorize'

const NO_IP = 'no-trusted-ip'

/** RFC 6749 §5.1: a token response, and every refusal, is never cached by anyone. */
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' }

/** The issuer's metadata (RFC 8414 §2), from the API's own origin and the reader's. */
export function authorizationServerMetadata(config: ApiDeps['config']) {
  return {
    issuer: config.apiUrl,
    authorization_endpoint: `${config.publicUrl}/connect`,
    token_endpoint: `${config.apiUrl}/oauth/token`,
    revocation_endpoint: `${config.apiUrl}/oauth/revoke`,
    scopes_supported: ['read', 'write', 'email'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  }
}

/** An RFC 6749 §5.2 refusal: 400, or 401 for `invalid_client`. */
function refuse(c: Context, error: string, status: ContentfulStatusCode = 400) {
  return c.json({ error }, status, NO_STORE)
}

/**
 * A form body's fields (`application/x-www-form-urlencoded`, RFC 6749 §3.2), or null for any
 * other body, or one that names a field twice (§3.1: "MUST NOT be included more than once").
 */
async function readForm(c: Context): Promise<Map<string, string> | null> {
  const type = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/x-www-form-urlencoded') return null
  // Read as bytes: workerd warns at `.text()` on a body whose type is not text.
  const form = new URLSearchParams(new TextDecoder().decode(await c.req.arrayBuffer()))
  const fields = new Map<string, string>()
  for (const [name, value] of form) {
    if (fields.has(name)) return null
    fields.set(name, value)
  }
  return fields
}

const tokenAnswer = (tokens: IssuedTokens) => ({
  access_token: tokens.accessToken,
  token_type: 'Bearer',
  expires_in: tokens.expiresIn,
  refresh_token: tokens.refreshToken,
  scope: scopeText(tokens.scope, tokens.email),
})

export function oauthRoutes(deps: ApiDeps, auth: Auth) {
  const { db, clock, config } = deps
  const routes = new Hono<GatewayEnv>()

  routes.get('/.well-known/oauth-authorization-server', (c) =>
    c.json(authorizationServerMetadata(config), 200, { 'cache-control': 'public, max-age=3600' }),
  )

  /**
   * The client a form names, whether apps may act at all, and the count of this client's requests
   * from this IP (`appToken`): what both endpoints check first. Counted only for a client that
   * exists, so a made-up `client_id` costs one read and writes nothing.
   */
  const admit = async (
    c: Context,
    form: Map<string, string>,
  ): Promise<{ clientId: string; suspended: boolean } | Response> => {
    const clientId = form.get('client_id')
    if (!clientId) return refuse(c, 'invalid_request')
    const found = await first<{ enabled: number; app_id: number | null; status: string | null }>(
      db,
      sql`select (${settingSql('apps.enabled')} = 'on') as enabled,
        (select id from apps where client_id = ${clientId}) as app_id,
        (select status from apps where client_id = ${clientId}) as status`,
    )
    if (found?.enabled !== 1) return appsPaused(c)
    if (found.app_id === null) return refuse(c, 'invalid_client', 401)
    const ip = getIP(c.req.raw, auth.options) ?? NO_IP
    const limited = await consumeLimit(
      db,
      'appToken',
      ip,
      clock.now(),
      undefined,
      String(found.app_id),
    )
    if (!limited.allowed) return rateLimited(c, limited.retryAfterSec)
    return { clientId, suspended: found.status === 'suspended' }
  }

  /**
   * `POST /oauth/token`: `authorization_code` (with `code`, `redirect_uri`, `client_id` and
   * `code_verifier`) or `refresh_token` (with `refresh_token` and `client_id`). Every binding a
   * code or refresh token fails is the one answer, `invalid_grant`, so the endpoint says nothing
   * about which.
   */
  routes.post('/oauth/token', async (c) => {
    const form = await readForm(c)
    if (!form) return refuse(c, 'invalid_request')
    const grantType = form.get('grant_type')
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return refuse(c, grantType ? 'unsupported_grant_type' : 'invalid_request')
    }
    const admitted = await admit(c, form)
    if (admitted instanceof Response) return admitted
    const { clientId } = admitted
    // A cut-off app (RFC 6749's `unauthorized_client`) keeps its tokens: they work again once the
    // operator restores it, which `invalid_grant` would have told it to throw away.
    if (admitted.suspended) {
      return c.json(
        {
          error: 'unauthorized_client',
          error_description: 'This app is cut off by Tela for now; keep its tokens.',
        },
        400,
        NO_STORE,
      )
    }
    const now = clock.now()

    if (grantType === 'authorization_code') {
      const code = form.get('code')
      const redirectUri = form.get('redirect_uri')
      const codeVerifier = form.get('code_verifier')
      if (!code || !redirectUri || !codeVerifier || !isVerifier(codeVerifier)) {
        return refuse(c, 'invalid_request')
      }
      const tokens = await exchangeCode(db, { code, clientId, redirectUri, codeVerifier, now })
      return tokens ? c.json(tokenAnswer(tokens), 200, NO_STORE) : refuse(c, 'invalid_grant')
    }

    const refreshToken = form.get('refresh_token')
    if (!refreshToken) return refuse(c, 'invalid_request')
    const rotated = await rotateRefresh(db, { refreshToken, clientId, now })
    if (!rotated.ok) {
      if (rotated.reuse) console.warn('refresh token reused; device ended', { clientId })
      return refuse(c, 'invalid_grant')
    }
    return c.json(tokenAnswer(rotated.tokens), 200, NO_STORE)
  })

  /**
   * `POST /oauth/revoke` (RFC 7009): `token` and `client_id`; `token_type_hint` is read as the RFC
   * allows, by ignoring it, since either token ends the device. 200 whether or not anything
   * ended: a token that is not this client's, or not a token at all, is answered as one revoked.
   */
  routes.post('/oauth/revoke', async (c) => {
    const form = await readForm(c)
    const token = form?.get('token')
    if (!form || !token) return refuse(c, 'invalid_request')
    const admitted = await admit(c, form)
    if (admitted instanceof Response) return admitted
    await revokeToken(db, { token, clientId: admitted.clientId, now: clock.now() })
    return c.body(null, 200, NO_STORE)
  })

  return routes
}
