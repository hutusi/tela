/**
 * When the device talks to the server (ADR 0025). The reader never waits on it: every screen
 * renders from the local store, and this keeps the store current behind it.
 *
 * - Pull: at start, when the tab becomes visible, every 60 s while it is, after each push, and on
 *   demand (an open article waiting for its full text).
 * - Push: a quarter-second after the last local change, so a burst of reads goes as one push, and
 *   at once when the tab is hidden or closed, so the last change before leaving is not left
 *   waiting for the next visit; offline, it keeps retrying with backoff and loses nothing
 *   (pending mutations are stored). A change held back for an Undo (the store's `holdMs`) goes
 *   when its toast goes, or with the rest when the tab is hidden or closed or the member signs out
 *   (`flush`), whichever is first.
 * - A call that has not answered in 30 s, body included, is given up like a failed one.
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
/**
 * A sync call not answered by then, its body included, is given up and tried again later. One
 * that stalls (a captive portal, a connection the network dropped without saying) would otherwise
 * hold `pulling` or `pushing` until a reload, and every later pull and push would wait behind it.
 * Giving up a push is safe: each change is guarded by its id, so one that did arrive is not
 * applied twice when it is sent again.
 */
export const SYNC_TIMEOUT_MS = 30_000

export class SyncEngine {
  private pulling: Promise<void> | null = null
  private pullAgain = false
  /** The push on its way, if any: one at a time, and `flush` waits for it. */
  private pushing: Promise<void> | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private backoff = 1000
  private interval: ReturnType<typeof setInterval> | null = null
  private stopped = false
  /** An event has been told since `start`: any later one is the same news again. */
  private ended = false
  /** Who hears of each pull that answered (`onPulled`). */
  private readonly pulled = new Set<() => void>()

  constructor(
    private readonly store: LocalStore,
    private readonly events: EngineEvents,
    private readonly timeoutMs = SYNC_TIMEOUT_MS,
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
    // A change held back for an Undo is stored now, for whichever push comes next (a reloaded
    // shell's, or this one's when it starts again): nothing may be left on a timer once stopped.
    this.store.releaseHolds()
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') void this.pull()
    else this.onLeave()
  }

  /**
   * The page may not come back: send what is waiting now, in a request that outlives it, changes
   * held back for an Undo included. Letting them go is synchronous, so the push sees them.
   */
  private onLeave = () => {
    this.store.releaseHolds()
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

  /**
   * Hear of each pull that answered, rows or none. A pull that brings nothing leaves the tables
   * as they were (`LocalStore.applyPull`), so a screen that only watches them never sees it: yet
   * it is news of its own, that the network is back or the tab is. Returns the unsubscribe.
   */
  onPulled(listener: () => void): () => void {
    this.pulled.add(listener)
    return () => {
      this.pulled.delete(listener)
    }
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
            // One signal for the request and its body: a page can stall after its headers too.
            const res = await api(`/api/v1/sync?cursor=${this.store.cursor}`, {
              member: owner,
              signal: AbortSignal.timeout(this.timeoutMs),
            })
            if (!res.ok) throw new Error(`pull ${res.status}`)
            const body = (await res.json()) as PullResponse
            // Asked to start over, by a table the server sends again after leaving it out.
            const again = await this.store.applyPull(body, epoch)
            more = body.more || again
          }
        } while (this.pullAgain && !this.stopped)
        for (const heard of this.pulled) heard()
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
    if (!(await this.send(options))) return
    if (this.store.unsent().length > 0) this.schedulePush()
    await this.pull()
  }

  /**
   * Send one batch of what is unsent, unless one is on its way already. True once it is answered;
   * false when nothing went, or it failed (offline, it is tried again later).
   */
  private async send(options: { keepalive?: boolean }): Promise<boolean> {
    if (this.pushing || this.stopped) return false
    const owner = this.store.userId
    const epoch = this.store.epoch
    if (owner === null) return false
    const batch = this.store.unsent()
    if (batch.length === 0) return false
    let sent = (): void => {}
    this.pushing = new Promise<void>((resolve) => {
      sent = resolve
    })
    try {
      const res = await api('/api/v1/mutations', {
        body: { mutations: batch },
        member: owner,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(options.keepalive ? { keepalive: true } : {}),
      })
      if (!res.ok) throw new Error(`push ${res.status}`)
      await this.store.acknowledge((await res.json()) as PushResponse, epoch)
      this.backoff = 1000
      return true
    } catch (err) {
      if (this.fail(err, epoch)) return false
      // Offline: try again later, a little later each time.
      this.pushTimer = setTimeout(() => void this.push(), this.backoff)
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
      return false
    } finally {
      this.pushing = null
      sent()
    }
  }

  /**
   * Signing out: let every hold go and send everything waiting, then come back, at most `ms`
   * later, so a sign-out offline is not held up (what is unsent then is lost with the account, as
   * it always was). Changes held for an Undo would otherwise go with the account, and everything
   * queued behind them. Nothing is pulled after: the rows are about to be forgotten. Answers mean
   * what they always do: a 409 for another account sends the tab to start again as them.
   */
  async flush(ms: number): Promise<void> {
    if (this.stopped) return
    this.store.releaseHolds()
    const sendAll = async () => {
      for (;;) {
        // This loop sends what the debounce would have.
        if (this.pushTimer) clearTimeout(this.pushTimer)
        this.pushTimer = null
        if (this.pushing) {
          await this.pushing
          continue
        }
        // The whole queue, not one push's worth: `unsent()` stops at 50, which reads the same
        // before and after a push of the first 50 out of 120, and so would end the flush with 70
        // still to send.
        const waiting = this.store.unsent(Number.POSITIVE_INFINITY).length
        // Stopped, failed, nothing left, or an answer that settled none of it: done.
        if (!(await this.send({}))) return
        if (this.store.unsent(Number.POSITIVE_INFINITY).length >= waiting) return
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })
    await Promise.race([sendAll(), late])
    clearTimeout(timer)
  }
}
