export type PollBudget = {
  /** Stop counting: the tab went away and nobody can see what we are waiting for. */
  pause: () => void
  /** Start counting again. */
  resume: () => void
  /** Time counted so far. */
  spentMs: () => number
  /** Whether the budget is used up. */
  exhausted: () => boolean
}

/**
 * How long a poller has been waiting *where someone could see it*.
 *
 * A poller that skips its request while the tab is hidden must not spend its budget while it is
 * hidden either. Counting wall-clock time meant a tab left in the background for the length of
 * the window came back to a page still showing "translating", with nothing left to notice that
 * the work had finished.
 */
export function createPollBudget(maxMs: number, now: () => number = Date.now): PollBudget {
  let spent = 0
  let since: number | null = now()
  const total = () => spent + (since === null ? 0 : now() - since)
  return {
    pause: () => {
      if (since === null) return
      spent += now() - since
      since = null
    },
    resume: () => {
      if (since === null) since = now()
    },
    spentMs: total,
    exhausted: () => total() >= maxMs,
  }
}
