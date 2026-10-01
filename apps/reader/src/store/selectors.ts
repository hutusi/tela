/**
 * What the reading view asks of the local tables. Everything here is a pure function of the
 * tables and the clock, so a click is a function call, not a request (ADR 0025).
 *
 * Unread follows ADR 0009: an article is read once opened, once under its feed's watermark, or
 * once older than the 30-day horizon.
 */

import type { ArticleRow, SiteRow } from '@tela/sync'
import { HORIZON_DAYS, type Tables, titleKey } from '@tela/sync'
import type { Person } from '../views/types'

export type Filter = 'all' | 'today' | 'liked'
export const FILTERS: Filter[] = ['all', 'today', 'liked']
const DAY = 86_400_000

export function isRead(t: Tables, a: ArticleRow, now: number): boolean {
  if (t.states.get(a.id)?.readAt != null) return true
  const sub = t.subscriptions.get(a.feedId)
  if (sub && a.id <= sub.watermarkId) return true
  return a.fetchedAt < now - HORIZON_DAYS * DAY
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

/** What a feed is called: its own title, its blog's, or the blog's host. */
export function feedTitle(t: Tables, feedId: number): string {
  const feed = t.feeds.get(feedId)
  const site = feed ? t.sites.get(feed.siteId) : undefined
  return feed?.title ?? site?.title ?? (site ? host(site.homeUrl) : '')
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
function cached<T>(t: Tables, key: string, compute: () => T): T {
  let entries = memo.get(t)
  if (!entries) {
    entries = new Map()
    memo.set(t, entries)
  }
  if (!entries.has(key)) entries.set(key, compute())
  return entries.get(key) as T
}

/** The member's subscriptions, by title, each with its unread count. */
export function subscriptionItems(t: Tables, now: number): SubscriptionItem[] {
  return cached(t, `subs:${Math.floor(now / 60_000)}`, () => {
    const unread = new Map<number, number>()
    for (const a of t.articles.values()) {
      if (!isRead(t, a, now)) unread.set(a.feedId, (unread.get(a.feedId) ?? 0) + 1)
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
    return items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  })
}

export type Totals = { all: number; today: number; liked: number }

export function totals(t: Tables, now: number): Totals {
  return cached(t, `totals:${Math.floor(now / 60_000)}`, () => {
    let all = 0
    let today = 0
    let liked = 0
    for (const a of t.articles.values()) {
      if (isLiked(t, a.id)) liked++
      if (t.subscriptions.get(a.feedId)?.deletedAt !== null) continue
      if (isRead(t, a, now)) continue
      all++
      if (a.sortAt >= now - DAY) today++
    }
    return { all, today, liked }
  })
}

const newestFirst = (a: ArticleRow, b: ArticleRow) => b.sortAt - a.sortAt || b.id - a.id

/** The list for a filter or one feed, newest first. Liked spans every feed the member kept from. */
export function articlesFor(
  t: Tables,
  where: { filter: Filter; feedId: number | null },
  now: number,
): ArticleRow[] {
  return cached(t, `list:${where.filter}:${where.feedId}:${Math.floor(now / 60_000)}`, () => {
    const out: ArticleRow[] = []
    for (const a of t.articles.values()) {
      if (where.feedId !== null) {
        if (a.feedId === where.feedId) out.push(a)
        continue
      }
      if (where.filter === 'liked') {
        if (isLiked(t, a.id)) out.push(a)
        continue
      }
      if (t.subscriptions.get(a.feedId)?.deletedAt !== null) continue
      if (where.filter === 'today' && a.sortAt < now - DAY) continue
      out.push(a)
    }
    return out.sort(newestFirst)
  })
}

/**
 * A list with read posts hidden (a pref), keeping every post it has shown unread or open: `seen`
 * is the list's memory of those for this visit, and this adds the ones unread now and the open
 * one. So a post read since, opened or reached by `j`, stays where the reader left it, and so does
 * one opened already read (from a public page, before its row arrived); liked posts always stay.
 */
export function withoutRead(
  t: Tables,
  list: ArticleRow[],
  now: number,
  openId: number | null,
  seen: Set<number>,
): ArticleRow[] {
  for (const a of list) if (!isRead(t, a, now) || a.id === openId) seen.add(a.id)
  return list.filter((a) => seen.has(a.id) || isLiked(t, a.id))
}

/**
 * A post's title and excerpt as the member reads them: the translation whenever one exists,
 * except in a language the member never has translated (`never`, a pref), which reads as written.
 */
export function shownTitle(
  t: Tables,
  a: ArticleRow & { titles?: Partial<Record<string, string>> },
  readingLang: string,
  never: readonly string[] = [],
) {
  if (a.sourceLang !== null && never.includes(a.sourceLang)) {
    return { title: a.title, excerpt: a.excerpt, badge: false }
  }
  const translated = t.titles.get(titleKey(a.id, readingLang))
  // A post held from a public page, whose feed the device does not sync, brings the titles that
  // page showed: the reader opening it says what the link said.
  const title = translated?.title ?? a.titles?.[readingLang] ?? null
  return {
    title: title ?? a.title,
    excerpt: translated?.excerpt ?? a.excerpt,
    /** Badge it only when the languages differ and a translation is shown (AGENTS.md). */
    badge: title !== null && a.sourceLang !== null && a.sourceLang !== readingLang,
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
      ? { id: f.userId, handle: f.handle, displayName: f.displayName }
      : person(f.userId)
    if (known) people.push(known)
  }
  const name = (p: Person) => (p.displayName ?? p.handle).toLocaleLowerCase()
  return people.sort((a, b) => name(a).localeCompare(name(b)))
}
