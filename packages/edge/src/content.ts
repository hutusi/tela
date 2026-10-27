/**
 * Content at the edge (ADRs 0065, 0066), as tela-web and tela-gateway both serve it: the immutable
 * content, translation and chunk objects from R2 through the colo's cache, a bundle of content
 * objects, and the image proxy (`/img/<contentKey>/<index>`, ADR 0007's rules: the object is the
 * allowlist).
 *
 * Every answer is decided first. `authorize` asks tela-api, through whatever the edge holds (a
 * session cookie, an app's token), whether the member may have these content keys today; an object
 * or an image is served, from the colo or from R2, only for a key it allowed. A translation or an
 * image is decided by the content key of the post it belongs to, so it costs no place of its own.
 *
 * Portable: built from interfaces, so the bun suite runs it with memory blobs and a map for a cache.
 */
import { isBlockedHost } from '@tela/ingest/net'
import type { Blobs } from '@tela/platform'
import type { OpensDecision, OpensRefusal } from '@tela/shared'
import { CACHE_ORIGIN, type EdgeCache, readAtMost, safeDecode, settle, type Waiter } from './marks'

/** What an edge's `authorize` answers: the decision, or the answer to give instead (a 401, a 503). */
export type Authorization =
  | {
      ok: true
      decision: OpensDecision
      /** A session the check renewed (tela-web): its cookies go on the answer. */
      setCookies?: string[]
    }
  | { ok: false; response: Response }

/** Whether the member (or the app acting for them) may have these content keys now. */
export type Authorize = (
  request: Request,
  keys: string[],
  waiter?: Waiter,
) => Promise<Authorization>

export type ContentDeps = {
  blobs: Blobs
  /** The colo's cache (`caches.default` on Cloudflare). */
  cache: EdgeCache
  /** Outbound fetch for the image proxy. */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  authorize: Authorize
  /** The clock a refusal's `Retry-After` is told by; `Date.now` unless a test says. */
  now?: () => number
}

const OBJECT_KEY =
  /^(?:c\/[0-9a-f]{32}\.json|t\/[0-9a-f]{32}\/[A-Za-z-]{2,16}\/[0-9a-f]{8,64}\.json|tc\/[0-9a-f]{32}\/[A-Za-z-]{2,16}\/[A-Za-z0-9-]{1,64}\/\d{1,4}\.json)$/
export const CONTENT_KEY = /^[0-9a-f]{32}$/
/** The most content objects one bundle carries, and one decision names (`OPENS_KEYS_MAX`). */
export const BUNDLE_MAX = 25
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10_000
const IMAGE_UA = 'Tela/0.1 (+https://telaread.com; image proxy)'
export const OBJECT_CACHE = 'private, max-age=31536000, immutable'
const IMAGE_CACHE = 'private, max-age=604800, immutable'
const IMAGE_EDGE_CACHE = 'public, max-age=604800, immutable'
/** An image that could not be had, asked for again after ten minutes. */
const IMAGE_FAILURE_CACHE = 'private, max-age=600'
const IMAGE_FAILURE_EDGE_CACHE = 'public, max-age=600'

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  })

const json = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'application/json', 'x-robots-tag': 'noindex', ...headers },
  })

const notFound = () => json('{"error":"not_found"}', 404, { 'cache-control': 'no-store' })

/** The content key an object belongs to: its post's, for a translation and its chunks too. */
export const contentKeyOf = (objectKey: string): string | null =>
  /^(?:c|t|tc)\/([0-9a-f]{32})[./]/.exec(objectKey)?.[1] ?? null

/**
 * The answer for a key refused for the day's limit (ADR 0066): 429, told when to ask again, and
 * kept by nobody, since the same address answers the object once the day starts over.
 */
export function refusal(refused: OpensRefusal, now: number): Response {
  const seconds = Math.max(1, Math.ceil((refused.resetsAt - now) / 1000))
  return json(JSON.stringify(refused), 429, {
    'retry-after': String(seconds),
    'cache-control': 'no-store',
  })
}

function withCookies(response: Response, setCookies: string[] | undefined): Response {
  for (const c of setCookies ?? []) response.headers.append('set-cookie', c)
  return response
}

export function createContent(deps: ContentDeps) {
  const { blobs, cache, authorize } = deps
  const now = deps.now ?? Date.now

  /** An R2 object, through the colo's cache, undecided: objects never change, so a hit is right. */
  async function object(key: string, waiter?: Waiter): Promise<string | null> {
    const cacheKey = new Request(`${CACHE_ORIGIN}/o/${key}`)
    const hit = await cache.match(cacheKey)
    if (hit) return hit.text()
    const stored = await blobs.get(key)
    if (!stored) return null
    const body = await stored.text()
    const kept = new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000' },
    })
    await settle(cache.put(cacheKey, kept), waiter)
    return body
  }

  /** The decision for one key: null to go on, or the answer to give instead. */
  function judged(authorization: Authorization, key: string): Response | null {
    if (!authorization.ok) return authorization.response
    const refused = authorization.decision.refused[key]
    if (refused) return withCookies(refusal(refused, now()), authorization.setCookies)
    if (!authorization.decision.allowed.includes(key)) {
      // A decision that names the key neither way: nothing is served on it.
      return withCookies(json('{"error":"forbidden"}', 403), authorization.setCookies)
    }
    return null
  }

  /** `/o/<key>`: a content, translation or chunk object, as it is stored. */
  async function serveObject(request: Request, key: string, waiter?: Waiter): Promise<Response> {
    const contentKey = OBJECT_KEY.test(key) ? contentKeyOf(key) : null
    if (!contentKey) return notFound()
    const authorization = await authorize(request, [contentKey], waiter)
    const instead = judged(authorization, contentKey)
    if (instead || !authorization.ok) return instead ?? notFound()
    const body = await object(key, waiter)
    if (body === null) return withCookies(notFound(), authorization.setCookies)
    return withCookies(json(body, 200, { 'cache-control': OBJECT_CACHE }), authorization.setCookies)
  }

  /**
   * Content objects for up to `BUNDLE_MAX` keys in one answer, decided together:
   * `{ "objects": { key: object }, "refused": { key: refusal } }`. A key allowed whose object does
   * not exist is in neither. A bundle that refused nothing is the same for good, and kept so; one
   * that refused a key is not kept at all, since the same keys answer more once the day starts
   * over.
   */
  async function serveBundle(request: Request, keys: string[], waiter?: Waiter): Promise<Response> {
    const asked = [...new Set(keys)].filter((k) => CONTENT_KEY.test(k)).slice(0, BUNDLE_MAX)
    const authorization = await authorize(request, asked, waiter)
    if (!authorization.ok) return authorization.response
    const allowed = new Set(authorization.decision.allowed)
    const refused: Record<string, OpensRefusal> = {}
    for (const k of asked) {
      const r = authorization.decision.refused[k]
      if (r) refused[k] = r
    }
    const parts = await Promise.all(
      asked
        .filter((k) => allowed.has(k) && !refused[k])
        .map(async (k) => {
          const body = await object(`c/${k}.json`, waiter)
          return body === null ? null : `${JSON.stringify(k)}:${body}`
        }),
    )
    const anyRefused = Object.keys(refused).length > 0
    return withCookies(
      json(
        `{"objects":{${parts.filter((p) => p !== null).join(',')}},"refused":${JSON.stringify(refused)}}`,
        200,
        { 'cache-control': anyRefused ? 'no-store' : OBJECT_CACHE },
      ),
      authorization.setCookies,
    )
  }

  /** The image an object names, fetched and checked; or why not, as the status and text to say. */
  async function fetchImage(
    contentKey: string,
    index: number,
    waiter?: Waiter,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | { status: number; why: string }> {
    const stored = await object(`c/${contentKey}.json`, waiter)
    if (stored === null) return { status: 404, why: 'not found' }
    const source = (JSON.parse(stored) as { images?: string[] }).images?.[index]
    if (!source) return { status: 404, why: 'not found' }
    let url: URL
    try {
      url = new URL(source)
    } catch {
      return { status: 404, why: 'not found' }
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || isBlockedHost(url.hostname)) {
      return { status: 403, why: 'forbidden' }
    }
    const failed = { status: 502, why: 'upstream failed' }
    let upstream: Response
    try {
      upstream = await deps.fetch(url.toString(), {
        headers: { 'user-agent': IMAGE_UA, accept: 'image/*' },
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        redirect: 'follow',
      })
    } catch {
      return failed
    }
    if (!upstream.ok || !upstream.body) return failed
    const type =
      (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    // SVG can carry script; only raster types a browser renders in an <img>.
    if (!type.startsWith('image/') || type === 'image/svg+xml') {
      return { status: 415, why: 'not an image' }
    }
    const declared = Number(upstream.headers.get('content-length') ?? '0')
    if (declared > IMAGE_MAX_BYTES) return { status: 413, why: 'too large' }
    // The headers can arrive and the body still break off: a failure, never kept as an image.
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await readAtMost(upstream.body, IMAGE_MAX_BYTES)
    } catch {
      return failed
    }
    if (!bytes) return { status: 413, why: 'too large' }
    return { bytes, type }
  }

  /**
   * An image through the colo's cache, failures included: a broken image on a post is asked for
   * on every view of it, by every reader, and each ask could wait out the ten-second upstream
   * timeout and press a host that is already failing. A failure is kept ten minutes, at the colo
   * and in the browser, and then asked again. Decided by its post's key before the colo is read.
   */
  async function serveImage(
    request: Request,
    contentKey: string,
    index: number,
    waiter?: Waiter,
  ): Promise<Response> {
    const authorization = await authorize(request, [contentKey], waiter)
    const instead = judged(authorization, contentKey)
    if (instead || !authorization.ok) return instead ?? notFound()
    const cacheKey = new Request(`${CACHE_ORIGIN}/img/${contentKey}/${index}`)
    const hit = await cache.match(cacheKey)
    if (hit) {
      const response = new Response(hit.body, hit)
      response.headers.set('cache-control', hit.ok ? IMAGE_CACHE : IMAGE_FAILURE_CACHE)
      return withCookies(response, authorization.setCookies)
    }
    const image = await fetchImage(contentKey, index, waiter)
    // The colo's copy says public: Cloudflare's cache does not keep a response marked private.
    let kept: Response
    let answer: Response
    if ('bytes' in image) {
      const headers = {
        'content-type': image.type,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'x-robots-tag': 'noindex',
      }
      kept = new Response(image.bytes, {
        headers: { ...headers, 'cache-control': IMAGE_EDGE_CACHE },
      })
      answer = new Response(image.bytes, { headers: { ...headers, 'cache-control': IMAGE_CACHE } })
    } else {
      kept = text(image.why, image.status, { 'cache-control': IMAGE_FAILURE_EDGE_CACHE })
      answer = text(image.why, image.status, { 'cache-control': IMAGE_FAILURE_CACHE })
    }
    await settle(cache.put(cacheKey, kept), waiter)
    return withCookies(answer, authorization.setCookies)
  }

  /**
   * `/o/<key>` and `/img/<contentKey>/<index>`, by path; null for any other. A bundle has an
   * address of its own on each edge (`/o/bundle?k=` on tela-web, `/v1/bodies?keys=` on the
   * gateway), so an edge routes it to `serveBundle` itself, before this.
   */
  async function serve(request: Request, waiter?: Waiter): Promise<Response | null> {
    const path = new URL(request.url).pathname
    if (path.startsWith('/o/')) {
      // A key that does not decode (`/o/%`) is no object's.
      const key = safeDecode(path.slice(3))
      return key === null ? notFound() : serveObject(request, key, waiter)
    }
    if (path.startsWith('/img/')) {
      const [, , key = '', index = ''] = path.split('/')
      const i = Number(index)
      return CONTENT_KEY.test(key) && Number.isInteger(i) && i >= 0 && i < 1000
        ? serveImage(request, key, i, waiter)
        : text('not found', 404)
    }
    return null
  }

  return { object, serve, serveObject, serveBundle, serveImage }
}

export type Content = ReturnType<typeof createContent>
