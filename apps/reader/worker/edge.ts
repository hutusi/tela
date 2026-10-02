/**
 * tela-web's Worker (ADR 0020, 0024): the one public Worker, running at the reader's edge,
 * unpinned. It never queries D1.
 *
 * - `/api/*` goes to tela-api, pinned beside D1, over a service binding.
 * - `/o/*` serves immutable content, translation and chunk objects from R2 to members, cached per
 *   colo after the session check; `/o/bundle` serves up to 25 content objects in one response.
 * - `/img/<contentKey>/<index>` proxies the image a content object names (ADR 0007's rules),
 *   replacing the HMAC-signed `/img?u=` of the Postgres app: the object is the allowlist.
 * - `/avatar/<userId>?v=` is a member's picture (ADR 0032), from tela-api, cached per colo.
 * - Sessions are read from better-auth's signed five-minute cookie cache with the shared secret.
 *   Only when that has lapsed does it ask tela-api, and passes on the refreshed cookie.
 * - `/` (for visitors), `/discover`, `/s/:id` and `/@handle` are rendered here from tela-api's
 *   public JSON, poured into the SPA's index.html and cached per colo, locale and deploy for five
 *   minutes; `/about`, `/privacy` and `/terms` the same way, from the bundle alone. A request to
 *   `/` that carries a session cookie is a member's: the plain shell, from the assets, never
 *   cached, and tela-api is not asked (ADR 0035). Every other path is the SPA's
 *   static assets, which answer without running this Worker at all.
 * - A write to `/api/*` must come from this origin: cookies are `SameSite=Lax`, and this closes
 *   what Lax leaves open to a sibling subdomain.
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
  /** The SPA's built static assets (the `ASSETS` binding). */
  assets: { fetch(request: Request): Promise<Response> }
  /** Public pages: which URLs are one, and how to render one (`src/ssr.tsx`). */
  pages: PublicPages
  config: {
    /** The secret tela-api signs sessions with; the same value on both Workers. */
    authSecret: string
    /** While set, nothing is indexed (ADR 0015). */
    privateBeta: boolean
  }
}

type Waiter = { waitUntil(promise: Promise<unknown>): void }

/**
 * A public page: the tela-api endpoint its data comes from (null: it needs none, as About,
 * Privacy and Terms), and the key it is cached under when that is not the endpoint (a profile's
 * tabs, a page with no endpoint). `visitorsOnly`: a request with a session cookie gets the plain
 * shell. `alwaysExists`: a 404 from tela-api is not the page's answer either, so it is the plain
 * shell, uncached, like an outage.
 */
export type PublicPageRoute = {
  api: string | null
  key?: string
  visitorsOnly?: boolean
  alwaysExists?: boolean
}

export type PublicPages<R extends PublicPageRoute = PublicPageRoute> = {
  /** The page a URL names, or null. */
  route(url: URL): R | null
  /** The UI language to render in, from the locale cookie and Accept-Language. */
  locale(request: Request): string
  /** `data` null: the endpoint said there is no such page. */
  render(input: { route: R; url: URL; data: unknown; locale: string; template: string }): string
}

const OBJECT_KEY =
  /^(?:c\/[0-9a-f]{32}\.json|t\/[0-9a-f]{32}\/[A-Za-z-]{2,16}\/[0-9a-f]{8,64}\.json|tc\/[0-9a-f]{32}\/[A-Za-z-]{2,16}\/[A-Za-z0-9-]{1,64}\/\d{1,4}\.json)$/
const CONTENT_KEY = /^[0-9a-f]{32}$/
const BUNDLE_MAX = 25
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10_000
const IMAGE_UA = 'Tela/0.1 (+https://tela.ainaive.com; image proxy)'
/** `/avatar/<userId>?v=<n>` (ADR 0032): an account id as profiles name them, and a version. */
const MEMBER_ID = /^[A-Za-z0-9_-]{8,64}$/
const AVATAR_VERSION = /^\d{1,16}$/
const AVATAR_MAX_BYTES = 512 * 1024
const OBJECT_CACHE = 'private, max-age=31536000, immutable'
const IMAGE_CACHE = 'private, max-age=604800, immutable'
/** The cache's own namespace: keys are never a URL a reader can request directly. */
const CACHE_ORIGIN = 'https://tela-edge.cache'
/** A rendered public page, at the edge. The browser always asks again: the page is the shell too. */
const PAGE_EDGE_CACHE = 'public, s-maxage=300'
const PAGE_CACHE = 'public, max-age=0, must-revalidate'
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** Called by hubs and by the admin script, with their own authorization and no browser. */
const CROSS_ORIGIN_WRITERS = /^\/api\/(websub|admin)\//

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  })

export function createEdge(deps: EdgeDeps) {
  const { blobs, api, cache, config, assets, pages } = deps

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
    // The headers can arrive and the body still break off: a failure, answered and never kept.
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await readAtMost(upstream.body, IMAGE_MAX_BYTES)
    } catch {
      return text('upstream failed', 502)
    }
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

  /**
   * A member's picture (ADR 0032), from tela-api through this colo's cache. The address carries
   * the version, so nothing cached under it goes stale: tela-api's 30 days stand here and in the
   * browser, and its 404s for as long as it says. Public, like the profiles it appears on.
   */
  async function serveAvatar(request: Request, userId: string, version: string, waiter?: Waiter) {
    const cacheKey = new Request(`${CACHE_ORIGIN}/avatar/${userId}?v=${version}`)
    const hit = await cache.match(cacheKey)
    if (hit) return new Response(hit.body, hit)
    const res = await api.fetch(
      new Request(new URL(`/api/v1/public/avatars/${userId}?v=${version}`, request.url).toString()),
    )
    const failed = () => text('upstream failed', 502, { 'cache-control': 'no-store' })
    if ((res.status !== 200 && res.status !== 404) || !res.body) return failed()
    // A body that breaks off is a failure like any other: answered, and never cached.
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await readAtMost(res.body, AVATAR_MAX_BYTES)
    } catch {
      return failed()
    }
    if (!bytes) return failed()
    const headers = new Headers(res.headers)
    headers.set('x-robots-tag', 'noindex')
    const put = cache.put(cacheKey, new Response(bytes, { status: res.status, headers }))
    if (waiter) waiter.waitUntil(put)
    else await put
    return new Response(bytes, { status: res.status, headers })
  }

  async function servePublic(request: Request, waiter?: Waiter): Promise<Response> {
    const url = new URL(request.url)
    const route = request.method === 'GET' ? pages.route(url) : null
    // Not a public page after all (`/s/x/y`): the SPA's index.html, which says so itself.
    if (!route) return assets.fetch(request)
    if (!route.visitorsOnly) return renderPublic(request, url, route, waiter)
    // A member's `/` is the app, which takes them to their reading. Told by the cookie alone,
    // before the cache and without asking tela-api: a lapsed session gets the plain shell too,
    // whose app shows the front page once /me says so. Each copy is for one kind of request, so
    // the browser keys it by the cookie; the colo's copy needs no Vary (workerd ignores it), since
    // only a visitor's is ever stored.
    const cookie = request.headers.get('cookie') ?? ''
    let response: Response
    if (cookie.includes('tela.session_token')) {
      const app = await assets.fetch(request)
      response = new Response(app.body, app)
      response.headers.set('cache-control', PAGE_CACHE)
    } else {
      response = await renderPublic(request, url, route, waiter)
    }
    response.headers.append('vary', 'cookie')
    return response
  }

  async function renderPublic(
    request: Request,
    url: URL,
    route: PublicPageRoute,
    waiter?: Waiter,
  ): Promise<Response> {
    const shell = await assets.fetch(new Request(new URL('/', url).toString()))
    const template = await shell.text()
    const locale = pages.locale(request)
    // The deploy is part of the key: a page cached before it names scripts that are gone.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(template))
    const build = [...new Uint8Array(digest).slice(0, 6)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const cacheKey = new Request(
      `${CACHE_ORIGIN}/page/${build}/${locale}${route.key ?? route.api ?? url.pathname}`,
    )
    const hit = await cache.match(cacheKey)
    if (hit) {
      const cached = new Response(hit.body, hit)
      cached.headers.set('cache-control', PAGE_CACHE)
      return cached
    }
    // A page with no endpoint (About, Privacy, Terms) renders from the bundle alone.
    let data: unknown = {}
    if (route.api !== null) {
      const res = await api.fetch(new Request(new URL(route.api, url).toString()))
      // tela-api is down or slow, or (for a page that always exists) has no such endpoint yet: the
      // plain shell, uncached, which asks again from the browser. A cached 404 at `/` would be the
      // front page for five minutes.
      if (res.status !== 200 && (res.status !== 404 || route.alwaysExists)) {
        return new Response(template, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': PAGE_CACHE },
        })
      }
      data = res.status === 404 ? null : ((await res.json()) as unknown)
    }
    let html: string
    try {
      html = pages.render({ route, url, data, locale, template })
    } catch (err) {
      // An answer this build cannot render (a tela-api of another release beside it): the plain
      // shell, uncached, whose app asks again from the browser, rather than an error page. Logged,
      // since a page that always falls back is otherwise invisible.
      console.error('public page did not render', url.pathname, err)
      return new Response(template, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': PAGE_CACHE },
      })
    }
    const headers = { 'content-type': 'text/html; charset=utf-8', 'content-language': locale }
    const status = data === null ? 404 : 200
    const put = cache.put(
      cacheKey,
      new Response(html, { status, headers: { ...headers, 'cache-control': PAGE_EDGE_CACHE } }),
    )
    if (waiter) waiter.waitUntil(put)
    else await put
    return new Response(html, { status, headers: { ...headers, 'cache-control': PAGE_CACHE } })
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
        const foreign = request.headers.get('origin') !== url.origin
        response =
          WRITES.has(request.method) && foreign && !CROSS_ORIGIN_WRITERS.test(path)
            ? text('cross-origin write refused', 403)
            : await api.fetch(request)
      } else if (path === '/o/bundle') {
        response = await serveBundle(request, waiter)
      } else if (path.startsWith('/o/')) {
        response = await serveObject(request, decodeURIComponent(path.slice(3)), waiter)
      } else if (path.startsWith('/avatar/')) {
        const userId = path.slice('/avatar/'.length)
        const version = url.searchParams.get('v') ?? ''
        response =
          request.method === 'GET' && MEMBER_ID.test(userId) && AVATAR_VERSION.test(version)
            ? await serveAvatar(request, userId, version, waiter)
            : text('not found', 404)
      } else if (path.startsWith('/img/')) {
        const [, , key = '', index = ''] = path.split('/')
        const i = Number(index)
        response =
          CONTENT_KEY.test(key) && Number.isInteger(i) && i >= 0 && i < 1000
            ? await serveImage(request, key, i, waiter)
            : text('not found', 404)
      } else {
        // `run_worker_first` sends only the public pages here besides the above.
        response = await servePublic(request, waiter)
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
): Promise<Uint8Array<ArrayBuffer> | null> {
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
