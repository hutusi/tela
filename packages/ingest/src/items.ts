import type { ParsedItem } from '@tela/content'

/**
 * Ceiling on items one fetch processes. A first fetch of a long archive, or a hostile feed of
 * thousands of tiny items, would otherwise become that many selects and transactions inside a
 * single job. Lists show the newest posts, so those are the ones kept.
 */
export const MAX_ITEMS_PER_FETCH = 200

/** The newest `limit` items: dated ones first, newest first; undated ones keep document order after them. */
export function selectItems(items: ParsedItem[], limit = MAX_ITEMS_PER_FETCH): ParsedItem[] {
  if (items.length <= limit) return items
  const indexed = items.map((item, i) => ({ item, i, at: item.publishedAt?.getTime() }))
  indexed.sort((a, b) => {
    if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return b.at - a.at
    if (a.at !== undefined && b.at === undefined) return -1
    if (a.at === undefined && b.at !== undefined) return 1
    return a.i - b.i
  })
  return indexed.slice(0, limit).map((x) => x.item)
}

/** A display title: the item's own, else the start of its excerpt, else a placeholder. */
export function titleFor(item: ParsedItem, excerpt: string): string {
  const t = item.title.replace(/\s+/g, ' ').trim()
  if (t) return t.slice(0, 500)
  if (excerpt) return excerpt.slice(0, 80)
  return 'Untitled'
}
