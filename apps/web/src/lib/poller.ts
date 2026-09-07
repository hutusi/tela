import { createPollBudget } from './poll-budget'

/** Timer functions, injectable so the loop can be tested without waiting for real time. */
export type PollerTimer = {
  set: (fn: () => void, ms: number) => number
  clear: (id: number) => void
}

const systemTimer: PollerTimer = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
}

export type PollerOptions = {
  /** The revision this page was rendered from; a different one is worth reacting to. */
  revision: string
  /** Reads the current revision. Null means "could not tell", which is not a change. */
  read: (signal: AbortSignal) => Promise<string | null>
  /** Called once, when the revision has actually moved. The poller stops first. */
  onChanged: () => void
  /** Whether the page is out of sight. */
  hidden: () => boolean
  startMs: number
  maxIntervalMs: number
  /** How long to wait, counted in visible time only. */
  maxMs: number
  now?: () => number
  timer?: PollerTimer
}

export type Poller = {
  start: () => void
  /** Call whenever the page's visibility changes. */
  visibilityChanged: () => void
  stop: () => void
}

/**
 * Waits for a revision to change, cheaply: back off between reads, hold still while nobody is
 * looking, and hand back control exactly once.
 *
 * The rules here are small but they have been got wrong twice, which is why they live in a module
 * with a clock and a timer that tests can drive:
 *
 * - The window is **visible time**. A poller that skips its read while hidden must not spend its
 *   window while hidden either, or a tab left in the background comes back to finished work that
 *   the page still shows as running.
 * - **One read at a time.** A tab hidden and restored while a read is in flight must not start a
 *   second loop beside the one already running.
 */
export function createPoller(options: PollerOptions): Poller {
  const { revision, read, onChanged, hidden, startMs, maxIntervalMs, maxMs } = options
  const timer = options.timer ?? systemTimer
  const budget = createPollBudget(maxMs, options.now)
  const controller = new AbortController()
  let handle: number | undefined
  let interval = startMs
  let inFlight = false
  let stopped = false

  const clear = () => {
    if (handle !== undefined) timer.clear(handle)
    handle = undefined
  }

  const stop = () => {
    stopped = true
    clear()
    controller.abort()
  }

  const schedule = (delay = interval) => {
    if (stopped || budget.exhausted()) return stop()
    // Nobody is looking: hold here, and let visibilityChanged() resume with an immediate read.
    if (hidden()) return budget.pause()
    handle = timer.set(tick, delay)
  }

  async function tick() {
    handle = undefined
    if (stopped || hidden()) return schedule()
    inFlight = true
    let current: string | null = null
    try {
      current = await read(controller.signal)
    } catch {
      // A failed read is not worth surfacing: the next one tries again, and the reader can always
      // reload. Aborting on stop() lands here too.
    } finally {
      inFlight = false
    }
    if (stopped) return
    if (current !== null && current !== revision) {
      stop()
      onChanged()
      return
    }
    interval = Math.min(interval * 1.5, maxIntervalMs)
    schedule()
  }

  return {
    start: () => schedule(startMs),
    visibilityChanged: () => {
      if (stopped) return
      if (hidden()) {
        budget.pause()
        clear()
        return
      }
      budget.resume()
      // The reader is looking again: read now, then carry on with the backoff. Not while a read
      // is already in flight — that is how a second loop gets started.
      if (handle === undefined && !inFlight) schedule(0)
    },
    stop,
  }
}
