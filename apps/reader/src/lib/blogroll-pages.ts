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

export type HeldBlogrolls = { after: string; pages: BlogrollsData[] }

const held = new Map<string, HeldBlogrolls>()
const fetching = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

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
  return fetcher(url, { credentials: 'same-origin' })
    .then((res) => (res.ok ? (res.json() as Promise<BlogrollsData>) : null))
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

/** Forget every held page, for tests. */
export function forgetBlogrollsPages(): void {
  held.clear()
  fetching.clear()
  changed()
}
