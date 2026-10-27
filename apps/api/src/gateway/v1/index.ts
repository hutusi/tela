/**
 * The API's v1 routes (ADR 0065), mounted at `/gateway/v1` behind the bearer token, each with its
 * own documented format (`@tela/ext/schema`, `docs/api/openapi.json`) over the shared rules:
 *
 * - `sync.ts`: `/sync` and `/mutations`;
 * - `member.ts`: `/me`, `/usage`, `/translations`, `/feeds`;
 * - `public.ts`: `/discover/*`, `/sites/{id}`, `/profiles/{handle}`, `/blogrolls/{id}`, `/search`,
 *   `/articles/{id}`.
 *
 * Bodies, translations and images (`/v1/bodies`, `/o/*`, `/img/*`) are tela-gateway's own, from
 * R2, decided by `POST /gateway/opens`. `/v1/openapi.json` takes no token and is mounted before
 * the token's check (`createGateway`).
 */
import { Hono } from 'hono'
import type { ApiDeps } from '../../deps'
import type { GatewayEnv } from '../auth'
import { memberRoutes } from './member'
import { publicRoutes } from './public'
import { syncRoutes } from './sync'

export function v1Routes(deps: ApiDeps) {
  const routes = new Hono<GatewayEnv>()
  routes.route('/', syncRoutes(deps))
  routes.route('/', memberRoutes(deps))
  routes.route('/', publicRoutes(deps))
  return routes
}
