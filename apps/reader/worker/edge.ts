/**
 * tela-web's Worker (ADR 0020, 0024): the one public Worker, running at the reader's edge,
 * unpinned. It never queries D1.
 *
 * - `/api/*` goes to tela-api, pinned beside D1, over a service binding, every time. The public
 *   pages rendered here read tela-api's public JSON through a copy per colo instead (`pageJson`),
 *   so a page's four languages cost one D1 read.
 * - `/o/*` serves immutable content, translation and chunk objects from R2 to members, cached per
 *   colo; `/o/bundle` serves up to 25 content objects in one response, and lists those refused.
 * - `/img/<contentKey>/<index>` proxies the image a content object names (ADR 0007's rules),
 *   replacing the HMAC-signed `/img?u=` of the Postgres app: the object is the allowlist.
 * - Both are `@tela/edge`'s, shared with tela-gateway, and each is decided before it is served
 *   (ADR 0066): after the session check, tela-api says whether the member may open the post today
 *   (`/api/edge/opens`), and the colo keeps each post it allowed for that member until the UTC
 *   day ends, so its translations and images ask nothing more.
 * - `/avatar/<userId>?v=` is a member's picture (ADR 0032), from tela-api, cached per colo.
 * - Sessions are read from better-auth's signed five-minute cookie cache with the shared secret.
 *   Only when that has lapsed does it ask tela-api, and passes on the refreshed cookie.
 * - `/` (for visitors), Discover's tabs (`/discover`, `/discover/articles`, `/discover/blogs`,
 *   `/discover/readers`), `/s/:id` and `/@handle` are rendered here from tela-api's public JSON,
 *   poured into the SPA's index.html and cached per colo, locale and deploy for five minutes, a
 *   page whose `?hl=` fixed its language apart from one in the same language that it did not
 *   (ADR 0060: their canonical addresses differ);
 *   `/about`, `/privacy` and `/terms` the same way, from the bundle alone. An address from before
 *   Discover's tabs (`/discover?topic=…`) is a permanent redirect, answered here. A request to
 *   `/` that carries a session cookie is a member's: the plain shell, from the assets, never
 *   cached, and tela-api is not asked (ADR 0035). Every other path is the SPA's
 *   static assets, which answer without running this Worker at all.
 * - `/l/<id>.rss`, `/l/<id>.opml`, `/discover/articles.rss` and `/discover.opml` are Tela's own
 *   feeds (ADR 0062), rendered here from tela-api's public JSON through the same copy per colo,
 *   in the language `?hl=` pins.
 * - A write to `/api/*` must come from this origin: cookies are `SameSite=Lax`, and this closes
 *   what Lax leaves open to a sibling subdomain.
 *
 * Portable: built from interfaces, so the bun suite runs it with memory blobs and a fake cache.
 */
import {
  type Authorization,
  CACHE_ORIGIN,
  createContent,
  createMarks,
  type EdgeCache,
  nextUtcMidnight,
  readAtMost,
  safeDecode,
  sha256Hex,
  utcDay,
  type Waiter,
} from '@tela/edge'
import type { Blobs } from '@tela/platform'
import { hlLocale, type OpensDecision } from '@tela/shared'
import { getCookieCache } from 'better-auth/cookies'
import { type FeedRoute, feedRoute } from '../src/lib/feed-href'
import { renderFeed } from './feeds'
import { llmsTxt } from './llms'
import { robotsTxt } from './robots'
import { withSecurityHeaders } from './security'
import {
  kindPages,
  ownPages,
  type SitemapItems,
  type SitemapSummary,
  sitemapIndex,
  sitemapOf,
  sitemapPage,
  urlset,
} from './sitemap'

export type { EdgeCache } from '@tela/edge'

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
  /** The clock a cached copy's age is told by; `Date.now` unless a test says. */
  now?: () => number
  config: {
    /** The secret tela-api signs sessions with; the same value on both Workers. */
    authSecret: string
    /** While set, nothing is indexed (ADRs 0015, 0060): `TELA_NOINDEX`. */
    noindex: boolean
    /** How long a public page waits on tela-api for its data; `PAGE_DEADLINE_MS` unless a test says. */
    pageDeadlineMs?: number
  }
}

/**
 * A public page: the tela-api endpoint its data comes from (null: it needs none, as About,
 * Privacy and Terms), and the key it is cached under when that is not the endpoint (a profile's
 * tabs, a page with no endpoint). `visitorsOnly`: a request with a session cookie gets the plain
 * shell. `alwaysExists`: a 404 from tela-api is not the page's answer either, so it is the plain
 * shell, uncached, like an outage. `redirect`: the page has moved there for good, and nobody is
 * asked anything.
 */
export type PublicPageRoute = {
  api: string | null
  key?: string
  visitorsOnly?: boolean
  alwaysExists?: boolean
  redirect?: string
}

export type PublicPages<R extends PublicPageRoute = PublicPageRoute> = {
  /** The page a URL names, or null. */
  route(url: URL): R | null
  /**
   * The UI language to render in: a visitor's `?hl=`, then the locale cookie, then
   * Accept-Language; a member's cookie, whatever the address says (ADR 0060).
   */
  locale(request: Request): string
  /** `data` null: the endpoint said there is no such page. */
  render(input: { route: R; url: URL; data: unknown; locale: string; template: string }): string
}

/** `/avatar/<userId>?v=<n>` (ADR 0032): an account id as profiles name them, and a version. */
const MEMBER_ID = /^[A-Za-z0-9_-]{8,64}$/
const AVATAR_VERSION = /^\d{1,16}$/
const AVATAR_MAX_BYTES = 512 * 1024
/** A page that moved (an address from before Discover's tabs): kept a day, by whoever keeps it. */
const MOVED_CACHE = 'public, max-age=86400'
/** A rendered public page, at the edge. The browser always asks again: the page is the shell too. */
const PAGE_EDGE_SECONDS = 300
const PAGE_CACHE = 'public, max-age=0, must-revalidate'
/**
 * How long a public page waits on tela-api before it is the plain shell instead, which asks again
 * from the browser. `/` is the page most visitors open, and a cold colo asks D1 in Singapore for
 * it: a slow D1 must not keep the front page blank.
 */
const PAGE_DEADLINE_MS = 3_000
/**
 * When a public page's data did not come, how soon a crawler should ask again (ADR 0060). The
 * fallback is the plain shell, whose own head says `noindex`: a crawler handed it as a 200 drops
 * the page, while a 503 with `Retry-After` says only "not now".
 */
const PAGE_RETRY_AFTER_SECONDS = 120
/** When the colo's copy of a public answer was made, so a hit can say its `age`. Never sent on. */
const STORED_AT = 'x-tela-stored-at'
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** A sitemap, in the browser or a crawler: as long as tela-api keeps the list it is made from. */
const SITEMAP_CACHE = 'public, max-age=3600'
/** A rendered page's own robots rule (ADR 0060), which its answer repeats as X-Robots-Tag. */
const ROBOTS_META = /<meta name="robots" content="([^"]+)"/
/**
 * A feed, in the browser or feed reader: a minute, then a conditional GET, which its ETag answers
 * 304 while the colo's copy has not changed. The copy itself lives as tela-api says, so a blogroll
 * made private stops being served within minutes, as its page does.
 */
const FEED_CACHE = 'public, max-age=60'

/** A public answer the colo may keep for everyone: one tela-api says a shared cache may. */
function keepsAtTheColo(res: Response): boolean {
  if (res.status !== 200 && res.status !== 404) return false
  if (res.headers.has('set-cookie')) return false
  const control = (res.headers.get('cache-control') ?? '').toLowerCase()
  return /\bs-maxage=\d+/.test(control) && !/\b(no-store|private|no-cache)\b/.test(control)
}
/** Called by hubs and by the admin script, with their own authorization and no browser. */
const CROSS_ORIGIN_WRITERS = /^\/api\/(websub|admin)\//
/** tela-api's routes for this Worker alone (ADR 0066): never forwarded from a browser. */
const EDGE_ONLY = '/api/edge/'

/**
 * Whether a path is one of tela-api's routes for this Worker alone, however a browser spelled it.
 * tela-api's router decodes each run of escapes in a path before it matches (Hono's
 * `tryDecodeURI`), so `/api/%65dge/opens` is `/api/edge/opens` there: the path is read here as it
 * will be read there, each run decoded where it decodes and left as it is where it does not, and
 * `%2F` decoded too, which only refuses more.
 */
function edgeOnly(path: string): boolean {
  const decoded = path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => safeDecode(run) ?? run)
  return decoded.startsWith(EDGE_ONLY)
}
/** How soon to ask again when tela-api could not decide what a member may open. */
const DECISION_RETRY_SECONDS = 30

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  })

export function createEdge(deps: EdgeDeps) {
  const { blobs, api, cache, config, assets, pages } = deps
  const now = deps.now ?? Date.now
  /** `/llms.txt`, made once per origin: it changes only with a deploy. */
  const llms = new Map<string, string>()

  /**
   * A member's session: from the signed cookie cache, else from tela-api (one D1 read), whose
   * renewed cookies the answer passes on.
   */
  async function session(
    request: Request,
  ): Promise<{ userId: string; setCookies: string[] } | null> {
    const secure = new URL(request.url).protocol === 'https:'
    const cached = await getCookieCache(request, {
      secret: config.authSecret,
      cookiePrefix: 'tela',
      isSecure: secure,
    }).catch(() => null)
    if (cached?.user?.id) return { userId: cached.user.id, setCookies: [] }
    const cookie = request.headers.get('cookie') ?? ''
    if (!cookie.includes('tela.session_token')) return null
    const res = await api.fetch(
      new Request(new URL('/api/auth/get-session', request.url).toString(), {
        headers: { cookie },
      }),
    )
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as {
      session?: unknown
      user?: { id?: unknown }
    } | null
    const userId = body?.user?.id
    return body?.session && typeof userId === 'string'
      ? { userId, setCookies: res.headers.getSetCookie() }
      : null
  }

  /** Posts a member may open today, kept per colo by their hashed id until the UTC day ends. */
  const opens = createMarks(cache, now)

  /**
   * Whether the session's member may have these posts (ADR 0066): those this colo already saw
   * allowed today ask nothing; the rest are decided by tela-api, with the member's cookie and
   * nothing else, and each it allows is kept until the day ends. A refusal is never kept, so a
   * post becomes readable the moment the member subscribes. A member's id never goes into a cache
   * key as it is.
   */
  async function authorize(
    request: Request,
    keys: string[],
    waiter?: Waiter,
  ): Promise<Authorization> {
    const member = await session(request)
    if (!member) return { ok: false, response: text('sign in first', 401) }
    const { setCookies } = member
    const at = now()
    const subject = `opens/${await sha256Hex(member.userId)}/${utcDay(at)}`
    const known = await Promise.all(keys.map((k) => opens.has(`${subject}/${k}`)))
    const allowed = keys.filter((_, i) => known[i])
    const unknown = keys.filter((_, i) => !known[i])
    if (unknown.length === 0) return { ok: true, decision: { allowed, refused: {} }, setCookies }
    const unavailable = (): Authorization => ({
      ok: false,
      response: new Response('{"error":"unavailable"}', {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'retry-after': String(DECISION_RETRY_SECONDS),
        },
      }),
    })
    let res: Response
    try {
      res = await api.fetch(
        new Request(new URL('/api/edge/opens', request.url).toString(), {
          method: 'POST',
          headers: {
            cookie: request.headers.get('cookie') ?? '',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ keys: unknown }),
        }),
      )
    } catch (err) {
      console.error('opens decision failed', err)
      return unavailable()
    }
    // The cookie cache outlived the session (a closing, a suspension): signed out, as the pull is.
    if (res.status === 401) return { ok: false, response: text('sign in first', 401) }
    const decision = res.ok ? decisionOf(await res.json().catch(() => null)) : null
    if (!decision) {
      console.error('opens decision unavailable', res.status)
      return unavailable()
    }
    const until = nextUtcMidnight(at)
    const fresh = decision.allowed.filter((k) => unknown.includes(k))
    await Promise.all(fresh.map((k) => opens.set(`${subject}/${k}`, until, waiter)))
    return {
      ok: true,
      decision: { allowed: [...allowed, ...fresh], refused: decision.refused },
      setCookies,
    }
  }

  const content = createContent({ blobs, cache, fetch: deps.fetchImage, authorize, now })

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

  /**
   * tela-api's public JSON (`/api/v1/public/*`) for a page rendered here, through a copy per colo:
   * a blog, a profile or Discover rendered in four languages asks D1 in Singapore once a colo for
   * as long as tela-api says (`s-maxage`), since the answers carry every language and read no
   * cookie. Only a 200 or 404 that sets no cookie and says `s-maxage`, and none of `no-store`,
   * `private` or `no-cache`, is kept. A copy says its `age`, so the page made from it is kept only
   * for what the copy had left.
   *
   * The app's own requests never come here: they go to tela-api each time. Serving them from this
   * copy kept a change from the member who made it (a claim, a hide, a follow) for up to five
   * minutes, since nothing they did could tell every list it touched to ask again.
   */
  async function pageJson(url: URL, waiter?: Waiter): Promise<Response> {
    const cacheKey = new Request(`${CACHE_ORIGIN}${url.pathname}${url.search}`)
    const hit = await cache.match(cacheKey)
    if (hit) {
      const response = new Response(hit.body, hit)
      const at = Number(response.headers.get(STORED_AT))
      response.headers.delete(STORED_AT)
      if (Number.isFinite(at) && at > 0) {
        response.headers.set('age', String(Math.max(0, Math.floor((now() - at) / 1000))))
      }
      return response
    }
    const res = await api.fetch(new Request(url.toString()))
    if (!keepsAtTheColo(res)) return res
    const body = await res.arrayBuffer()
    const kept = new Response(body, res)
    kept.headers.set(STORED_AT, String(now()))
    const put = cache.put(cacheKey, kept)
    if (waiter) waiter.waitUntil(put)
    else await put
    return new Response(body, res)
  }

  /**
   * A sitemap (ADR 0060): Tela's own pages from the bundle, the rest from tela-api's list through
   * the colo's copy, which tela-api keeps an hour. No list from tela-api is a 503 a crawler asks
   * again after, never an empty sitemap, which would say every page it named is gone.
   */
  async function serveSitemap(
    request: Request,
    url: URL,
    sitemap: NonNullable<ReturnType<typeof sitemapOf>>,
    waiter?: Waiter,
  ): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('not allowed', 405)
    const xml = (body: string) =>
      new Response(body, {
        headers: {
          'content-type': 'application/xml; charset=utf-8',
          'cache-control': SITEMAP_CACHE,
          // A sitemap is read, not shown in results.
          'x-robots-tag': 'noindex',
        },
      })
    if (sitemap === 'pages') return xml(urlset(url.origin, ownPages()))
    const page = sitemap === 'index' ? 1 : sitemapPage(url.searchParams.get('page'))
    if (page === null) return text('not found', 404)
    const path =
      sitemap === 'index'
        ? '/api/v1/public/sitemap'
        : `/api/v1/public/sitemap/${sitemap}?page=${page}`
    const unavailable = () =>
      text('sitemap unavailable', 503, { 'retry-after': '3600', 'cache-control': 'no-store' })
    try {
      const res = await pageJson(new URL(path, url), waiter)
      if (res.status === 404) return text('not found', 404)
      if (res.status !== 200) return unavailable()
      const data = (await res.json()) as SitemapSummary & SitemapItems
      return xml(
        sitemap === 'index'
          ? sitemapIndex(url.origin, data)
          : urlset(url.origin, kindPages(sitemap, data)),
      )
    } catch (err) {
      console.error('sitemap failed', path, err)
      return unavailable()
    }
  }

  /**
   * One of Tela's own feeds (ADR 0062): its data through the colo's copy, as a page's, rendered in
   * the language its `?hl=` pins. A feed of nothing others can see is a 404, kept a minute; one
   * whose data could not be had or read is a 503, kept nowhere, which a feed reader tries again.
   * The same bytes keep the same ETag, so a reader polling it is answered 304.
   */
  async function serveFeed(request: Request, route: FeedRoute, waiter?: Waiter) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('method not allowed', 405, { allow: 'GET, HEAD' })
    }
    const missing = () =>
      text('not found', 404, { 'cache-control': 'public, max-age=60', 'x-robots-tag': 'noindex' })
    const unavailable = () =>
      text('unavailable', 503, { 'cache-control': 'no-store', 'retry-after': '60' })
    if (route.kind === 'missing') return missing()
    const url = new URL(request.url)
    let feed: ReturnType<typeof renderFeed>
    try {
      const res = await pageJson(new URL(route.api, url), waiter)
      if (res.status === 404) return missing()
      if (res.status !== 200) return unavailable()
      feed = renderFeed(route, await res.json(), url.origin)
    } catch (err) {
      console.error('feed failed', url.pathname, err)
      return unavailable()
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(feed.body))
    const etag = `"${[...new Uint8Array(digest).slice(0, 12)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}"`
    const headers: Record<string, string> = {
      'content-type': feed.type,
      'cache-control': FEED_CACHE,
      etag,
      // A feed is not a page to list in a search: the page it is of is.
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
      ...(feed.filename ? { 'content-disposition': `inline; filename="${feed.filename}"` } : {}),
    }
    const asked = request.headers.get('if-none-match') ?? ''
    if (asked.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
      return new Response(null, { status: 304, headers })
    }
    return new Response(request.method === 'HEAD' ? null : feed.body, { headers })
  }

  async function servePublic(request: Request, waiter?: Waiter): Promise<Response> {
    const url = new URL(request.url)
    const read = request.method === 'GET' || request.method === 'HEAD'
    const route = read ? pages.route(url) : null
    // Moved: the same answer for a member and a visitor, so nothing about either is asked; and
    // for HEAD too, which is how link checkers and `curl -I` ask where a page went.
    if (route?.redirect !== undefined) {
      return new Response(null, {
        status: 301,
        headers: { location: route.redirect, 'cache-control': MOVED_CACHE },
      })
    }
    // Not a public page after all (`/s/x/y`), or not a GET: the SPA's index.html, which says so
    // itself.
    if (!route || request.method !== 'GET') return assets.fetch(request)
    if (!route.visitorsOnly) return renderPublic(request, url, route, waiter)
    // A member's `/` is the app, which takes them to their reading. Told by the cookie alone,
    // before the cache and without asking tela-api: a lapsed session gets the plain shell too,
    // whose app shows the front page once /me says so. Each copy is for one kind of request, so
    // the browser keys it by the cookie (a visitor's page says so itself); the colo's copy needs
    // no Vary (workerd ignores it), since only a visitor's is ever stored.
    const cookie = request.headers.get('cookie') ?? ''
    if (!cookie.includes('tela.session_token')) return renderPublic(request, url, route, waiter)
    const app = await assets.fetch(request)
    const response = new Response(app.body, app)
    response.headers.set('cache-control', PAGE_CACHE)
    response.headers.set('vary', 'cookie')
    return response
  }

  /**
   * A public page's data from tela-api, within the deadline: `{data}`, null in it when tela-api
   * says there is no such page; or null for the plain shell, when it answers anything else, throws,
   * or takes too long (`alwaysExists`: a 404 too). The body is read inside the deadline as well.
   */
  async function pageData(
    path: string,
    url: URL,
    alwaysExists: boolean,
    waiter?: Waiter,
  ): Promise<{ data: unknown; age: number } | null> {
    const ask = async () => {
      // Through the colo's copy: the page's four languages share one D1 read.
      const res = await pageJson(new URL(path, url), waiter)
      const age = Number(res.headers.get('age') ?? '0') || 0
      if (res.status === 404 && !alwaysExists) return { data: null, age }
      if (res.status !== 200) return null
      return { data: (await res.json()) as unknown, age }
    }
    const deadline = config.pageDeadlineMs ?? PAGE_DEADLINE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), deadline)
    })
    try {
      const answer = await Promise.race([ask(), late])
      if (answer !== 'late') return answer
      console.error('public page data late', path, `${deadline}ms`)
      return null
    } catch (err) {
      console.error('public page data failed', path, err)
      return null
    } finally {
      clearTimeout(timer)
    }
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
    // The address fixes the language (`?hl=`) and the page is in it: a page of its own, whose
    // canonical link names it (ADR 0060). A member's page is pinned only when the language named
    // is their own, and is then the same page a visitor gets.
    const pinned = hlLocale(url.searchParams.get('hl')) === locale
    // An unpinned page's language comes from the cookie or Accept-Language, a pinned one's from
    // the address unless a session cookie overrides it: what the browser must key its copy by.
    // The colo's copy carries none (workerd ignores Vary and refuses `*`): its key says it all.
    const vary = pinned ? 'cookie' : 'cookie, accept-language'
    // The deploy is part of the key: a page cached before it names scripts that are gone.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(template))
    const build = [...new Uint8Array(digest).slice(0, 6)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const cacheKey = new Request(
      `${CACHE_ORIGIN}/page/${build}/${locale}${pinned ? '.hl' : ''}${route.key ?? route.api ?? url.pathname}`,
    )
    const hit = await cache.match(cacheKey)
    if (hit) {
      const cached = new Response(hit.body, hit)
      cached.headers.set('cache-control', PAGE_CACHE)
      cached.headers.set('vary', vary)
      return cached
    }
    // A page with no endpoint (About, Privacy, Terms) renders from the bundle alone.
    let data: unknown = {}
    // How old the data already is: the page is kept only as long as its data had left, so a page
    // made from the colo's four-minute-old copy is not kept five minutes more.
    let age = 0
    // The page could not be made: the plain shell, which boots the app and asks again from the
    // browser, as a 503 kept by nobody. Its head says `noindex` (it is the app's), so as a 200 a
    // crawler that came at that moment would drop the page; a 503 with `Retry-After` is "not now".
    const unavailable = () =>
      new Response(template, {
        status: 503,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': String(PAGE_RETRY_AFTER_SECONDS),
          vary,
        },
      })
    if (route.api !== null) {
      const answer = await pageData(route.api, url, route.alwaysExists === true, waiter)
      // tela-api is down, slow or failing, or (for a page that always exists) has no such endpoint
      // yet. A cached 404 at `/` would be the front page for five minutes.
      if (!answer) return unavailable()
      data = answer.data
      age = answer.age
    }
    let html: string
    try {
      html = pages.render({ route, url, data, locale, template })
    } catch (err) {
      // An answer this build cannot render (a tela-api of another release beside it): the plain
      // shell, whose app asks again from the browser, rather than an error page. Logged, since a
      // page that always falls back is otherwise invisible.
      console.error('public page did not render', url.pathname, err)
      return unavailable()
    }
    // A page that is not to be indexed (a 404, a blog nobody vouched for) says so in its head,
    // and in a header for whatever reads no HTML; kept with the colo's copy.
    const robots = html.match(ROBOTS_META)?.[1]
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'content-language': locale,
      ...(robots ? { 'x-robots-tag': robots } : {}),
    }
    const status = data === null ? 404 : 200
    const keep = PAGE_EDGE_SECONDS - age
    if (keep > 0) {
      const put = cache.put(
        cacheKey,
        new Response(html, {
          status,
          headers: { ...headers, 'cache-control': `public, s-maxage=${keep}` },
        }),
      )
      if (waiter) waiter.waitUntil(put)
      else await put
    }
    return new Response(html, {
      status,
      headers: { ...headers, 'cache-control': PAGE_CACHE, vary },
    })
  }

  return {
    async fetch(request: Request, waiter?: Waiter): Promise<Response> {
      const url = new URL(request.url)
      const path = url.pathname
      const sitemap = sitemapOf(path)
      if (path === '/robots.txt') {
        return text(robotsTxt({ origin: url.origin, noindex: config.noindex }), 200, {
          'cache-control': 'public, max-age=3600',
        })
      }
      let response: Response
      if (path === '/llms.txt') {
        let body = llms.get(url.origin)
        if (body === undefined) {
          body = llmsTxt(url.origin)
          llms.set(url.origin, body)
        }
        response = text(body, 200, { 'cache-control': 'public, max-age=3600' })
      } else if (edgeOnly(path)) {
        response = text('not found', 404)
      } else if (path.startsWith('/api/')) {
        const foreign = request.headers.get('origin') !== url.origin
        response =
          WRITES.has(request.method) && foreign && !CROSS_ORIGIN_WRITERS.test(path)
            ? text('cross-origin write refused', 403)
            : await api.fetch(request)
      } else if (path === '/o/bundle') {
        const keys = (url.searchParams.get('k') ?? '').split(',')
        response = await content.serveBundle(request, keys, waiter)
      } else if (path.startsWith('/o/') || path.startsWith('/img/')) {
        response = (await content.serve(request, waiter)) ?? text('not found', 404)
      } else if (path.startsWith('/avatar/')) {
        const userId = path.slice('/avatar/'.length)
        const version = url.searchParams.get('v') ?? ''
        response =
          request.method === 'GET' && MEMBER_ID.test(userId) && AVATAR_VERSION.test(version)
            ? await serveAvatar(request, userId, version, waiter)
            : text('not found', 404)
      } else if (sitemap) {
        response = await serveSitemap(request, url, sitemap, waiter)
      } else {
        // `run_worker_first` sends only the public pages and feeds here besides the above.
        const feed = feedRoute(url)
        response = feed
          ? await serveFeed(request, feed, waiter)
          : await servePublic(request, waiter)
      }
      // Nothing is indexed while TELA_NOINDEX is set; and the API never is, whatever it answers
      // (ADR 0060): JSON a search engine found through a page is no page of its own.
      const robots = config.noindex
        ? 'noindex, nofollow'
        : path.startsWith('/api/')
          ? 'noindex'
          : null
      if (robots && !response.headers.has('x-robots-tag')) {
        response = new Response(response.body, response)
        response.headers.set('x-robots-tag', robots)
      }
      // Every page this Worker answers, rendered, cached, the plain shell or a member's `/`,
      // carries what `_headers` gives the pages it never sees (ADR 0051).
      if ((response.headers.get('content-type') ?? '').includes('text/html')) {
        response = withSecurityHeaders(response)
      }
      return response
    },
  }
}

/** tela-api's decision as it answered it, or null when it is not one. */
function decisionOf(body: unknown): OpensDecision | null {
  const d = body as Partial<OpensDecision> | null
  if (!d || !Array.isArray(d.allowed) || typeof d.refused !== 'object' || d.refused === null) {
    return null
  }
  return { allowed: d.allowed.filter((k) => typeof k === 'string'), refused: d.refused }
}
