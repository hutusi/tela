/**
 * The app surface (ADRs 0064, 0065), mounted in tela-api at `/gateway`: outside `/api/`, so
 * tela-web's forwarding never reaches it, and only tela-gateway, on `api.telaread.com`, sends
 * requests here. Bearer tokens only: nothing under this mount reads a cookie or a session, so a
 * browser signed in to Tela reaches nothing through it, and no internal route takes a token.
 *
 * - `/.well-known/oauth-authorization-server`, `/oauth/token`, `/oauth/revoke`: `oauth.ts`.
 * - `/meta` and `/v1/openapi.json`, with no token, and `/opens`, tela-gateway's question before
 *   it serves content: `meta.ts`.
 * - `/v1/*`: the API, each route behind the token (`auth.ts`).
 *
 * Every answer says which API version answered it (`tela-api-version`), and none is stored by a
 * cache unless its route says otherwise.
 */
import { API_CURRENT_VERSION, API_VERSION_HEADER } from '@tela/shared'
import { Hono, type MiddlewareHandler } from 'hono'
import type { Auth } from '../auth'
import type { ApiDeps } from '../deps'
import { bearer, type GatewayEnv } from './auth'
import { metaRoutes } from './meta'
import { oauthRoutes } from './oauth'
import { v1Routes } from './v1'

/**
 * Stamps every answer under `/gateway`, the app-wide 404 and 500 included: `app.use` in
 * `createApp`, since a sub-app's middleware does not wrap the parent's not-found answer.
 */
export function gatewayHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    c.header(API_VERSION_HEADER, String(API_CURRENT_VERSION))
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store')
  }
}

export function createGateway(deps: ApiDeps, auth: Auth) {
  const gateway = new Hono<GatewayEnv>()
  gateway.route('/', oauthRoutes(deps, auth))
  // Before the token's check, which `/v1/openapi.json` does not take.
  gateway.route('/', metaRoutes(deps))
  gateway.use('/v1/*', bearer(deps))
  gateway.route('/v1', v1Routes(deps))
  return gateway
}
