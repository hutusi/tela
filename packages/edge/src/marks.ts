/**
 * The colo's cache as both edges use it, and the small facts they keep in it: that a member may
 * have a post today (tela-web), that an app's token answered lately (tela-gateway).
 */
/** The colo's cache (`caches.default` on Cloudflare), or a map in tests. */
export type EdgeCache = {
  match(key: Request): Promise<Response | undefined>
  put(key: Request, response: Response): Promise<void>
  /** Cloudflare's has it; a fact that is no longer true is forgotten sooner with it. */
  delete?(key: Request): Promise<boolean>
}

/** What lets work finish after the answer has gone (`ExecutionContext` on Cloudflare). */
export type Waiter = { waitUntil(promise: Promise<unknown>): void }

/** The cache's own namespace: keys are never a URL anyone can request. */
export const CACHE_ORIGIN = 'https://tela-edge.cache'

/** Run `put` now, or after the answer when there is a waiter to hold it. */
export async function settle(put: Promise<unknown>, waiter?: Waiter): Promise<void> {
  if (waiter) waiter.waitUntil(put)
  else await put
}

/** When a kept fact ends, epoch ms: the cache keeps it no longer, and a read checks it too. */
const UNTIL = 'x-tela-until'

/**
 * Facts kept in the colo until a moment: `has` is true only before it. The cache is told the same
 * lifetime, and the moment is checked on every read as well, since a colo may keep an entry
 * longer than it was told, and a test's cache keeps everything.
 */
export function createMarks(cache: EdgeCache, now: () => number = Date.now) {
  const keyOf = (path: string) => new Request(`${CACHE_ORIGIN}/${path}`)
  return {
    async has(path: string): Promise<boolean> {
      const hit = await cache.match(keyOf(path))
      if (!hit) return false
      const until = Number(hit.headers.get(UNTIL))
      return Number.isFinite(until) && until > now()
    },
    async set(path: string, until: number, waiter?: Waiter): Promise<void> {
      const seconds = Math.ceil((until - now()) / 1000)
      if (seconds <= 0) return
      const kept = new Response('1', {
        // Public, or Cloudflare's cache does not keep it; the key is in no one's reach.
        headers: { 'cache-control': `public, max-age=${seconds}`, [UNTIL]: String(until) },
      })
      await settle(cache.put(keyOf(path), kept), waiter)
    },
    async forget(path: string, waiter?: Waiter): Promise<void> {
      if (cache.delete) await settle(cache.delete(keyOf(path)), waiter)
    },
  }
}

export type Marks = ReturnType<typeof createMarks>

/** SHA-256 of `text`, lowercase hex: what a member's id or a token is kept under, never itself. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const DAY_MS = 86_400_000

/** A UTC day as `post_opens` keys it. */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10)

/** The next UTC midnight after `now`: when the day's count of posts opened starts again. */
export const nextUtcMidnight = (now: number): number => (Math.floor(now / DAY_MS) + 1) * DAY_MS

/** `decodeURIComponent`, or null where it throws (`/o/%`): a name nothing has. */
export function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch (err) {
    if (err instanceof URIError) return null
    throw err
  }
}

/** Read a stream into memory, or null once it passes `max` bytes. */
export async function readAtMost(
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
