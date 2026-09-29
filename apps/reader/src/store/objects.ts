/**
 * Article bodies and translations: immutable objects addressed by key (ADR 0022), so a copy is
 * good for ever and can be fetched before it is wanted.
 *
 * Reading one goes memory → IndexedDB → the edge (`/o/…`, cached per colo). Prefetch fills
 * IndexedDB while the tab is idle, so opening an unread article needs no network at all.
 */
import type { Persistence } from './db'

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

export class Objects {
  /** The last few objects read, so going back and forth costs nothing. */
  private recent = new Map<string, unknown>()
  /** Bodies held in IndexedDB, known without asking it each time. */
  private held: Set<string> | null = null

  constructor(
    private readonly persistence: Persistence,
    private readonly now: () => number = Date.now,
  ) {}

  private remember(key: string, value: unknown) {
    this.recent.delete(key)
    this.recent.set(key, value)
    if (this.recent.size > RECENT) this.recent.delete(this.recent.keys().next().value as string)
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
    const stored = await this.persistence.getBody(key)
    if (stored) {
      void this.persistence.touchBody(key, this.now())
      this.remember(cacheKey, stored.object)
      return stored.object as ContentObject
    }
    const res = await fetch(`/o/c/${key}.json`, {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    })
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

  /** A translation or chunk object by its R2 key. */
  async object<T>(key: string, signal?: AbortSignal): Promise<T | null> {
    const hit = this.recent.get(key) as T | undefined
    if (hit) return hit
    const stored = await this.persistence.getObject(key)
    if (stored) {
      this.remember(key, stored.object)
      return stored.object as T
    }
    const res = await fetch(`/o/${key}`, {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) return null
    const object = (await res.json()) as T
    await this.persistence.putObject({ key, object, at: this.now() })
    this.remember(key, object)
    return object
  }

  /**
   * Fetch the bodies not held yet, in bundles of 25, two at a time, in the order given: the list
   * on screen first. Skipped when the browser asks to save data.
   */
  async prefetch(keys: string[], signal?: AbortSignal): Promise<number> {
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection
    if (connection?.saveData) return 0
    const held = await this.heldKeys()
    const missing = [...new Set(keys)].filter((k) => !held.has(k))
    const bundles: string[][] = []
    for (let i = 0; i < missing.length; i += BUNDLE) bundles.push(missing.slice(i, i + BUNDLE))
    let fetched = 0
    const worker = async () => {
      for (;;) {
        const next = bundles.shift()
        if (!next || signal?.aborted) return
        try {
          const res = await fetch(`/o/bundle?k=${next.join(',')}`, {
            credentials: 'same-origin',
            ...(signal ? { signal } : {}),
          })
          if (!res.ok) return
          const objects = (await res.json()) as Record<string, ContentObject>
          for (const [key, object] of Object.entries(objects)) {
            await this.store(key, object, JSON.stringify(object).length)
            fetched++
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
