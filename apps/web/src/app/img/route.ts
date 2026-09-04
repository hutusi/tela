import { verifyImageParams } from '@tela/content/images'
import { imageProxySecret } from '@/lib/platform/env'

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
  const length = Number(upstream.headers.get('content-length') ?? 0)
  if (length > MAX_BYTES) return new Response('too large', { status: 413 })

  const response = new Response(upstream.body, {
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
    try {
      await cache.put(cacheKey, response.clone())
    } catch {
      // Cache API unavailable (local Node); serve uncached.
    }
  }
  return response
}
