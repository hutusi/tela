/**
 * Pulling sooner than the engine's minute, while the page waits on work tela-jobs is doing for it:
 * a summary-only post's full text, a new feed's first posts. Each lands by sync, so a pull a few
 * seconds after it lands is what makes it appear.
 *
 * Bounded, because the work may never land: a blog that refuses the fetch, a queue that is behind.
 * The pulls back off from 4 s to a minute and stop two minutes after they started, which the
 * engine's own pull a minute takes over from; they wait while the tab is hidden, since nobody is
 * looking, and the engine pulls as it comes back into view. Unbounded, an open post whose
 * extraction never landed pulled every 4 s for as long as it stayed open, some 900 times an hour.
 */
import { useEffect, useRef } from 'react'

/** The first pull's wait, doubled after each pull up to `QUICK_PULL_MAX_MS`. */
export const QUICK_PULL_FIRST_MS = 4000
export const QUICK_PULL_MAX_MS = 60_000
/** No quick pull is made later than this after the first was scheduled. */
export const QUICK_PULL_FOR_MS = 120_000

/** Whether the page is out of view, and word when that changes. */
export type Visibility = {
  hidden: () => boolean
  /** Call `onChange` when the page is hidden or shown; returns the way to stop. */
  watch: (onChange: () => void) => () => void
}

const documentVisibility: Visibility = {
  hidden: () => document.visibilityState === 'hidden',
  watch: (onChange) => {
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  },
}

/** Start pulling quickly; returns the way to stop. */
export function startQuickPull(
  pull: () => void,
  page: Visibility = documentVisibility,
): () => void {
  const until = Date.now() + QUICK_PULL_FOR_MS
  let wait = QUICK_PULL_FIRST_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const clear = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const arm = () => {
    if (stopped || timer !== null || page.hidden()) return
    // The next pull would come after the two minutes: the engine's minute takes over.
    if (Date.now() + wait > until) return stop()
    timer = setTimeout(() => {
      timer = null
      // Hidden since it was armed: the page coming back arms it again.
      if (page.hidden()) return
      pull()
      wait = Math.min(wait * 2, QUICK_PULL_MAX_MS)
      arm()
    }, wait)
  }
  // Hidden, nothing waits; shown again, the wait starts over at the step it had reached.
  const unwatch = page.watch(() => (page.hidden() ? clear() : arm()))
  const stop = () => {
    if (stopped) return
    stopped = true
    clear()
    unwatch()
  }
  arm()
  return stop
}

/**
 * Pull quickly while `waitingFor` names something the page waits on, and start over when it names
 * something else (another post, another feed); null pulls nothing quickly. `pull` is read when it
 * runs, so a new function each render does not start the pulls over.
 */
export function useQuickPull(waitingFor: string | null, pull: () => void): void {
  const latest = useRef(pull)
  latest.current = pull
  useEffect(() => {
    if (waitingFor === null) return
    return startQuickPull(() => latest.current())
  }, [waitingFor])
}
