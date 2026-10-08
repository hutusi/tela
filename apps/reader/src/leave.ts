/**
 * Leaving an account (ADR 0025): the tab holds another account than the browser's session
 * (another tab signed in as someone else), or its stored copy was taken. It forgets what it holds
 * and starts again at '/' as whoever is signed in now, so nothing of the old account's (an open
 * article, a search) carries over; and it goes whether or not the forgetting worked.
 */
import { distrust } from './session'
import type { LocalStore } from './store/local'

/** Holds on leaving that sign-ins in this tab have open, and the leave one of them kept. */
let holds = 0
let kept: (() => void) | null = null

/**
 * A sign-in in this tab is changing whose session it is, and settles the tab itself once it has
 * (`signedIn`): until then, an account_changed that its own new cookie draws from a call naming
 * the old account (the sync engine's pull, a page's RPC) is its news, not another tab's. Left to
 * leave, it sent the tab to '/' while a joiner's password was still being saved, which the
 * navigation cancelled (ADR 0043). A leave asked for meanwhile is kept. Releasing with `replay`
 * makes it then, when the sign-in failed or did not settle the tab; without, it is dropped, the
 * sign-in having loaded a fresh page as the new member already.
 */
export function holdLeaving(): (replay: boolean) => void {
  holds += 1
  let released = false
  return (replay) => {
    if (released) return
    released = true
    holds -= 1
    if (holds > 0) return
    const leave = kept
    kept = null
    if (replay) leave?.()
  }
}

export function leaver(deps: {
  stop(): void
  store: Pick<LocalStore, 'userId' | 'forgetAccount'>
  go(path: string): void
}): () => Promise<void> {
  let leaving: Promise<void> | null = null
  const leave = (): Promise<void> => {
    if (holds > 0) {
      kept = () => void leave()
      return Promise.resolve()
    }
    if (leaving) return leaving
    deps.stop()
    const stale = deps.store.userId
    leaving = deps.store
      .forgetAccount()
      // Not forgotten (storage failed): the next boot must not trust that copy again, or it would
      // show the stale account, be refused, and come back here for ever.
      .catch(() => {
        if (stale !== null) distrust(stale)
      })
      .then(() => deps.go('/'))
    return leaving
  }
  return leave
}
