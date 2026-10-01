/**
 * The Following feed's pages as the device keeps them for a visit (ADR 0031). The server pages
 * newest first by (time, key); these keep what the device holds consistent with what it asks.
 */

type Entry = { key: string; at: number }
export type FeedPageOf<T extends Entry> = { items: T[]; next: string | null }

/** Whether `a` comes before `b` in the feed: newer, or as new with a larger key (the server's order). */
const before = (a: Entry, b: Entry) => a.at > b.at || (a.at === b.at && a.key > b.key)

/**
 * A fresh first page over the pages held. The fresh entries replace the held ones (a day's likes
 * may have grown, a note changed), and the older pages the member had loaded stay when they carry
 * on from where the fresh page ends. Only the fresh page is kept when the held list does not reach
 * back that far (there would be a gap), or when the fresh page's range no longer holds what it did:
 * an entry gone from it (a day's group an unlike moved down, or one removed), or one new inside the
 * span already held rather than above it (a followee who began to show their likes shows them at
 * the times they were made). The held pages past that point were fetched before the change and do
 * not have it, and keeping them would hide it for the visit. Only the fresh page can be checked:
 * an entry that appears further down, older than all of it, stays out of the held pages until the
 * next visit (ADR 0031).
 */
export function mergeFirstPage<T extends Entry>(
  held: FeedPageOf<T> | null,
  fresh: FeedPageOf<T>,
): FeedPageOf<T> {
  const last = fresh.items.at(-1)
  const head = held?.items[0]
  if (!held || !last || !head || fresh.next === null || before(last, head)) return fresh
  const seen = new Set(fresh.items.map((i) => i.key))
  if (held.items.some((i) => !before(last, i) && !seen.has(i.key))) return fresh
  const had = new Set(held.items.map((i) => i.key))
  if (fresh.items.some((i) => !had.has(i.key) && before(head, i))) return fresh
  const older = held.items.filter((i) => !seen.has(i.key) && before(last, i))
  return older.length === 0 ? fresh : { items: [...fresh.items, ...older], next: held.next }
}

/**
 * An older page after the ones held, without an entry they already have: a day's group is placed
 * at its newest event, so a like or an unlike between two requests can move it past the cursor.
 */
export function appendPage<T extends Entry>(
  held: FeedPageOf<T>,
  page: FeedPageOf<T>,
): FeedPageOf<T> {
  const seen = new Set(held.items.map((i) => i.key))
  return { items: [...held.items, ...page.items.filter((i) => !seen.has(i.key))], next: page.next }
}
