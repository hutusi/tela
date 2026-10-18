/**
 * Discover's Blogrolls pages after the first (ADR 0050), held for the visit outside React, as
 * Articles' are (`articles-pages.ts`, which says why a store and not a page's state): Back to the
 * tab shows what "More" had brought, and a request still out when the member leaves lands where
 * the next Blogrolls page hears it.
 *
 * Kept by the first page's endpoint (`base`). `after` is the cursor the held pages carry on from:
 * a fresh first page that ends elsewhere starts them over, since they would no longer follow it.
 * Nothing on the tab is left out for the member, so a page is never asked for unasked.
 */
import type { BlogrollsData } from '../views/types'
import { BLOGROLLS_PATH } from './blogroll-href'
import { forgetPublic } from './use-public'

export type HeldBlogrolls = { after: string; pages: BlogrollsData[] }

const held = new Map<string, HeldBlogrolls>()
const fetching = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
/** Moved on when the pages are forgotten: an answer to a request made before lands nowhere. */
let generation = 0
/**
 * Whether the pages were forgotten this visit: More then asks past the browser's copy, as
 * `usePublic` asks for the first page, or it could bring back the very page just forgotten.
 */
let forgotten = false

function changed() {
  version += 1
  for (const listener of listeners) listener()
}

/** For `useSyncExternalStore`: every Blogrolls page hears each change. */
export function subscribeBlogrolls(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const blogrollsVersion = (): number => version

export const heldBlogrolls = (base: string): HeldBlogrolls | undefined => held.get(base)

export const fetchingBlogrolls = (base: string): boolean => fetching.has(base)

/**
 * Ask for the page after `from` (at `url`), for the first page of `base` that ends at `start`. One
 * request at a time per endpoint. A page is kept only where it carries on: what is held still
 * follows the same first page, and still ends at the cursor it was asked from. Settles once the
 * page is kept or refused; a failure keeps nothing, and the member may ask again.
 */
export function fetchMoreBlogrolls(
  input: { base: string; start: string; from: string; url: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { base, start, from, url } = input
  if (fetching.has(base)) return Promise.resolve()
  const kept = held.get(base)
  held.set(base, kept && kept.after === start ? kept : { after: start, pages: [] })
  fetching.add(base)
  changed()
  const asked = generation
  return fetcher(url, { credentials: 'same-origin', ...(forgotten ? { cache: 'reload' } : {}) })
    .then((res) => (res.ok ? (res.json() as Promise<BlogrollsData>) : null))
    .then((page) => {
      const now = held.get(base)
      if (!page || !now || now.after !== start || asked !== generation) return
      // The held pages' end: the last one's next (none, once they reached the end), else `after`.
      const last = now.pages.at(-1)
      if ((last ? last.next : now.after) !== from) return
      held.set(base, { ...now, pages: [...now.pages, page] })
    })
    .catch(() => undefined)
    .finally(() => {
      // Forgotten meanwhile: what is fetching now is a request made since, not this one.
      if (asked !== generation) return
      fetching.delete(base)
      changed()
    })
}

/**
 * The cards the pages show, each once, where it first comes. Pages are cut by a key that never
 * moves (`publicSince`, id), so none should repeat; the list is keyed by id all the same, and
 * pages cached minutes apart are not one answer.
 */
export function blogrollsList(pages: readonly BlogrollsData[]): BlogrollsData['blogrolls'] {
  const seen = new Set<string>()
  const out: BlogrollsData['blogrolls'] = []
  for (const page of pages) {
    for (const card of page.blogrolls ?? []) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      out.push(card)
    }
  }
  return out
}

function dropPages(): void {
  generation += 1
  held.clear()
  fetching.clear()
  changed()
}

/**
 * Forget Discover's Blogrolls once one of the member's own has changed (`useForgetBlogrolls`): the
 * first page, through `forgetPublic`, and every page More brought after it. Those are held here,
 * not by `usePublic`, and a fresh first page that still ends where it did carries on into them, so
 * a card edited, made private or deleted on a later page would stay as it was, on this visit's
 * every return to the tab (Codex's review). The list goes back to its first page, and More
 * brings the rest again.
 */
export function forgetDiscoverBlogrolls(): void {
  forgotten = true
  dropPages()
  forgetPublic(BLOGROLLS_PATH)
}

/** Forget every held page, and that any was forgotten, for tests. */
export function resetBlogrollsPages(): void {
  forgotten = false
  dropPages()
}
