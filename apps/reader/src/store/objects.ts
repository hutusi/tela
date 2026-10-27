/**
 * Article bodies and translations: immutable objects addressed by key (ADR 0022), so a copy is
 * good for ever and can be fetched before it is wanted.
 *
 * Reading one goes memory → IndexedDB → the edge (`/o/…`, cached per colo). Prefetch fills
 * IndexedDB while the tab is idle, so opening an unread article needs no network at all. Each
 * object is downloaded once however many ask while it is on its way: a second open, or an open
 * of a body a prefetch bundle has just brought, waits for that download rather than starting one.
 *
 * A post from a blog the member does not subscribe to may be refused for the day (ADR 0066): a
 * 429 for one object, or a key a bundle lists apart. The refusal is remembered for the member
 * until the day starts again, and nothing asks for that post again before then: the prefetch
 * plans again after every pull, and would otherwise ask for every refused post once a minute.
 */
import type { Persistence } from './db'

/**
 * Sent on every request the idle prefetch makes. The edge ignores it; it says the request is
 * one nothing on screen waits for, which the no-network specs (e2e/local-first.e2e.ts,
 * e2e/translation.e2e.ts) rely on: the prefetch plans again whenever what it would fetch changes
 * (every open marks a post read), so one can start while a spec counts.
 */
export const PREFETCH_HEADER = 'x-tela-prefetch'

export type ContentBlock = { tag: string; html: string; leaves: string[] }
/** `c/<key>.json`, as `@tela/content` writes it. */
export type ContentObject = {
  format: number
  norm: number
  key: string
  lang: string
  blocks: ContentBlock[]
  leaves: Record<string, { hash: string; chars: number; skip?: true }>
  images: string[]
  stats: { chars: number; words: number; minutes: number }
}
/** `t/<key>/<lang>/<sha>.json`: one HTML string per top-level block, source where one failed. */
export type TranslationObject = {
  format: number
  lang: string
  status: 'done' | 'partial' | 'failed'
  blocks: string[]
  failedLeaves: string[]
}
/** `tc/<key>/<lang>/<request>/<n>.json`: the blocks one streamed chunk translated, by index. */
export type TranslationChunk = { format: number; n: number; blocks: Record<string, string> }

const RECENT = 40
/** Bodies not opened for this long go, unless the device is under its cap anyway. */
export const BODY_KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const BODY_CAP_BYTES = 50 * 1024 * 1024
const BUNDLE = 25
const PARALLEL = 2
/**
 * A request for an object gives up after this long, its answer read in full included: a stalled
 * connection (some mainland routes stall at TLS) would otherwise hold a download, everyone
 * waiting on it, and a prefetch run, for as long as the browser lets it hang.
 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * An object the edge would not give: anything but a 404, which says there is no such object and is
 * null instead. A 502 or a 401 says nothing about the object, so the page can offer to try again.
 */
export class ObjectUnavailable extends Error {
  override name = 'ObjectUnavailable'
  constructor(readonly status: number) {
    super(`object answered ${status}`)
  }
}

/** A post refused for the day's limit on blogs the member does not subscribe to (ADR 0066). */
export type PostRefusal = {
  /** The day's limit, when the edge said it. */
  limit: number | null
  /** When the day's count starts again, as the edge said: what the page tells the member. */
  resetsAt: number
  /**
   * When this device asks again: `resetsAt`, but never sooner than a minute after the refusal, so
   * a device whose clock runs ahead of the edge's does not ask again at once, and again, until the
   * edge's day has turned too.
   */
  retryAt: number
}

/** The answer a refused post gets: a 429 like any other, with what the page needs to say so. */
export class PostRefused extends ObjectUnavailable {
  override name = 'PostRefused'
  constructor(readonly refusal: PostRefusal) {
    super(429)
  }
}

/** The least a refusal is remembered for, whatever `resetsAt` says (`PostRefusal.retryAt`). */
export const REFUSAL_FLOOR_MS = 60_000
const DAY_MS = 86_400_000

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * A refusal for the day's limit as the edge words it (`{ error: 'post_limit', limit, resetsAt }`),
 * or null for anything else: a 429 for another reason is only a failure to try again. Without a
 * usable `resetsAt`, the `Retry-After` it came with says when, else the next UTC midnight.
 */
export function readRefusal(
  value: unknown,
  now: number,
  retryAfter: string | null = null,
): PostRefusal | null {
  const r = record(value)
  if (r?.error !== 'post_limit') return null
  const limit = typeof r.limit === 'number' && Number.isFinite(r.limit) ? r.limit : null
  const after = Number(retryAfter)
  const resetsAt =
    typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt)
      ? r.resetsAt
      : retryAfter !== null && Number.isFinite(after) && after > 0
        ? now + after * 1000
        : (Math.floor(now / DAY_MS) + 1) * DAY_MS
  return { limit, resetsAt, retryAt: Math.max(resetsAt, now + REFUSAL_FLOOR_MS) }
}

/**
 * A bundle's answer: `{ objects, refused }`, or, from a tela-web from before ADR 0066 (a rollback
 * under a cached shell), the bare map of objects it was.
 */
function readBundle(value: unknown): {
  objects: Record<string, ContentObject | undefined>
  refused: Record<string, unknown>
} {
  const answer = record(value) ?? {}
  const objects = record(answer.objects)
  if (!objects) return { objects: answer as Record<string, ContentObject | undefined>, refused: {} }
  return {
    objects: objects as Record<string, ContentObject | undefined>,
    refused: record(answer.refused) ?? {},
  }
}

/** JSON, or null for text that is not: an error page from something in front of the edge. */
function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The content key a translation object or chunk belongs to (`t/<key>/…`, `tc/<key>/…`). */
function contentKeyOf(objectKey: string): string | null {
  const [kind, key] = objectKey.split('/')
  return (kind === 't' || kind === 'tc') && key ? key : null
}

/**
 * Wait for a download several callers may share, until this caller's signal says to stop: the
 * download goes on for the others, and is kept for the next time it is wanted.
 */
function waitFor<T>(shared: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return shared
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    shared.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

export class Objects {
  /** The last few objects read, so going back and forth costs nothing. */
  private recent = new Map<string, unknown>()
  /** Bodies held in IndexedDB, known without asking it each time. */
  private held: Set<string> | null = null
  /**
   * Downloads on their way, one per object: bodies by content key, other objects by R2 key. Each
   * runs on no caller's signal, so one caller giving up never fails another; it leaves the map
   * once it is stored and remembered, or has failed.
   */
  private bodyFlights = new Map<string, Promise<ContentObject | null>>()
  private objectFlights = new Map<string, Promise<unknown>>()
  /** Bodies a prefetch bundle has brought and is still writing: already here, so not fetched. */
  private landing = new Map<string, ContentObject>()
  /**
   * Posts refused for the day's limit, by content key, for `refusalsOf` only: a refusal is one
   * member's count, and says nothing about the next account this tab holds. In memory: a reload
   * asks once more, which costs one answer.
   */
  private refusals = new Map<string, PostRefusal>()
  private refusalsOf: string | null = null
  /** The member's subscriptions as last told (`noteSubscriptions`); null before the first. */
  private subscriptions: string | null = null

  constructor(
    private readonly persistence: Persistence,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
    /** The account the tab holds, whose refusals these are. */
    private readonly member: () => string | null = () => null,
  ) {}

  /** The refusals remembered for the account the tab holds now. */
  private refusalsNow(): Map<string, PostRefusal> {
    const member = this.member()
    if (member !== this.refusalsOf) {
      this.refusals.clear()
      this.refusalsOf = member
    }
    return this.refusals
  }

  /**
   * Remember that the edge refused `key` for the day to `asker`, the account the tab held when it
   * asked, and the error that says so. A refusal that comes back after the tab has signed in as
   * someone else is not the new account's, and is not remembered.
   */
  private refuse(key: string, refusal: PostRefusal, asker: string | null): PostRefused {
    const refusals = this.refusalsNow()
    if (asker === this.refusalsOf) refusals.set(key, refusal)
    return new PostRefused(refusal)
  }

  /**
   * Whether the post with content key `key` was refused for the day's limit and is not to be asked
   * for again yet (until its `retryAt`); null when it may be asked for.
   */
  refusal(key: string): PostRefusal | null {
    const refusals = this.refusalsNow()
    const held = refusals.get(key)
    if (!held) return null
    if (held.retryAt > this.now()) return held
    refusals.delete(key)
    return null
  }

  /**
   * Forget every refusal, so each post is asked for again: subscribing makes a blog's posts free,
   * and which blog a refused key belongs to is not known here.
   */
  forgetRefusals(): void {
    this.refusals.clear()
  }

  /**
   * Told what the member's subscriptions are now, as any string that changes when they do: a
   * change forgets every refusal (`forgetRefusals`), wherever the member subscribed. The first
   * telling forgets nothing, so a page that mounts again does not ask again for refused posts.
   */
  noteSubscriptions(signature: string): void {
    if (this.subscriptions !== null && this.subscriptions !== signature) this.forgetRefusals()
    this.subscriptions = signature
  }

  /** `fetch` within `timeoutMs`, the answer read whole; `outer` still cancels it at once. */
  private async request(
    url: string,
    init: RequestInit,
    outer?: AbortSignal,
  ): Promise<{ ok: boolean; status: number; text: string; retryAfter: string | null }> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('The request timed out', 'TimeoutError')),
      this.timeoutMs,
    )
    const stop = () => controller.abort(outer?.reason)
    if (outer?.aborted) stop()
    outer?.addEventListener('abort', stop, { once: true })
    try {
      const res = await fetch(url, {
        ...init,
        credentials: 'same-origin',
        signal: controller.signal,
      })
      // A 429 is read too: it may say the post was refused for the day, and until when.
      const readable = res.ok || res.status === 429
      return {
        ok: res.ok,
        status: res.status,
        text: readable ? await res.text() : '',
        retryAfter: res.headers.get('retry-after'),
      }
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', stop)
    }
  }

  /**
   * An object's text; null for a 404, the one answer that says there is no such object. A 429 that
   * refuses the post `contentKey` for the day is remembered, and rejects with `PostRefused`.
   */
  private async text(
    url: string,
    init: RequestInit,
    contentKey: string | null,
  ): Promise<string | null> {
    const asker = this.member()
    const { ok, status, text, retryAfter } = await this.request(url, init)
    if (status === 404) return null
    if (status === 429 && contentKey !== null) {
      const refusal = readRefusal(parseOrNull(text), this.now(), retryAfter)
      if (refusal) throw this.refuse(contentKey, refusal, asker)
    }
    if (!ok) throw new ObjectUnavailable(status)
    return text
  }

  /**
   * Keep a copy on the device if it will take one. A full disk (QuotaExceededError) or a database
   * the browser closed costs only the copy: the answer the network already gave is still shown,
   * and asked for again next time.
   */
  private async keep(write: () => Promise<unknown>): Promise<void> {
    try {
      await write()
    } catch (err) {
      console.warn('not kept on this device', err)
    }
  }

  private remember(key: string, value: unknown) {
    this.recent.delete(key)
    this.recent.set(key, value)
    if (this.recent.size > RECENT) this.recent.delete(this.recent.keys().next().value as string)
  }

  /** The download of `key` under way, else `run` started as one. */
  private share<T>(flights: Map<string, Promise<T>>, key: string, run: () => Promise<T>) {
    const running = flights.get(key)
    if (running) return running
    const started: Promise<T> = run().finally(() => {
      if (flights.get(key) === started) flights.delete(key)
    })
    // Everyone waiting may have given up: a failure then is nobody's to handle.
    started.catch(() => undefined)
    flights.set(key, started)
    return started
  }

  /** The bodies held; none, and asked again next time, while the database cannot be read. */
  private async heldKeys(): Promise<Set<string>> {
    if (this.held) return this.held
    const keys = await this.persistence.bodyKeys().catch(() => null)
    if (keys === null) return new Set()
    this.held = new Set(keys)
    return this.held
  }

  /**
   * A content object, and mark it opened now. Null only when the edge says there is none (a 404);
   * any other refusal rejects with `ObjectUnavailable`, and a network failure as fetch does. A
   * post refused for the day rejects with `PostRefused`, and until its `retryAt` without asking.
   * A body the device holds is always given: it was not refused when it came.
   */
  async body(key: string, signal?: AbortSignal): Promise<ContentObject | null> {
    const cacheKey = `c/${key}`
    const hit = this.recent.get(cacheKey) as ContentObject | undefined
    if (hit) {
      void this.keep(() => this.persistence.touchBody(key, this.now()))
      return hit
    }
    // Brought by a prefetch bundle and still being written (with this moment as its last open).
    const landed = this.landing.get(key)
    if (landed) {
      this.remember(cacheKey, landed)
      return landed
    }
    return waitFor(
      this.share(this.bodyFlights, key, () => this.download(key)),
      signal,
    )
  }

  private async download(key: string): Promise<ContentObject | null> {
    const cacheKey = `c/${key}`
    // A database that cannot be read holds nothing: the network still has it.
    const stored = await this.persistence.getBody(key).catch(() => undefined)
    if (stored) {
      void this.keep(() => this.persistence.touchBody(key, this.now()))
      this.remember(cacheKey, stored.object)
      return stored.object as ContentObject
    }
    const refused = this.refusal(key)
    if (refused) throw new PostRefused(refused)
    const text = await this.text(`/o/c/${key}.json`, {}, key)
    if (text === null) return null
    const object = JSON.parse(text) as ContentObject
    await this.keep(() => this.store(key, object, text.length))
    this.remember(cacheKey, object)
    return object
  }

  private async store(key: string, object: unknown, bytes: number) {
    await this.persistence.putBody({ key, object, bytes, lastOpened: this.now() })
    ;(await this.heldKeys()).add(key)
  }

  /**
   * A translation or chunk object by its R2 key, null or rejecting as `body` does. `background`
   * marks the request as a prefetch (`PREFETCH_HEADER`): nothing on screen is waiting for it. A
   * download already on its way is waited for, whoever started it, so the request says what its
   * first asker was. The translation of a post refused for the day is refused with it.
   */
  async object<T>(key: string, signal?: AbortSignal, background = false): Promise<T | null> {
    const hit = this.recent.get(key) as T | undefined
    if (hit) return hit
    const shared = this.share(this.objectFlights, key, async (): Promise<unknown> => {
      const stored = await this.persistence.getObject(key).catch(() => undefined)
      if (stored) {
        this.remember(key, stored.object)
        return stored.object
      }
      const contentKey = contentKeyOf(key)
      const refused = contentKey === null ? null : this.refusal(contentKey)
      if (refused) throw new PostRefused(refused)
      const text = await this.text(
        `/o/${key}`,
        background ? { headers: { [PREFETCH_HEADER]: '1' } } : {},
        contentKey,
      )
      if (text === null) return null
      const object: unknown = JSON.parse(text)
      // Waited for before anyone is answered: until it is written, a second ask would miss it.
      await this.keep(() => this.persistence.putObject({ key, object, at: this.now() }))
      this.remember(key, object)
      return object
    })
    return (await waitFor(shared, signal)) as T | null
  }

  /**
   * Fetch the bodies not held yet, in bundles of 25, two at a time, in the order given: the list
   * on screen first. Skipped when the browser asks to save data. Each bundle is chosen as it
   * starts, so a body a page began fetching meanwhile is left out of it. Nothing waits on a bundle
   * still downloading (an open would wait for 25 bodies, not one), but once one has arrived its
   * bodies are `landing` until written, and an open takes its body from there. A post refused for
   * the day is left out until its `retryAt`, and a bundle's refusals are remembered.
   */
  async prefetch(keys: string[], signal?: AbortSignal): Promise<number> {
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection
    if (connection?.saveData) return 0
    const held = await this.heldKeys()
    const queue = [...new Set(keys)]
    const nextBundle = (): string[] => {
      const bundle: string[] = []
      while (bundle.length < BUNDLE) {
        const key = queue.shift()
        if (key === undefined) break
        if (held.has(key) || this.bodyFlights.has(key) || this.landing.has(key)) continue
        if (this.refusal(key)) continue
        bundle.push(key)
      }
      return bundle
    }
    let fetched = 0
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return
        const next = nextBundle()
        if (next.length === 0) return
        try {
          const asker = this.member()
          const { ok, status, text, retryAfter } = await this.request(
            `/o/bundle?k=${next.join(',')}`,
            { headers: { [PREFETCH_HEADER]: '1' } },
            signal,
          )
          if (!ok) {
            // Refused whole for the day (the contract lists refusals apart, but should an edge
            // refuse the request itself): every post in it waits, as one refused alone would.
            const refusal =
              status === 429 ? readRefusal(parseOrNull(text), this.now(), retryAfter) : null
            if (refusal) for (const key of next) this.refuse(key, refusal, asker)
            return
          }
          const { objects, refused } = readBundle(JSON.parse(text))
          const now = this.now()
          for (const key of next) {
            const refusal = objects[key] === undefined ? readRefusal(refused[key], now) : null
            if (refusal) this.refuse(key, refusal, asker)
          }
          const arrived = next.filter((key) => objects[key] !== undefined)
          for (const key of arrived) this.landing.set(key, objects[key] as ContentObject)
          try {
            for (const key of arrived) {
              const object = objects[key] as ContentObject
              await this.store(key, object, JSON.stringify(object).length)
              this.landing.delete(key)
              fetched++
            }
          } finally {
            for (const key of arrived) this.landing.delete(key)
          }
        } catch {
          return
        }
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker))
    return fetched
  }

  /**
   * Which of these bodies the device does not hold yet and may ask for now: a post refused for the
   * day is not missing until its `retryAt`, so asking again for it is not worth a prefetch run.
   */
  async missing(keys: readonly string[]): Promise<string[]> {
    const held = await this.heldKeys()
    return keys.filter((key) => !held.has(key) && !this.refusal(key))
  }

  /**
   * Drop bodies not opened for a week, then the oldest until under the cap, with their
   * translations. Best effort: what a failure leaves is tried again at the next boot.
   */
  async evict(): Promise<void> {
    let drop: string[]
    try {
      drop = await this.persistence.evictBodies(this.now() - BODY_KEEP_MS, BODY_CAP_BYTES)
    } catch (err) {
      console.warn('eviction failed', err)
      return
    }
    if (drop.length === 0) return
    const held = await this.heldKeys()
    for (const key of drop) {
      held.delete(key)
      this.recent.delete(`c/${key}`)
    }
  }
}
