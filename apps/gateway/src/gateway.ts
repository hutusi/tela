/**
 * tela-gateway (ADR 0065): `api.telaread.com`, Tela's API for approved apps. A thin edge in front
 * of tela-api, bearer-only by construction:
 *
 * - Every request loses its `Cookie`, and any `Authorization` that is not an access token
 *   (`Bearer tela_at_…`) is refused here, except on the routes that take none (`/meta`, the
 *   OpenAPI document, OAuth's own endpoints and metadata, `robots.txt`). Every answer says `noindex`, HSTS and the API's
 *   version, and sets no cookie.
 * - Content is served here, from R2 through the colo (`@tela/edge`, the same handler as
 *   tela-web's): `/o/*`, `/img/*` and `/v1/bodies?keys=`. Each is decided first by tela-api
 *   (`POST /gateway/opens`, with the app's token), and an answer is kept 60 seconds per token and
 *   post, so cutting an app off reaches its images within a minute (ADR 0066).
 * - The public side (`/v1/discover/*`, `/v1/sites/*`, `/v1/profiles/*`, `/v1/blogrolls/*`) is the
 *   same for every viewer: tela-api's answer is kept five minutes per colo, keyed by path and
 *   query and never by token, and served only to a token tela-api accepted in the last minute.
 * - Everything else goes to tela-api under `/gateway` (`/v1/sync` → `/gateway/v1/sync`): outside
 *   `/api/`, so nothing tela-web forwards ever reaches it.
 *
 * Portable: built from interfaces, so the bun suite runs it with memory blobs, a map for a cache
 * and a fake tela-api.
 */
import {
  type Authorization,
  CACHE_ORIGIN,
  CONTENT_KEY,
  createContent,
  createMarks,
  type EdgeCache,
  type OpensDecision,
  settle,
  sha256Hex,
  type Waiter,
} from '@tela/edge'
import type { Blobs } from '@tela/platform'
import {
  ACCESS_TOKEN_PREFIX,
  API_CURRENT_VERSION,
  API_VERSION_HEADER,
  OPENS_KEYS_MAX,
} from '@tela/shared'

export type GatewayDeps = {
  blobs: Blobs
  /** tela-api, over the service binding. */
  api: { fetch(request: Request): Promise<Response> }
  /** The colo's cache (`caches.default` on Cloudflare). */
  cache: EdgeCache
  /** Outbound fetch for the image proxy. */
  fetchImage: (url: string, init: RequestInit) => Promise<Response>
  /** The clock kept answers expire by; `Date.now` unless a test says. */
  now?: () => number
}

/** How long an allowed post stays allowed for a token without asking tela-api again. */
export const DECISION_TTL_MS = 60_000
/** How long a token tela-api accepted is taken as good for a public answer kept in the colo. */
export const TOKEN_TTL_MS = 60_000
/** How long the colo keeps a public answer. */
export const PUBLIC_TTL_MS = 5 * 60_000
const HSTS = 'max-age=31536000'
/** How soon to ask again when tela-api could not answer. */
const RETRY_SECONDS = 30
/** tela-api's own answers that are the app's to read: the token, its scope, a limit, a pause. */
const PASSED_THROUGH: ReadonlySet<number> = new Set([401, 403, 429, 503])
/** An access token, and nothing else: the prefix and base64url. */
const ACCESS_TOKEN = new RegExp(`^${ACCESS_TOKEN_PREFIX}[A-Za-z0-9_-]{16,256}$`)
/** The public side: the same for every viewer, so kept per colo. */
const PUBLIC_PATH = /^\/v1\/(?:discover|sites|profiles|blogrolls)\//
/** When a kept public answer ends, epoch ms. Never sent on. */
const UNTIL = 'x-tela-until'
const ROBOTS = 'User-agent: *\nDisallow: /\n'

/** The routes that take no token: whatever `Authorization` they carry is tela-api's to read. */
export function takesNoToken(path: string): boolean {
  return (
    path === '/meta' ||
    path === '/v1/openapi.json' ||
    path === '/robots.txt' ||
    path === '/.well-known/oauth-authorization-server' ||
    path.startsWith('/oauth/')
  )
}

/** What this edge serves itself, from R2. */
const servedHere = (path: string) =>
  path.startsWith('/o/') || path.startsWith('/img/') || path === '/v1/bodies'

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

/** RFC 6750: no token at all is told only that one is needed; a bad one, that it is invalid. */
const invalidToken = (given: boolean) =>
  json({ error: 'invalid_token' }, 401, {
    'www-authenticate': given ? 'Bearer error="invalid_token"' : 'Bearer',
  })

const unavailable = () =>
  json({ error: 'unavailable' }, 503, { 'retry-after': String(RETRY_SECONDS) })

/** The access token an `Authorization` header carries, or null. The scheme's case is free. */
export function bearerToken(header: string | null): string | null {
  if (header?.slice(0, 7).toLowerCase() !== 'bearer ') return null
  const token = header.slice(7).trim()
  return ACCESS_TOKEN.test(token) ? token : null
}

/** tela-api's decision as it answered it, or null when it is not one. */
function decisionOf(body: unknown): OpensDecision | null {
  const d = body as Partial<OpensDecision> | null
  if (!d || !Array.isArray(d.allowed) || typeof d.refused !== 'object' || d.refused === null) {
    return null
  }
  return { allowed: d.allowed.filter((k) => typeof k === 'string'), refused: d.refused }
}

/** A public answer the colo may keep for every token: one tela-api did not mark as anyone's. */
function keepsAtTheColo(res: Response): boolean {
  if (res.status !== 200 || res.headers.has('set-cookie')) return false
  const control = (res.headers.get('cache-control') ?? '').toLowerCase()
  return !/\b(no-store|private|no-cache)\b/.test(control)
}

export function createGateway(deps: GatewayDeps) {
  const { api, cache } = deps
  const now = deps.now ?? Date.now
  const marks = createMarks(cache, now)
  /**
   * When this isolate last told the colo a token is good: an app syncing calls many times a
   * minute, and each would otherwise write the same fact again.
   */
  const told = new Map<string, number>()

  async function tokenKnown(who: string): Promise<boolean> {
    return marks.has(`gw/token/${who}`)
  }

  async function rememberToken(who: string, waiter?: Waiter): Promise<void> {
    const at = now()
    if ((told.get(who) ?? 0) > at - TOKEN_TTL_MS / 2) return
    if (told.size > 10_000) told.clear()
    told.set(who, at)
    await marks.set(`gw/token/${who}`, at + TOKEN_TTL_MS, waiter)
  }

  async function forgetToken(who: string, waiter?: Waiter): Promise<void> {
    told.delete(who)
    await marks.forget(`gw/token/${who}`, waiter)
  }

  /** What tela-api's answer says of the token: good for a minute, or no good at all. */
  async function learn(who: string | null, res: Response, waiter?: Waiter): Promise<void> {
    if (who === null) return
    if (res.ok) await rememberToken(who, waiter)
    else if (res.status === 401) await forgetToken(who, waiter)
  }

  /**
   * Whether the token's member may have these posts (ADR 0066): what tela-api allowed for this
   * token in the last minute asks nothing; the rest is `POST /gateway/opens`, with the token, and
   * tela-api's refusal of the token itself (401, 403, 429, 503) is the app's answer as it is.
   */
  async function authorize(
    request: Request,
    keys: string[],
    waiter?: Waiter,
  ): Promise<Authorization> {
    const token = bearerToken(request.headers.get('authorization'))
    if (!token) return { ok: false, response: invalidToken(request.headers.has('authorization')) }
    if (keys.length === 0) return { ok: true, decision: { allowed: [], refused: {} } }
    const who = await sha256Hex(token)
    const known = await Promise.all(keys.map((k) => marks.has(`gw/opens/${who}/${k}`)))
    const allowed = keys.filter((_, i) => known[i])
    const unknown = keys.filter((_, i) => !known[i])
    if (unknown.length === 0) return { ok: true, decision: { allowed, refused: {} } }
    const headers = new Headers(request.headers)
    headers.delete('cookie')
    headers.delete('content-length')
    headers.set('content-type', 'application/json')
    let res: Response
    try {
      res = await api.fetch(
        new Request(new URL('/gateway/opens', request.url).toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify({ keys: unknown }),
        }),
      )
    } catch (err) {
      console.error('opens decision failed', err)
      return { ok: false, response: unavailable() }
    }
    await learn(who, res, waiter)
    if (PASSED_THROUGH.has(res.status)) return { ok: false, response: res }
    const decision = res.ok ? decisionOf(await res.json().catch(() => null)) : null
    if (!decision) {
      console.error('opens decision unavailable', res.status)
      return { ok: false, response: unavailable() }
    }
    const until = now() + DECISION_TTL_MS
    const fresh = decision.allowed.filter((k) => unknown.includes(k))
    await Promise.all(fresh.map((k) => marks.set(`gw/opens/${who}/${k}`, until, waiter)))
    return { ok: true, decision: { allowed: [...allowed, ...fresh], refused: decision.refused } }
  }

  const content = createContent({
    blobs: deps.blobs,
    cache,
    fetch: deps.fetchImage,
    authorize,
    now,
  })

  /** `GET /v1/bodies?keys=a,b,…`: up to a bundle's worth, in the bundle's shape. */
  async function bodies(request: Request, url: URL, waiter?: Waiter): Promise<Response> {
    const keys = [...new Set((url.searchParams.get('keys') ?? '').split(','))]
    if (
      keys.length === 0 ||
      keys.length > OPENS_KEYS_MAX ||
      !keys.every((k) => CONTENT_KEY.test(k))
    ) {
      return json({ error: 'invalid_request' }, 400)
    }
    return content.serveBundle(request, keys, waiter)
  }

  /** tela-api's answer for this request, under `/gateway`. */
  async function forward(
    request: Request,
    url: URL,
    who: string | null,
    waiter?: Waiter,
  ): Promise<Response> {
    const target = new URL(`/gateway${url.pathname}${url.search}`, url)
    const read = request.method === 'GET' || request.method === 'HEAD'
    let res: Response
    try {
      res = await api.fetch(
        new Request(target.toString(), {
          method: request.method,
          headers: request.headers,
          body: read ? null : request.body,
          redirect: 'manual',
        }),
      )
    } catch (err) {
      console.error('tela-api unreachable', url.pathname, err)
      return unavailable()
    }
    await learn(who, res, waiter)
    return res
  }

  /**
   * The public side through the colo's copy: the same for every viewer, so kept by path and
   * query, never by token, and served only to a token tela-api accepted in the last minute, so a
   * token cut off gets nothing kept either. Only an answer that names its language (`?lang=`) is
   * kept: without one, tela-api answers in the member's own reading language. And only what
   * tela-api did not mark as anyone's (`private`, `no-store`, `no-cache`, a cookie).
   */
  async function publicSide(
    request: Request,
    url: URL,
    who: string,
    waiter?: Waiter,
  ): Promise<Response> {
    if (!url.searchParams.has('lang')) return forward(request, url, who, waiter)
    const query = new URLSearchParams(url.searchParams)
    query.sort()
    const key = new Request(`${CACHE_ORIGIN}/gw/public${url.pathname}?${query.toString()}`)
    if (await tokenKnown(who)) {
      const hit = await cache.match(key)
      if (hit && Number(hit.headers.get(UNTIL)) > now()) {
        const response = new Response(hit.body, hit)
        response.headers.delete(UNTIL)
        return response
      }
    }
    const res = await forward(request, url, who, waiter)
    if (!keepsAtTheColo(res)) return res
    const body = await res.arrayBuffer()
    const kept = new Response(body, res)
    kept.headers.set(UNTIL, String(now() + PUBLIC_TTL_MS))
    kept.headers.set('cache-control', `public, max-age=${PUBLIC_TTL_MS / 1000}`)
    await settle(cache.put(key, kept), waiter)
    return new Response(body, res)
  }

  async function route(request: Request, waiter?: Waiter): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    if (path === '/robots.txt') {
      return new Response(ROBOTS, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      })
    }
    // Cookies never cross: host-only cookies should never come here, and none is ever read.
    const headers = new Headers(request.headers)
    headers.delete('cookie')
    const given = headers.has('authorization')
    const token = takesNoToken(path) ? null : bearerToken(headers.get('authorization'))
    if (given && token === null && !takesNoToken(path)) return invalidToken(true)
    const read = request.method === 'GET' || request.method === 'HEAD'
    const inbound = new Request(request.url, {
      method: request.method,
      headers,
      body: read ? null : request.body,
      redirect: 'manual',
    })
    if (servedHere(path)) {
      if (!read) return json({ error: 'invalid_request' }, 405, { allow: 'GET, HEAD' })
      if (token === null) return invalidToken(false)
      if (path === '/v1/bodies') return bodies(inbound, url, waiter)
      return (await content.serve(inbound, waiter)) ?? json({ error: 'not_found' }, 404)
    }
    const who = token === null ? null : await sha256Hex(token)
    if (request.method === 'GET' && who !== null && PUBLIC_PATH.test(path)) {
      return publicSide(inbound, url, who, waiter)
    }
    return forward(inbound, url, who, waiter)
  }

  return {
    async fetch(request: Request, waiter?: Waiter): Promise<Response> {
      const answer = await route(request, waiter)
      // Every answer, from here or tela-api: never indexed, never a cookie, and which API it is.
      const response = new Response(answer.body, answer)
      response.headers.delete('set-cookie')
      response.headers.set('x-robots-tag', 'noindex')
      response.headers.set('strict-transport-security', HSTS)
      response.headers.set(API_VERSION_HEADER, String(API_CURRENT_VERSION))
      return response
    },
  }
}
