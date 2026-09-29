/**
 * When the device talks to the server (ADR 0025). The reader never waits on it: every screen
 * renders from the local store, and this keeps the store current behind it.
 *
 * - Pull: at start, when the tab becomes visible, every 60 s while it is, after each push, and on
 *   demand (an open article waiting for its full text).
 * - Push: a quarter-second after the last local change, so a burst of reads goes as one push, and
 *   at once when the tab is hidden or closed, so the last change before leaving is not left
 *   waiting for the next visit; offline, it keeps retrying with backoff and loses nothing
 *   (pending mutations are stored).
 * - A 401 means the session is gone; a 409 means this app is older than the protocol, or that
 *   another tab signed in as someone else. Each sync call names whose rows the device holds.
 */
import type { PullResponse, PushResponse } from '@tela/sync'
import { AccountChanged, api, SignedOut, UpgradeRequired } from './api'
import type { LocalStore } from './local'

export type EngineEvents = {
  onSignedOut(): void
  onUpgrade(): void
  /** The session is another account's than the rows this device holds. */
  onAccountChanged(): void
}

const PULL_EVERY_MS = 60_000
const PUSH_DEBOUNCE_MS = 250
const MAX_BACKOFF_MS = 60_000

export class SyncEngine {
  private pulling: Promise<void> | null = null
  private pullAgain = false
  private pushing = false
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private backoff = 1000
  private interval: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private readonly store: LocalStore,
    private readonly events: EngineEvents,
  ) {
    store.onMutation = () => this.schedulePush()
  }

  start(): void {
    this.stopped = false
    void this.pull()
    if (this.store.unsent().length > 0) this.schedulePush()
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pagehide', this.onLeave)
    window.addEventListener('online', this.onOnline)
    this.interval = setInterval(() => {
      if (document.visibilityState === 'visible') void this.pull()
    }, PULL_EVERY_MS)
  }

  stop(): void {
    this.stopped = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('pagehide', this.onLeave)
    window.removeEventListener('online', this.onOnline)
    if (this.interval) clearInterval(this.interval)
    if (this.pushTimer) clearTimeout(this.pushTimer)
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') void this.pull()
    else this.onLeave()
  }

  /** The page may not come back: send what is waiting now, in a request that outlives it. */
  private onLeave = () => {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    void this.push({ keepalive: true })
  }

  private onOnline = () => {
    void this.pull()
    this.schedulePush()
  }

  private fail(err: unknown): boolean {
    if (err instanceof SignedOut) {
      this.stop()
      this.events.onSignedOut()
      return true
    }
    if (err instanceof UpgradeRequired) {
      this.stop()
      this.events.onUpgrade()
      return true
    }
    if (err instanceof AccountChanged) {
      this.stop()
      this.events.onAccountChanged()
      return true
    }
    return false
  }

  /** Pull until caught up. Calls while one runs coalesce into one more pull after it. */
  pull(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pulling) {
      this.pullAgain = true
      return this.pulling
    }
    this.pulling = (async () => {
      try {
        do {
          this.pullAgain = false
          for (;;) {
            const res = await api(`/api/v1/sync?cursor=${this.store.cursor}`, {
              member: this.store.userId,
            })
            if (!res.ok) throw new Error(`pull ${res.status}`)
            const body = (await res.json()) as PullResponse
            await this.store.applyPull(body)
            if (!body.more) break
          }
        } while (this.pullAgain && !this.stopped)
      } catch (err) {
        // Offline or a server hiccup: the next trigger pulls again. Nothing is lost.
        this.fail(err)
      } finally {
        this.pulling = null
      }
    })()
    return this.pulling
  }

  schedulePush(): void {
    if (this.stopped) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.push(), PUSH_DEBOUNCE_MS)
  }

  /** Push what is unsent, then pull so the confirmed tables catch up with it. */
  async push(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.pushing || this.stopped) return
    const batch = this.store.unsent()
    if (batch.length === 0) return
    this.pushing = true
    try {
      const res = await api('/api/v1/mutations', {
        body: { mutations: batch },
        member: this.store.userId,
        ...(options.keepalive ? { keepalive: true } : {}),
      })
      if (!res.ok) throw new Error(`push ${res.status}`)
      await this.store.acknowledge((await res.json()) as PushResponse)
      this.backoff = 1000
      this.pushing = false
      if (this.store.unsent().length > 0) this.schedulePush()
      await this.pull()
    } catch (err) {
      this.pushing = false
      if (this.fail(err)) return
      // Offline: try again later, a little later each time.
      this.pushTimer = setTimeout(() => void this.push(), this.backoff)
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
    }
  }
}
