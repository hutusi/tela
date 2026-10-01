/**
 * Article bodies and translations: immutable objects addressed by key (ADR 0022), so a copy is
 * good for ever and can be fetched before it is wanted.
 *
 * Reading one goes memory → IndexedDB → the edge (`/o/…`, cached per colo). Prefetch fills
 * IndexedDB while the tab is idle, so opening an unread article needs no network at all. Each
 * object is downloaded once however many ask while it is on its way: a second open, or an open
 * of a body a prefetch bundle has just brought, waits for that download rather than starting one.
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

  constructor(
    private readonly persistence: Persistence,
    private readonly now: () => number = Date.now,
  ) {}

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

  private async heldKeys(): Promise<Set<string>> {
    if (!this.held) this.held = new Set(await this.persistence.bodyKeys())
    return this.held
  }

  /** A content object, and mark it opened now. */
  async body(key: string, signal?: AbortSignal): Promise<ContentObject | null> {
    const cacheKey = `c/${key}`
    const hit = this.recent.get(cacheKey) as ContentObject | undefined
    if (hit) {
      void this.persistence.touchBody(key, this.now())
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
    const stored = await this.persistence.getBody(key)
    if (stored) {
      void this.persistence.touchBody(key, this.now())
      this.remember(cacheKey, stored.object)
      return stored.object as ContentObject
    }
    const res = await fetch(`/o/c/${key}.json`, { credentials: 'same-origin' })
    if (!res.ok) return null
    const text = await res.text()
    const object = JSON.parse(text) as ContentObject
    await this.store(key, object, text.length)
    this.remember(cacheKey, object)
    return object
  }

  private async store(key: string, object: unknown, bytes: number) {
    await this.persistence.putBody({ key, object, bytes, lastOpened: this.now() })
    ;(await this.heldKeys()).add(key)
  }

  /**
   * A translation or chunk object by its R2 key. `background` marks the request as a prefetch
   * (`PREFETCH_HEADER`): nothing on screen is waiting for it. A download already on its way is
   * waited for, whoever started it, so the request says what its first asker was.
   */
  async object<T>(key: string, signal?: AbortSignal, background = false): Promise<T | null> {
    const hit = this.recent.get(key) as T | undefined
    if (hit) return hit
    const shared = this.share(this.objectFlights, key, async (): Promise<unknown> => {
      const stored = await this.persistence.getObject(key)
      if (stored) {
        this.remember(key, stored.object)
        return stored.object
      }
      const res = await fetch(`/o/${key}`, {
        credentials: 'same-origin',
        ...(background ? { headers: { [PREFETCH_HEADER]: '1' } } : {}),
      })
      if (!res.ok) return null
      const object: unknown = await res.json()
      // Waited for before anyone is answered: until it is written, a second ask would miss it.
      await this.persistence.putObject({ key, object, at: this.now() })
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
   * bodies are `landing` until written, and an open takes its body from there.
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
          const res = await fetch(`/o/bundle?k=${next.join(',')}`, {
            credentials: 'same-origin',
            headers: { [PREFETCH_HEADER]: '1' },
            ...(signal ? { signal } : {}),
          })
          if (!res.ok) return
          const objects = (await res.json()) as Record<string, ContentObject | undefined>
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

  /** Drop bodies not opened for a week, then the oldest until under the cap. */
  async evict(): Promise<void> {
    const stale = await this.persistence.staleBodies(this.now() - BODY_KEEP_MS)
    let bytes = await this.persistence.bodyBytes()
    const drop: string[] = []
    for (const body of stale) {
      drop.push(body.key)
      bytes -= body.bytes
    }
    if (bytes > BODY_CAP_BYTES) {
      for (const body of await this.persistence.staleBodies(this.now())) {
        if (bytes <= BODY_CAP_BYTES) break
        if (drop.includes(body.key)) continue
        drop.push(body.key)
        bytes -= body.bytes
      }
    }
    if (drop.length === 0) return
    await this.persistence.deleteBodies(drop)
    const held = await this.heldKeys()
    for (const key of drop) {
      held.delete(key)
      this.recent.delete(`c/${key}`)
    }
  }
}
