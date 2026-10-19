/**
 * How many days ago, by the calendar the reader lives by: the one count every "today",
 * "yesterday", "3 days ago" in the app is worded from (a blogroll's byline, Settings' Latest post
 * column). The edge renders one cached page for everyone in UTC, and the app redraws it in the
 * reader's own zone on boot: a day apart only within their offset of midnight.
 */

const DAY = 86_400_000

/** Local midnight before `at`: where its calendar day begins, here. */
export function dayStart(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Whole calendar days from `at` to `now`: a post at 20:00 yesterday is a day ago at 08:00 today.
 * Rounded, since a day across a change of clocks is 23 or 25 hours. A date ahead of `now` (a
 * feed's clock, a server's) is today.
 */
export function daysAgo(at: number, now: number): number {
  return Math.round((dayStart(now) - dayStart(Math.min(at, now))) / DAY)
}
