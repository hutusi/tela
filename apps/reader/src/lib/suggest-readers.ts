/**
 * Which readers Discover and Following suggest (ADR 0044, amending 0031), from what is already
 * public about them and, for a member, matched on the device against what is theirs: the posts
 * they liked or recommended, and the blogs they read. Each reader is suggested once, in the first
 * group that fits, and only from this pool: the readers tela-api names, at most a hundred.
 */
import type { Tables } from '@tela/sync'
import { shownTitle } from '../store/selectors'
import type { ReaderCandidate, ReaderPost, Reading } from '../views/types'
import { displayHost } from './format'

export type ReaderGroup = 'shared' | 'blogs' | 'early' | 'notes' | 'active'

/** The groups in the order they are tried and shown. */
export const READER_GROUPS: readonly ReaderGroup[] = ['shared', 'blogs', 'early', 'notes', 'active']

/** The groups a visitor can be shown: the rest need a member's own likes and blogs. */
export const PUBLIC_GROUPS: readonly ReaderGroup[] = ['early', 'notes', 'active']

export type ReaderReason =
  /** They recommended posts the member liked or recommended; the post's title when it is one. */
  | { kind: 'shared'; count: number; title: string | null }
  /** They recommend posts from the member's blogs (`recs`), else read the same ones (`reads`). */
  | { kind: 'blogs'; via: 'recs' | 'reads'; count: number; blog: string | null }
  | { kind: 'early'; post: ReaderPost; others: number }
  | { kind: 'notes'; withNote: number; recent: number }
  | { kind: 'active'; recent: number }

export type Suggestion = { person: ReaderCandidate; group: ReaderGroup; reason: ReaderReason }

/** What of the member's own the rule reads, all of it from the device. */
export type Mine = {
  /** The blogs they subscribe to, by site id. */
  sites: ReadonlySet<number>
  /** The posts they liked or recommended. */
  kept: ReadonlySet<number>
  /** Themselves and whom they follow, as the page opened: a follow keeps its card in place. */
  excluded: ReadonlySet<string>
  /** A kept post's title as the member reads it, if the device holds it. */
  titleOf(articleId: number): string | null
  /** A blog's name, if the device holds it. */
  blogOf(siteId: number): string | null
}

/**
 * The member's own side of the match. `excluded` is taken by the caller when its page opens (the
 * member's id and the keys of `tables.follows`), never re-read on each render.
 */
export function mineOf(tables: Tables, excluded: ReadonlySet<string>, reading: Reading): Mine {
  const sites = new Set<number>()
  for (const s of tables.subscriptions.values()) {
    if (s.deletedAt !== null) continue
    const feed = tables.feeds.get(s.feedId)
    if (feed) sites.add(feed.siteId)
  }
  const kept = new Set<number>()
  for (const s of tables.states.values()) if (s.likedAt !== null) kept.add(s.articleId)
  for (const r of tables.recommendations.values()) if (r.deletedAt === null) kept.add(r.articleId)
  return {
    sites,
    kept,
    excluded,
    titleOf(articleId) {
      const a = tables.articles.get(articleId)
      return a ? shownTitle(tables, a, reading.lang, reading.never).title : null
    },
    blogOf(siteId) {
      const s = tables.sites.get(siteId)
      return s ? (s.title ?? displayHost(s.homeUrl)) : null
    },
  }
}

/** Notes count as a habit from two, on at least half of the month's recommendations. */
const NOTES_MIN = 2

function placed(
  c: ReaderCandidate,
  mine: Mine | null,
): { reason: ReaderReason; score: number } | null {
  if (mine) {
    const shared = [...new Set(c.recs.map(([article]) => article))].filter((id) =>
      mine.kept.has(id),
    )
    if (shared.length > 0) {
      const title = shared.length === 1 ? mine.titleOf(shared[0] as number) : null
      return { reason: { kind: 'shared', count: shared.length, title }, score: shared.length }
    }
    const recommends = [...new Set(c.recs.map(([, site]) => site))].filter((id) =>
      mine.sites.has(id),
    )
    const reads = (c.sites ?? []).filter((id) => mine.sites.has(id))
    const via = recommends.length > 0 ? 'recs' : 'reads'
    const blogs = via === 'recs' ? recommends : reads
    if (blogs.length > 0) {
      const blog = blogs.length === 1 ? mine.blogOf(blogs[0] as number) : null
      return { reason: { kind: 'blogs', via, count: blogs.length, blog }, score: blogs.length }
    }
  }
  if (c.early) {
    return {
      reason: { kind: 'early', post: c.early, others: c.early.others },
      score: c.early.others,
    }
  }
  if (c.withNote >= NOTES_MIN && 2 * c.withNote >= c.recent) {
    return { reason: { kind: 'notes', withNote: c.withNote, recent: c.recent }, score: c.withNote }
  }
  if (c.recent >= 1) return { reason: { kind: 'active', recent: c.recent }, score: c.recent }
  return null
}

/**
 * The pool as suggestions: each reader once, in the first group that fits, the groups in
 * `READER_GROUPS` order and the strongest match first within each. `mine` null is a visitor, who
 * gets the public groups only.
 */
export function suggestReaders(pool: readonly ReaderCandidate[], mine: Mine | null): Suggestion[] {
  const scored: (Suggestion & { score: number })[] = []
  for (const person of pool) {
    if (mine?.excluded.has(person.id)) continue
    const p = placed(person, mine)
    if (p) scored.push({ person, group: p.reason.kind, reason: p.reason, score: p.score })
  }
  const rank = (g: ReaderGroup) => READER_GROUPS.indexOf(g)
  scored.sort(
    (a, b) =>
      rank(a.group) - rank(b.group) ||
      b.score - a.score ||
      b.person.total - a.person.total ||
      (a.person.handle < b.person.handle ? -1 : a.person.handle > b.person.handle ? 1 : 0),
  )
  return scored.map(({ score: _, ...s }) => s)
}
