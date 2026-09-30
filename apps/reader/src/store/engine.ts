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
 *   another tab signed in as someone else. Each call names the account the tab holds, and its
 *   answer is taken only while the tab still holds it (the store's epoch).
 */
import type { PullResponse, PushResponse } from '@tela/sync'
import { AccountChanged, api, SignedOut, UpgradeRequired } from './api'
import type { LocalStore } from './local'

export type EngineEvents = {
  onSignedOut(): void
  onUpgrade(): void
  /** The session is another account's than the rows this tab holds, or the copy was taken. */
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
  /** An event has been told since `start`: any later one is the same news again. */
  private ended = false

  constructor(
    private readonly store: LocalStore,
    private readonly events: EngineEvents,
  ) {
    store.onMutation = () => this.schedulePush()
    // The device database refused a write: another tab holds its copy now.
    store.onLost = () => this.end(() => this.events.onAccountChanged())
  }

  start(): void {
    // A tab that holds no account has nothing to sync, and nobody to name.
    if (this.store.userId === null) return
    this.stopped = false
    this.ended = false
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

  /** Stop, and say why, once. */
  private end(event: () => void): void {
    this.stop()
    if (this.ended) return
    this.ended = true
    event()
  }

  /**
   * Whether `err` ends this attempt. An account_changed for rows the tab stopped holding after
   * `epoch` (it has signed in anew since) is only stale, and ends nothing else.
   */
  private fail(err: unknown, epoch: number): boolean {
    if (err instanceof SignedOut) {
      this.end(() => this.events.onSignedOut())
      return true
    }
    if (err instanceof UpgradeRequired) {
      this.end(() => this.events.onUpgrade())
      return true
    }
    if (err instanceof AccountChanged) {
      if (epoch === this.store.epoch) this.end(() => this.events.onAccountChanged())
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
      let epoch = this.store.epoch
      try {
        do {
          this.pullAgain = false
          // Whose rows these pages are for. Once the tab holds anything else, the pages still to
          // come are not its to ask for, and one already on its way is dropped by the store.
          const owner = this.store.userId
          epoch = this.store.epoch
          if (owner === null) break
          let more = true
          while (more && this.store.epoch === epoch) {
            const res = await api(`/api/v1/sync?cursor=${this.store.cursor}`, { member: owner })
            if (!res.ok) throw new Error(`pull ${res.status}`)
            const body = (await res.json()) as PullResponse
            await this.store.applyPull(body, epoch)
            more = body.more
          }
        } while (this.pullAgain && !this.stopped)
      } catch (err) {
        // Offline or a server hiccup: the next trigger pulls again. Nothing is lost.
        this.fail(err, epoch)
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
    const owner = this.store.userId
    const epoch = this.store.epoch
    if (owner === null) return
    const batch = this.store.unsent()
    if (batch.length === 0) return
    this.pushing = true
    try {
      const res = await api('/api/v1/mutations', {
        body: { mutations: batch },
        member: owner,
        ...(options.keepalive ? { keepalive: true } : {}),
      })
      if (!res.ok) throw new Error(`push ${res.status}`)
      await this.store.acknowledge((await res.json()) as PushResponse, epoch)
      this.backoff = 1000
      this.pushing = false
      if (this.store.unsent().length > 0) this.schedulePush()
      await this.pull()
    } catch (err) {
      this.pushing = false
      if (this.fail(err, epoch)) return
      // Offline: try again later, a little later each time.
      this.pushTimer = setTimeout(() => void this.push(), this.backoff)
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
    }
  }
}
