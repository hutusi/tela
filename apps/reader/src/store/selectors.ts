/**
 * What the reading view asks of the local tables. Everything here is a pure function of the
 * tables and the clock, so a click is a function call, not a request (ADR 0025).
 *
 * Unread follows ADR 0009: an article is read once opened, once under its feed's watermark, or
 * once older than the 30-day horizon, unless the member marked it unread, which beats both until
 * they read it again. Everything that asks whether a post is read asks `isRead`.
 */

import type { ArticleRow, Mutation, SiteRow } from '@tela/sync'
import { applyMutation, HORIZON_DAYS, type Tables, titleKey, translationKey } from '@tela/sync'
import type { Person } from '../views/types'

export type Filter = 'all' | 'today' | 'liked'
export const FILTERS: Filter[] = ['all', 'today', 'liked']
const DAY = 86_400_000

/** Whether the member marked the post unread by hand, and has not read it since. */
export function isMarkedUnread(t: Tables, articleId: number): boolean {
  const s = t.states.get(articleId)
  return s !== undefined && s.readAt === null && s.readUpdatedAt != null
}

export function isRead(t: Tables, a: ArticleRow, now: number): boolean {
  return readIn(t, a, now)
}

/** `isRead`, recording in `span` the age it asked about, if it asked. */
function readIn(t: Tables, a: ArticleRow, now: number, span?: Span): boolean {
  if (t.states.get(a.id)?.readAt != null) return true
  if (isMarkedUnread(t, a.id)) return false
  const sub = t.subscriptions.get(a.feedId)
  if (sub && a.id <= sub.watermarkId) return true
  const horizon = a.fetchedAt + HORIZON_DAYS * DAY
  return span ? span.past(horizon) : now > horizon
}

/**
 * The stretch of time around the instant a list was computed at in which every question it asked
 * of the clock gets the same answer, so the list does too. The clock enters a list only as "is it
 * past this instant?": a post turns read by its age at its horizon, and leaves Today a day after
 * it was posted. Each answer stands until the clock crosses that instant, usually hours away,
 * where keying the lists on the minute recomputed every one of them over every post each minute,
 * idle or not (about 80 ms a minute on a device holding 2,700 posts).
 */
class Span {
  /** The answers hold for an instant after `from` and up to `until`, both instants asked about. */
  private from = Number.NEGATIVE_INFINITY
  private until = Number.POSITIVE_INFINITY
  constructor(readonly now: number) {}

  /** Whether `now` is past `instant`, and so whether a later or earlier clock answers alike. */
  past(instant: number): boolean {
    if (this.now > instant) {
      this.from = Math.max(this.from, instant)
      return true
    }
    this.until = Math.min(this.until, instant)
    return false
  }

  /** Whether every answer recorded is the same at `now`. */
  holds(now: number): boolean {
    return now > this.from && now <= this.until
  }

  /** Hold no longer than `other`: an answer computed from `other`'s answers. */
  within(other: Span): void {
    this.from = Math.max(this.from, other.from)
    this.until = Math.min(this.until, other.until)
  }
}

/**
 * Whether a post shows as read: the list's dot, the reader's Mark as read or Mark as unread, and
 * which of the two `m` sends all ask this, so they never disagree. The open post counts as read
 * before its markRead lands while opening reads (`markOnOpen`), but not once the member marks it
 * unread while it is open: opening read it, and that later choice stands until the next open.
 */
export function shownRead(
  t: Tables,
  a: ArticleRow,
  now: number,
  open: boolean,
  markOnOpen: boolean,
): boolean {
  return isRead(t, a, now) || (open && markOnOpen && !isMarkedUnread(t, a.id))
}

/**
 * The posts a mark-all-read turns from unread to read, as the server will apply it: every post
 * of a subscribed feed in its scope up to `upTo`, not only the rows a list showed. What its toast
 * counts, and what an Undo sent after the change has gone marks unread again.
 */
export function markAllReadCovers(
  t: Tables,
  m: Extract<Mutation, { type: 'markAllRead' }>,
  now: number,
): number[] {
  const after = applyMutation(t, m)
  const covered: number[] = []
  for (const a of t.articles.values()) {
    if (!isRead(t, a, now) && isRead(after, a, now)) covered.push(a.id)
  }
  return covered
}

type MarkAllRead = Omit<Extract<Mutation, { type: 'markAllRead' }>, 'mid' | 'at'>

/**
 * What Mark all read sends for a list other than Today (which reads its posts one by one): one
 * mark-all for its scope, one blog or every blog followed, or one per blog followed in a folder,
 * since the server knows nothing of folders (ADR 0048), taken from the tables as they are when
 * pressed. Each reaches `upTo`, the newest post the list showed, and comes with the posts it turns
 * read (`markAllReadCovers`); a post is in one feed, so those add up to what the press reads. One
 * that would read nothing is left out: a second press while the first one's Undo shows (sent
 * anyway, it would outlive that Undo), or a blog read already.
 */
export function markAllReadPlan(
  t: Tables,
  where: { feedId: number | null; folderId: string | null },
  upTo: number,
  at: number,
): { input: MarkAllRead; covered: number[] }[] {
  if (where.folderId === null) {
    const input: MarkAllRead = {
      type: 'markAllRead',
      upTo,
      ...(where.feedId ? { feedId: where.feedId } : {}),
    }
    const covered = markAllReadCovers(t, { ...input, mid: '', at }, at)
    return covered.length === 0 ? [] : [{ input, covered }]
  }
  // A folder's marks, each held to its own blog, are applied together and compared once, which
  // reads as one per blog would: a mark-all with a feed changes that feed's posts alone. One pass
  // over the posts, not one per blog, which on a folder of hundreds was most of the press.
  const inputs = feedsInFolder(t, where.folderId).map(
    (feedId): MarkAllRead => ({ type: 'markAllRead', upTo, feedId }),
  )
  let after = t
  for (const input of inputs) after = applyMutation(after, { ...input, mid: '', at })
  const covered = new Map<number, number[]>()
  for (const a of t.articles.values()) {
    if (!isRead(t, a, at) && isRead(after, a, at)) {
      covered.set(a.feedId, [...(covered.get(a.feedId) ?? []), a.id])
    }
  }
  return inputs.flatMap((input) => {
    const mine = covered.get(input.feedId ?? 0) ?? []
    return mine.length === 0 ? [] : [{ input, covered: mine }]
  })
}

export const isLiked = (t: Tables, articleId: number) => t.states.get(articleId)?.likedAt != null

export const isRecommended = (t: Tables, articleId: number) =>
  t.recommendations.get(articleId)?.deletedAt === null

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function siteOfFeed(t: Tables, feedId: number): SiteRow | undefined {
  const feed = t.feeds.get(feedId)
  return feed ? t.sites.get(feed.siteId) : undefined
}

/**
 * What a feed is called: its blog's name, which an editor may have set where the feed's own is a
 * placeholder ("feed - Thierry Crouzet"), and which no fetch rewrites as it rewrites the feed's;
 * the feed's own title when the device holds another feed of the same blog, so the two stay
 * apart; else the blog's host.
 */
export function feedTitle(t: Tables, feedId: number): string {
  const feed = t.feeds.get(feedId)
  const site = feed ? t.sites.get(feed.siteId) : undefined
  const sibling = feed !== undefined && (feedsOfSite(t.feeds).get(feed.siteId) ?? 0) > 1
  const name = sibling ? (feed?.title ?? site?.title) : (site?.title ?? feed?.title)
  return name ?? (site ? host(site.homeUrl) : '')
}

const siteCounts = new WeakMap<Tables['feeds'], Map<number, number>>()
/**
 * How many feeds the device holds of each blog, counted once per feeds table: a table is never
 * changed once a snapshot holds it (a change makes a new one), and every row of a list names its
 * feed, so scanning every feed per name made a list render quadratic.
 */
function feedsOfSite(feeds: Tables['feeds']): Map<number, number> {
  let counts = siteCounts.get(feeds)
  if (!counts) {
    counts = new Map()
    for (const f of feeds.values()) counts.set(f.siteId, (counts.get(f.siteId) ?? 0) + 1)
    siteCounts.set(feeds, counts)
  }
  return counts
}

export type SubscriptionItem = {
  feedId: number
  siteId: number | null
  title: string
  unread: number
  lastFetchedAt: number | null
  lastError: string | null
}

const memo = new WeakMap<Tables, Map<string, unknown>>()
/** One answer per tables object and key: the tables change identity whenever they change. */
export function cached<T>(t: Tables, key: string, compute: () => T): T {
  let entries = memo.get(t)
  if (!entries) {
    entries = new Map()
    memo.set(t, entries)
  }
  if (!entries.has(key)) entries.set(key, compute())
  return entries.get(key) as T
}

/**
 * `cached` for an answer that also depends on the clock: kept while the clock stays within the
 * span its computation recorded, computed again once it leaves it. A computation that reads
 * another such answer passes its own span as `outer`, which then holds no longer than that one.
 */
function cachedSpan<T>(
  t: Tables,
  key: string,
  now: number,
  compute: (span: Span) => T,
  outer?: Span,
): T {
  const entries = cached(t, 'spans', () => new Map<string, { value: unknown; span: Span }>())
  let entry = entries.get(key)
  if (!entry?.span.holds(now)) {
    const span = new Span(now)
    entry = { value: compute(span), span }
    entries.set(key, entry)
  }
  outer?.within(entry.span)
  return entry.value as T
}

/** The member's subscriptions, by title, each with its unread count. */
export function subscriptionItems(t: Tables, now: number): SubscriptionItem[] {
  return subscriptionItemsIn(t, now)
}

function subscriptionItemsIn(t: Tables, now: number, outer?: Span): SubscriptionItem[] {
  return cachedSpan(
    t,
    'subs',
    now,
    (span) => {
      const unread = new Map<number, number>()
      for (const a of t.articles.values()) {
        if (!readIn(t, a, now, span)) unread.set(a.feedId, (unread.get(a.feedId) ?? 0) + 1)
      }
      const items: SubscriptionItem[] = []
      for (const sub of t.subscriptions.values()) {
        if (sub.deletedAt !== null) continue
        const feed = t.feeds.get(sub.feedId)
        items.push({
          feedId: sub.feedId,
          siteId: feed?.siteId ?? null,
          title: feedTitle(t, sub.feedId) || '…',
          unread: unread.get(sub.feedId) ?? 0,
          lastFetchedAt: feed?.lastFetchedAt ?? null,
          lastError: feed?.lastError ?? null,
        })
      }
      return items.sort((a, b) => byName(a.title, b.title))
    },
    outer,
  )
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** A folder of the member's (ADR 0048), with the blogs in it they follow and their unread total. */
export type FolderItem = { id: string; name: string; unread: number; blogs: SubscriptionItem[] }

/**
 * The member's folders by name, each holding its subscriptions by title, then the subscriptions
 * in no folder (ADR 0048). A folder with no blog followed in it is still a folder: it is listed,
 * empty.
 */
export function folderTree(
  t: Tables,
  now: number,
): { folders: FolderItem[]; unfiled: SubscriptionItem[] } {
  return cachedSpan(t, 'folders', now, (span) => {
    const folders = new Map<string, FolderItem>()
    for (const f of t.folders.values()) {
      folders.set(f.id, { id: f.id, name: f.name, unread: 0, blogs: [] })
    }
    const unfiled: SubscriptionItem[] = []
    for (const item of subscriptionItemsIn(t, now, span)) {
      const folder = folders.get(folderIdOf(t, item.feedId) ?? '')
      if (!folder) {
        unfiled.push(item)
        continue
      }
      folder.blogs.push(item)
      folder.unread += item.unread
    }
    return { folders: [...folders.values()].sort((a, b) => byName(a.name, b.name)), unfiled }
  })
}

/** The live folder a blog is in, or null: one deleted, or never held, is none. */
export function folderIdOf(t: Tables, feedId: number): string | null {
  const id = t.feedFolders.get(feedId)?.folderId ?? null
  return id !== null && t.folders.has(id) ? id : null
}

/** The feeds in a folder that the member follows. */
export function feedsInFolder(t: Tables, folderId: string): number[] {
  const out: number[] = []
  for (const sub of t.subscriptions.values()) {
    if (sub.deletedAt === null && folderIdOf(t, sub.feedId) === folderId) out.push(sub.feedId)
  }
  return out
}

export type Totals = { all: number; today: number; liked: number }

export function totals(t: Tables, now: number): Totals {
  return cachedSpan(t, 'totals', now, (span) => {
    let all = 0
    let today = 0
    let liked = 0
    for (const a of t.articles.values()) {
      if (isLiked(t, a.id)) liked++
      if (t.subscriptions.get(a.feedId)?.deletedAt !== null) continue
      if (readIn(t, a, now, span)) continue
      all++
      if (!span.past(a.sortAt + DAY)) today++
    }
    return { all, today, liked }
  })
}

const newestFirst = (a: ArticleRow, b: ArticleRow) => b.sortAt - a.sortAt || b.id - a.id

/**
 * The list for a filter, one feed or a folder, newest first. Liked spans every feed the member
 * kept from; a folder, the feeds followed in it (ADR 0048), so one gone or left lists nothing.
 */
export function articlesFor(
  t: Tables,
  where: { filter: Filter; feedId: number | null; folderId?: string | null },
  now: number,
): ArticleRow[] {
  const folderId = where.folderId ?? null
  const key = `list:${where.filter}:${where.feedId}:${folderId}`
  return cachedSpan(t, key, now, (span) => {
    const out: ArticleRow[] = []
    const inFolder = folderId === null ? null : new Set(feedsInFolder(t, folderId))
    for (const a of t.articles.values()) {
      if (inFolder !== null) {
        if (inFolder.has(a.feedId)) out.push(a)
        continue
      }
      if (where.feedId !== null) {
        if (a.feedId === where.feedId) out.push(a)
        continue
      }
      if (where.filter === 'liked') {
        if (isLiked(t, a.id)) out.push(a)
        continue
      }
      if (t.subscriptions.get(a.feedId)?.deletedAt !== null) continue
      if (where.filter === 'today' && span.past(a.sortAt + DAY)) continue
      out.push(a)
    }
    return out.sort(newestFirst)
  })
}

export type PrefetchPlan = { bodies: string[]; translations: string[] }

/**
 * What the idle prefetch would fetch (ADR 0025): the unread bodies, the list on screen first, then
 * every other feed's; and, when translations open on their own, the finished ones of unread posts
 * in the reading language, none in a language the member reads as written. A read post's
 * translation is rarely opened again, and on a device that keeps a month of posts it was most of
 * what the prefetch downloaded. The reading page keys its timer on this, so a render that changes
 * none of it (an empty pull, the minute's tick) neither puts a prefetch off nor cancels one under
 * way.
 */
export function prefetchPlan(
  t: Tables,
  list: readonly ArticleRow[],
  now: number,
  readingLang: string,
  prefs: { autoTranslate: boolean; never: readonly string[] },
): PrefetchPlan {
  const everything = articlesFor(t, { filter: 'all', feedId: null }, now)
  const bodies = new Set<string>()
  for (const a of [...list, ...everything]) {
    if (a.contentKey && !isRead(t, a, now)) bodies.add(a.contentKey)
  }
  const translations: string[] = []
  if (prefs.autoTranslate) {
    for (const a of everything) {
      if (!a.contentKey || (a.sourceLang !== null && prefs.never.includes(a.sourceLang))) continue
      if (isRead(t, a, now)) continue
      const row = t.translations.get(translationKey(a.contentKey, readingLang))
      if (row?.objectKey && (row.state === 'done' || row.state === 'partial')) {
        translations.push(row.objectKey)
      }
    }
  }
  return { bodies: [...bodies], translations }
}

/**
 * Whether a prefetch run for `running` fetches everything `next` would: then it goes on rather
 * than starting over. Opening a post reads it, which takes it out of the plan, and a run cancelled
 * at every open never got past the first bundle while the member stepped through a list.
 */
export function prefetchCovers(running: PrefetchPlan, next: PrefetchPlan): boolean {
  const bodies = new Set(running.bodies)
  const translations = new Set(running.translations)
  return (
    next.bodies.every((k) => bodies.has(k)) && next.translations.every((k) => translations.has(k))
  )
}

/**
 * A list showing unread posts only (the list's Unread / All switch), keeping every post it has
 * shown unread or open: `seen` is the list's memory of those for this visit, and this adds the
 * ones unread now and the open one. So a post read since, opened or reached by `j`, stays where
 * the reader left it, and so does one opened already read (from a public page, before its row
 * arrived). A liked post is read like any other: Liked is its own list, and shows everything.
 */
export function withoutRead(
  t: Tables,
  list: ArticleRow[],
  now: number,
  openId: number | null,
  seen: Set<number>,
): ArticleRow[] {
  for (const a of list) if (!isRead(t, a, now) || a.id === openId) seen.add(a.id)
  return list.filter((a) => seen.has(a.id))
}

/**
 * A post's title and excerpt as the member reads them: the translation whenever one exists,
 * except in a language the member never has translated (`never`, a pref), which reads as written.
 * Each comes with the language it is in, for its element's `lang`: without one, Traditional
 * Chinese takes the page's Simplified glyph forms (or the other way round), and a screen reader
 * reads Chinese in an English voice. Undefined where the post's language is not known.
 */
export function shownTitle(
  t: Tables,
  a: ArticleRow & { titles?: Partial<Record<string, string>> },
  readingLang: string,
  never: readonly string[] = [],
): {
  title: string
  excerpt: string | null
  badge: boolean
  lang: string | undefined
  excerptLang: string | undefined
} {
  const source = a.sourceLang ?? undefined
  if (source !== undefined && never.includes(source)) {
    return { title: a.title, excerpt: a.excerpt, badge: false, lang: source, excerptLang: source }
  }
  const translated = t.titles.get(titleKey(a.id, readingLang))
  // A post held from a public page, whose feed the device does not sync, brings the titles that
  // page showed: the reader opening it says what the link said.
  const title = translated?.title ?? a.titles?.[readingLang] ?? null
  const excerpt = translated?.excerpt ?? null
  return {
    title: title ?? a.title,
    excerpt: excerpt ?? a.excerpt,
    /** Badge it only when the languages differ and a translation is shown (AGENTS.md). */
    badge: title !== null && source !== undefined && source !== readingLang,
    lang: title !== null ? readingLang : source,
    excerptLang: excerpt !== null ? readingLang : source,
  }
}

/**
 * The people the member follows, named: by the follow row once the pull brought it, else by the
 * page they were followed from (a prediction has only the id). Alphabetical, as a list of people
 * reads best.
 */
export function followedPeople(t: Tables, person: (id: string) => Person | undefined): Person[] {
  const people: Person[] = []
  for (const f of t.follows.values()) {
    const known = f.handle
      ? { id: f.userId, handle: f.handle, displayName: f.displayName, avatar: f.avatar ?? null }
      : person(f.userId)
    if (known) people.push(known)
  }
  const name = (p: Person) => (p.displayName ?? p.handle).toLocaleLowerCase()
  return people.sort((a, b) => name(a).localeCompare(name(b)))
}
