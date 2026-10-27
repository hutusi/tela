/**
 * What the API host answers outside a version (ADR 0065), and what tela-gateway asks before it
 * serves content (ADR 0066):
 *
 * - `GET /meta`, with no token: the versions and their status, what each offers, the limits an
 *   app plans by (the site's daily limits as they are now), and where the OAuth metadata is.
 * - `GET /v1/openapi.json`, with no token: the document `docs/api/openapi.json` holds.
 * - `POST /opens`, with the app's token: which content keys its member may have now, under the
 *   day's limit on posts from blogs they do not follow. Never exempt, an admin's token included.
 */
import { admitOpens, readSettings } from '@tela/data'
import { openapiDocument } from '@tela/ext/openapi'
import { API_CURRENT_VERSION, API_VERSIONS, OPENS_KEYS_MAX, READING_LANGUAGES } from '@tela/shared'
import { HORIZON_DAYS, MAX_MUTATIONS_PER_PUSH, PAGE_ROWS } from '@tela/sync'
import { Hono } from 'hono'
import { PUSH_MAX_BYTES } from '../body-limits'
import type { ApiDeps } from '../deps'
import { opensKeys } from '../routes/edge'
import { bearer, type GatewayEnv } from './auth'

/**
 * What each version offers, by name. An app checks for a feature rather than a version: a later
 * addition within v1 (blogroll editing, claims, profile and privacy edits) is announced here.
 */
export const API_FEATURES: Record<string, readonly string[]> = {
  v1: [
    'sync',
    'mutations',
    'bodies',
    'translations',
    'feeds',
    'discover',
    'sites',
    'profiles',
    'blogrolls',
    'search',
    'articles',
  ],
}

let document: Record<string, unknown> | null = null

export function metaRoutes(deps: ApiDeps) {
  const routes = new Hono<GatewayEnv>()

  routes.get('/meta', async (c) => {
    const settings = await readSettings(deps.db)
    return c.json(
      {
        api: 'tela',
        current: API_CURRENT_VERSION,
        oldest: Math.min(...API_VERSIONS.map((v) => v.version)),
        versions: API_VERSIONS.map((v) => ({
          version: v.version,
          status: v.status,
          sunsetAt: v.sunsetAt,
        })),
        features: API_FEATURES,
        limits: {
          pushMutations: MAX_MUTATIONS_PER_PUSH,
          pushBytes: PUSH_MAX_BYTES,
          pageRows: PAGE_ROWS,
          bodiesPerRequest: OPENS_KEYS_MAX,
          horizonDays: HORIZON_DAYS,
          readingLanguages: READING_LANGUAGES,
          translationsPerDay: settings['member.translationsPerDay'],
          feedsPerDay: settings['member.feedsPerDay'],
          maxSubscriptions: settings['member.maxSubscriptions'],
          unsubscribedPostsPerDay: settings['member.unsubscribedPostsPerDay'],
        },
        oauth: { metadata: `${deps.config.apiUrl}/.well-known/oauth-authorization-server` },
      },
      200,
      { 'cache-control': 'public, max-age=300' },
    )
  })

  routes.get('/v1/openapi.json', (c) => {
    document ??= openapiDocument()
    return c.json(document, 200, { 'cache-control': 'public, max-age=300' })
  })

  routes.post('/opens', bearer(deps), async (c) => {
    const keys = opensKeys(await c.req.json().catch(() => null))
    if (!keys) return c.json({ error: 'invalid_request' }, 400, { 'cache-control': 'no-store' })
    const decision = await admitOpens(deps.db, {
      userId: c.get('app').userId,
      exempt: false,
      keys,
      now: deps.clock.now(),
    })
    return c.json(decision, 200, { 'cache-control': 'no-store' })
  })

  return routes
}
