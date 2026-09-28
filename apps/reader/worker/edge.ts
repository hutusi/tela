/**
 * tela-web's Worker (ADR 0020, 0024): the one public Worker, running at the reader's edge,
 * unpinned. It never queries D1.
 *
 * - `/api/*` goes to tela-api, pinned beside D1, over a service binding.
 * - `/o/*` serves immutable content, translation and chunk objects from R2 to members, cached per
 *   colo after the session check; `/o/bundle` serves up to 25 content objects in one response.
 * - `/img/<contentKey>/<index>` proxies the image a content object names (ADR 0007's rules),
 *   replacing the HMAC-signed `/img?u=` of the Postgres app: the object is the allowlist.
 * - Sessions are read from better-auth's signed five-minute cookie cache with the shared secret.
 *   Only when that has lapsed does it ask tela-api, and passes on the refreshed cookie.
 *
 * Portable: built from interfaces, so the bun suite runs it with memory blobs and a fake cache.
 */
import { isBlockedHost } from '@tela/ingest/net'
import type { Blobs } from '@tela/platform'
import { getCookieCache } from 'better-auth/cookies'

export type EdgeCache = {
  match(key: Request): Promise<Response | undefined>
  put(key: Request, response: Response): Promise<void>
}

export type EdgeDeps = {
  blobs: Blobs
  /** tela-api, over the service binding. */
  api: { fetch(request: Request): Promise<Response> }
  /** The colo's cache (`caches.default` on Cloudflare). */
  cache: EdgeCache
  /** Outbound fetch for the image proxy. */
  fetchImage: (url: string, init: RequestInit) => Promise<Response>
  config: {
    /** The secret tela-api signs sessions with; the same value on both Workers. */
    authSecret: string
    /** While set, nothing is indexed (ADR 0015). */
    privateBeta: boolean
  }
}

type Waiter = { waitUntil(promise: Promise<unknown>): void }

const OBJECT_KEY =
  /^(?:c\/[0-9a-f]{32}\.json|t\/[0-9a-f]{32}\/[A-Za-z-]{2,16}\/[0-9a-f]{8,64}\.json|tc\/[0-9a-f]{32}\/[A-Za-z-]{2,16}\/[A-Za-z0-9-]{1,64}\/\d{1,4}\.json)$/
const CONTENT_KEY = /^[0-9a-f]{32}$/
const BUNDLE_MAX = 25
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10_000
const IMAGE_UA = 'Tela/0.1 (+https://tela.ainaive.com; image proxy)'
const OBJECT_CACHE = 'private, max-age=31536000, immutable'
const IMAGE_CACHE = 'private, max-age=604800, immutable'
/** The cache's own namespace: keys are never a URL a reader can request directly. */
const CACHE_ORIGIN = 'https://tela-edge.cache'

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  })

export function createEdge(deps: EdgeDeps) {
  const { blobs, api, cache, config } = deps

  /** A member's session: from the signed cookie cache, else from tela-api (one D1 read). */
  async function session(request: Request): Promise<{ setCookies: string[] } | null> {
    const secure = new URL(request.url).protocol === 'https:'
    const cached = await getCookieCache(request, {
      secret: config.authSecret,
      cookiePrefix: 'tela',
      isSecure: secure,
    }).catch(() => null)
    if (cached) return { setCookies: [] }
    const cookie = request.headers.get('cookie') ?? ''
    if (!cookie.includes('tela.session_token')) return null
    const res = await api.fetch(
      new Request(new URL('/api/auth/get-session', request.url).toString(), {
        headers: { cookie },
      }),
    )
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { session?: unknown } | null
    return body?.session ? { setCookies: res.headers.getSetCookie() } : null
  }

  /** An R2 object, through the colo's cache. Objects never change, so a hit is always right. */
  async function object(key: string, waiter?: Waiter): Promise<string | null> {
    const cacheKey = new Request(`${CACHE_ORIGIN}/o/${key}`)
    const hit = await cache.match(cacheKey)
    if (hit) return hit.text()
    const stored = await blobs.get(key)
    if (!stored) return null
    const body = await stored.text()
    const put = cache.put(
      cacheKey,
      new Response(body, {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=31536000',
        },
      }),
    )
    if (waiter) waiter.waitUntil(put)
    else await put
    return body
  }

  function withCookies(response: Response, setCookies: string[]) {
    for (const c of setCookies) response.headers.append('set-cookie', c)
    return response
  }

  async function serveObject(request: Request, key: string, waiter?: Waiter) {
    if (!OBJECT_KEY.test(key)) return text('not found', 404)
    const member = await session(request)
    if (!member) return text('sign in first', 401)
    const body = await object(key, waiter)
    if (body === null) return text('not found', 404)
    return withCookies(
      new Response(body, {
        headers: {
          'content-type': 'application/json',
          'cache-control': OBJECT_CACHE,
          'x-robots-tag': 'noindex',
        },
      }),
      member.setCookies,
    )
  }

  async function serveBundle(request: Request, waiter?: Waiter) {
    const keys = [
      ...new Set(
        (new URL(request.url).searchParams.get('k') ?? '')
          .split(',')
          .filter((k) => CONTENT_KEY.test(k)),
      ),
    ].slice(0, BUNDLE_MAX)
    const member = await session(request)
    if (!member) return text('sign in first', 401)
    const parts = await Promise.all(
      keys.map(async (k) => {
        const body = await object(`c/${k}.json`, waiter)
        return body === null ? null : `${JSON.stringify(k)}:${body}`
      }),
    )
    return withCookies(
      new Response(`{${parts.filter((p) => p !== null).join(',')}}`, {
        headers: {
          'content-type': 'application/json',
          // The same keys always give the same bundle.
          'cache-control': OBJECT_CACHE,
          'x-robots-tag': 'noindex',
        },
      }),
      member.setCookies,
    )
  }

  async function serveImage(request: Request, contentKey: string, index: number, waiter?: Waiter) {
    const member = await session(request)
    if (!member) return text('sign in first', 401)
    const cacheKey = new Request(`${CACHE_ORIGIN}/img/${contentKey}/${index}`)
    const hit = await cache.match(cacheKey)
    if (hit) return withCookies(new Response(hit.body, hit), member.setCookies)
    const stored = await object(`c/${contentKey}.json`, waiter)
    if (stored === null) return text('not found', 404)
    const source = (JSON.parse(stored) as { images?: string[] }).images?.[index]
    if (!source) return text('not found', 404)
    let url: URL
    try {
      url = new URL(source)
    } catch {
      return text('not found', 404)
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || isBlockedHost(url.hostname)) {
      return text('forbidden', 403)
    }
    let upstream: Response
    try {
      upstream = await deps.fetchImage(url.toString(), {
        headers: { 'user-agent': IMAGE_UA, accept: 'image/*' },
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        redirect: 'follow',
      })
    } catch {
      return text('upstream failed', 502)
    }
    if (!upstream.ok || !upstream.body) return text('upstream failed', 502)
    const type =
      (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    // SVG can carry script; only raster types a browser renders in an <img>.
    if (!type.startsWith('image/') || type === 'image/svg+xml') return text('not an image', 415)
    const declared = Number(upstream.headers.get('content-length') ?? '0')
    if (declared > IMAGE_MAX_BYTES) return text('too large', 413)
    const bytes = await readAtMost(upstream.body, IMAGE_MAX_BYTES)
    if (!bytes) return text('too large', 413)
    const headers = {
      'content-type': type,
      'cache-control': IMAGE_CACHE,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-robots-tag': 'noindex',
    }
    const put = cache.put(cacheKey, new Response(bytes, { headers }))
    if (waiter) waiter.waitUntil(put)
    else await put
    return withCookies(new Response(bytes, { headers }), member.setCookies)
  }

  return {
    async fetch(request: Request, waiter?: Waiter): Promise<Response> {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === '/robots.txt') {
        return text(
          config.privateBeta ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n',
          200,
          {
            'cache-control': 'public, max-age=3600',
          },
        )
      }
      let response: Response
      if (path.startsWith('/api/')) {
        response = await api.fetch(request)
      } else if (path === '/o/bundle') {
        response = await serveBundle(request, waiter)
      } else if (path.startsWith('/o/')) {
        response = await serveObject(request, decodeURIComponent(path.slice(3)), waiter)
      } else if (path.startsWith('/img/')) {
        const [, , key = '', index = ''] = path.split('/')
        const i = Number(index)
        response =
          CONTENT_KEY.test(key) && Number.isInteger(i) && i >= 0 && i < 1000
            ? await serveImage(request, key, i, waiter)
            : text('not found', 404)
      } else {
        // Phase 6: the SPA's static assets answer everything else before this Worker runs.
        response = text('not found', 404)
      }
      if (config.privateBeta && !response.headers.has('x-robots-tag')) {
        response = new Response(response.body, response)
        response.headers.set('x-robots-tag', 'noindex, nofollow')
      }
      return response
    },
  }
}

/** Read a stream into memory, or null once it passes `max` bytes. */
async function readAtMost(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
