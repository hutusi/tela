/**
 * Leaving an account (ADR 0025): the tab holds another account than the browser's session
 * (another tab signed in as someone else), or its stored copy was taken. It forgets what it holds
 * and starts again at '/' as whoever is signed in now, so nothing of the old account's (an open
 * article, a search) carries over; and it goes whether or not the forgetting worked.
 */
import { distrust } from './session'
import type { LocalStore } from './store/local'

export function leaver(deps: {
  stop(): void
  store: Pick<LocalStore, 'userId' | 'forgetAccount'>
  go(path: string): void
}): () => Promise<void> {
  let leaving: Promise<void> | null = null
  return () => {
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
}
