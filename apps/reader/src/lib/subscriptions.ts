/**
 * Settings › Subscriptions as a manager (ADR 0049, Tela Lists): when each blog last posted, the
 * orders it can be listed in, what a filter matches, and which rows a click ticks. Pure, so the
 * page and its tests agree.
 */
import type { Tables } from '@tela/sync'
import { normalizeQuery } from './search'

const DAY = 86_400_000

/**
 * When each blog last posted: the later of what its feed listed when last fetched
 * (`lastItemAt`) and the newest post the device holds. The device's 30-day horizon alone cannot
 * say a blog went quiet ten months ago; the feed row can, once a tela-api that sends it has. A
 * blog neither knows of is absent.
 */
export function latestPosts(t: Pick<Tables, 'feeds' | 'articles'>): Map<number, number> {
  const latest = new Map<number, number>()
  const later = (feedId: number, at: number | null | undefined) => {
    if (at === null || at === undefined) return
    const was = latest.get(feedId)
    if (was === undefined || at > was) latest.set(feedId, at)
  }
  for (const f of t.feeds.values()) later(f.id, f.lastItemAt)
  for (const a of t.articles.values()) later(a.feedId, a.publishedAt ?? a.sortAt)
  return latest
}

/** Past this, a blog's latest post is shown muted: it has gone quiet (Tela Lists). */
export const QUIET_AFTER_MS = 60 * DAY

/** Local midnight before `at`: where its calendar day begins, here. */
function dayStart(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * How long ago `at` was, as the Latest post column says it: today, yesterday and days by the
 * calendar here (a post at 20:00 yesterday is yesterday at 08:00), then weeks, months and years,
 * in the reader's language ("2 weeks ago", "上个月", "il y a 3 mois"), with a capital where the
 * language has one. A date ahead of `now` (a feed's clock) is today.
 */
export function postedAgo(at: number, locale: string, now: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  // Rounded, since a day across a change of clocks is 23 or 25 hours.
  const days = Math.round((dayStart(now) - dayStart(Math.min(at, now))) / DAY)
  const said =
    days < 7
      ? rtf.format(-days, 'day')
      : days < 45
        ? rtf.format(-Math.round(days / 7), 'week')
        : days < 365
          ? rtf.format(-Math.max(2, Math.round(days / 30)), 'month')
          : rtf.format(-Math.round(days / 365), 'year')
  return said.charAt(0).toLocaleUpperCase(locale) + said.slice(1)
}

/** What a row is sorted and filtered by. */
export type Sortable = {
  title: string
  /** When it last posted (`latestPosts`), or null if nothing says. */
  latest: number | null
  /** Its feed is `dead`: its date is not a quiet blog's, and it reads "Not updating". */
  dead: boolean
}

export const SORTS = ['name', 'recent', 'quiet'] as const
export type SortKey = (typeof SORTS)[number]

const byName = (a: Sortable, b: Sortable) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })

/**
 * The orders Subscriptions lists blogs in: A to Z (as everywhere, by base letters), Recently
 * posted (newest first, those with no date last), and Quiet longest, which is what pruning wants:
 * a feed that no longer updates first, then a blog with no post at all, then the oldest. Ties go by
 * name.
 */
export function compareBy(key: SortKey): (a: Sortable, b: Sortable) => number {
  if (key === 'name') return byName
  if (key === 'recent') {
    return (a, b) =>
      (a.latest === null ? 1 : 0) - (b.latest === null ? 1 : 0) ||
      (b.latest ?? 0) - (a.latest ?? 0) ||
      byName(a, b)
  }
  const rank = (r: Sortable) => (r.dead ? 0 : r.latest === null ? 1 : 2)
  return (a, b) => rank(a) - rank(b) || (a.latest ?? 0) - (b.latest ?? 0) || byName(a, b)
}

/** Text as a filter compares it: no accents, one case. "Vélo" and "velo" are the same. */
export const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * Whether a blog is one "Filter by name or address" asks for: the query, as typed and folded, in
 * any of `fields` (its name, its address, its feed's), folded too. An empty query asks for all.
 */
export function matcher(
  query: string,
): (fields: readonly (string | null | undefined)[]) => boolean {
  const q = fold(normalizeQuery(query))
  if (q === '') return () => true
  return (fields) => fields.some((f) => f !== null && f !== undefined && fold(f).includes(q))
}

/** What a click on a row ticks, and where the next Shift-click's run starts. */
export type Ticks = { picked: ReadonlySet<number>; anchor: number | null }

export const NO_TICKS: Ticks = { picked: new Set(), anchor: null }

/**
 * A click on the row of blog `id` in Select mode: it toggles, and becomes where a run starts. With
 * Shift, every row shown from the last one clicked to it is ticked; with no such row shown (the
 * filter or the order changed since), it toggles as a click does.
 */
export function clickRow(
  ticks: Ticks,
  shown: readonly number[],
  id: number,
  shift: boolean,
): Ticks {
  const from = ticks.anchor === null ? -1 : shown.indexOf(ticks.anchor)
  const to = shown.indexOf(id)
  if (shift && from >= 0 && to >= 0) {
    const picked = new Set(ticks.picked)
    for (const each of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(each)
    return { picked, anchor: ticks.anchor }
  }
  const picked = new Set(ticks.picked)
  if (picked.has(id)) picked.delete(id)
  else picked.add(id)
  return { picked, anchor: id }
}

/** The box that ticks every row: none, some (`mixed`), or all of the rows shown. */
export function tickedState(picked: ReadonlySet<number>, shown: readonly number[]) {
  if (shown.length > 0 && shown.every((id) => picked.has(id))) return 'all' as const
  return picked.size > 0 ? ('some' as const) : ('none' as const)
}

/** That box pressed: with anything ticked it clears, as the design has it, else it ticks every row shown. */
export function toggleAll(picked: ReadonlySet<number>, shown: readonly number[]): Ticks {
  return picked.size > 0 ? NO_TICKS : { picked: new Set(shown), anchor: null }
}

/**
 * The ticks still standing: only blogs still followed. A blog unsubscribed elsewhere meanwhile is
 * no longer here to move, and must not be counted or moved.
 */
export function standing(picked: ReadonlySet<number>, followed: ReadonlySet<number>): number[] {
  return [...picked].filter((id) => followed.has(id))
}

/** How many ticked blogs the filter hides: an action takes them too, so the bar says so. */
export const hiddenTicks = (picked: readonly number[], shown: readonly number[]) => {
  const visible = new Set(shown)
  return picked.filter((id) => !visible.has(id)).length
}
