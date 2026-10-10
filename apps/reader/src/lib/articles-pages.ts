/**
 * Discover's Articles pages after the first (ADR 0044), held for the visit outside React: Back to
 * Articles shows what "More" had brought. A store, not a page's own state, because a request
 * outlives the page that made it: one still out when the member leaves Articles lands while
 * another page shows it, which a state setter of the page that asked would never tell, and that
 * page would wait on it for ever. Every Articles page subscribes; any change tells them all.
 *
 * Kept by the first page's endpoint (`base`). `after` is the cursor the held pages carry on from:
 * a fresh first page that ends elsewhere starts them over, since they would no longer follow it.
 * `auto` counts the pages asked for without the member asking, at most `AUTO_PAGES`.
 */
import type { ArticlesData } from '../views/types'

export type HeldPages = { after: string; pages: ArticlesData[]; auto: number }

/** Pages a page asks for by itself when the member's blogs leave too few posts to read. */
export const AUTO_PAGES = 2

const held = new Map<string, HeldPages>()
const fetching = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version += 1
  for (const listener of listeners) listener()
}

/** For `useSyncExternalStore`: every Articles page hears each change. */
export function subscribeArticles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const articlesVersion = (): number => version

export const heldPages = (base: string): HeldPages | undefined => held.get(base)

export const fetchingMore = (base: string): boolean => fetching.has(base)

/**
 * Ask for the page after `from` (at `url`), for the first page of `base` that ends at `start`. One
 * request at a time per endpoint. A page is kept only where it carries on: what is held still
 * follows the same first page, and still ends at the cursor it was asked from. Settles once the
 * page is kept or refused; a failure keeps nothing, and the member may ask again.
 */
export function fetchMore(
  input: { base: string; start: string; from: string; auto: boolean; url: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { base, start, from, auto, url } = input
  if (fetching.has(base)) return Promise.resolve()
  const kept = held.get(base)
  const known = kept && kept.after === start ? kept : { after: start, pages: [], auto: 0 }
  if (auto && known.auto >= AUTO_PAGES) return Promise.resolve()
  held.set(base, { ...known, auto: known.auto + (auto ? 1 : 0) })
  fetching.add(base)
  changed()
  return fetcher(url, { credentials: 'same-origin' })
    .then((res) => (res.ok ? (res.json() as Promise<ArticlesData>) : null))
    .then((page) => {
      const now = held.get(base)
      if (!page || !now || now.after !== start) return
      // The held pages' end: the last one's next (none, once they reached the end), else `after`.
      const last = now.pages.at(-1)
      if ((last ? last.next : now.after) !== from) return
      held.set(base, { ...now, pages: [...now.pages, page] })
    })
    .catch(() => undefined)
    .finally(() => {
      fetching.delete(base)
      changed()
    })
}

/** Forget every held page, for tests. */
export function forgetArticlesPages(): void {
  held.clear()
  fetching.clear()
  changed()
}
