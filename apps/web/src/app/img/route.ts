import { verifyImageParams } from '@tela/content/images'
import { cappedStream } from '@tela/ingest/http'
import { isBlockedHost } from '@tela/ingest/net'
import { imageProxySecret } from '@/lib/platform/env'
import { waitUntil } from '@/lib/platform/wait-until'

const MAX_BYTES = 10 * 1024 * 1024
const TIMEOUT_MS = 10_000
const CACHE_SECONDS = 7 * 24 * 3600

/**
 * Signed image proxy. Readers never contact the blog's image host directly, hotlink
 * protection stops mattering, and the signature prevents use as an open proxy.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const u = url.searchParams.get('u') ?? ''
  const s = url.searchParams.get('s') ?? ''
  const secret = await imageProxySecret()
  if (!secret) return new Response('image proxy disabled', { status: 404 })
  const target = await verifyImageParams(u, s, secret)
  if (!target) return new Response('bad signature', { status: 403 })
  // Signed URLs come from feed HTML, which a publisher controls; never fetch into a private
  // network for them. (Cloudflare's strictly-public fetch is the other layer on Workers.)
  // TELA_ALLOW_PRIVATE_HOSTS is the tests-only escape hatch discovery uses for fixture servers.
  const allowPrivateHosts = process.env.TELA_ALLOW_PRIVATE_HOSTS === '1'
  if (!allowPrivateHosts && isBlockedHost(new URL(target).hostname)) {
    return new Response('forbidden', { status: 403 })
  }

  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const cacheKey = new Request(url.toString(), { method: 'GET' })
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => undefined)
    if (hit) return hit
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      headers: {
        accept: 'image/avif,image/webp,image/*;q=0.9,*/*;q=0.5',
        'user-agent': 'Tela/0.1 (+https://tela.app/bot; image proxy)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return new Response('upstream unavailable', { status: 502 })
  }
  if (!upstream.ok || !upstream.body) return new Response('upstream error', { status: 502 })

  const type =
    (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!type.startsWith('image/') || type === 'image/svg+xml') {
    return new Response('not an image', { status: 415 })
  }
  // A declared size over the cap is refused outright; everything else is counted as it
  // streams, since Content-Length is optional (chunked) and chosen by the origin.
  const length = Number(upstream.headers.get('content-length') ?? 0)
  if (length > MAX_BYTES) {
    await upstream.body.cancel().catch(() => {})
    return new Response('too large', { status: 413 })
  }

  const response = new Response(cappedStream(upstream.body, MAX_BYTES), {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': `public, max-age=${CACHE_SECONDS}, immutable`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      ...(length ? { 'content-length': String(length) } : {}),
    },
  })
  if (cache) {
    // Filled in the background: awaiting the put would hold the whole body in memory until the
    // origin finished, before the first byte reached the reader. A capped or failed stream
    // simply leaves the cache empty.
    await waitUntil(cache.put(cacheKey, response.clone()))
  }
  return response
}
