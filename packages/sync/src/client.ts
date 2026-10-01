/**
 * The client half of the sync protocol (ADR 0025): pure functions over the rows a device holds.
 *
 * - `applyPull` folds a pull into the **confirmed** tables: what the server has said.
 * - `applyMutation` predicts a mutation's effect, the way the server will apply it.
 * - `view` is confirmed ⊕ pending: the confirmed tables with every mutation not yet confirmed
 *   replayed on top, in order. The UI only ever renders this.
 * - `settle` drops pending mutations the server has both acknowledged and sent back: acknowledged
 *   at seq N, a pull that reaches N holds their effect, so replaying them adds nothing and
 *   dropping them changes nothing on screen.
 *
 * No I/O here, so the rules can be tested on their own and shared with anything that syncs.
 */
import type { Mutation } from './mutations'
import type { PullResponse } from './protocol'
import type {
  ArticleRow,
  ClaimRow,
  FeedRow,
  FollowRow,
  HighlightRow,
  PrefRow,
  ProfileRow,
  RecommendationRow,
  SiteRow,
  StateRow,
  SubscriptionRow,
  TitleRow,
  TranslationRow,
} from './rows'

export type Tables = {
  profile: ProfileRow | null
  prefs: Map<string, PrefRow>
  /** By feed id. */
  subscriptions: Map<number, SubscriptionRow>
  feeds: Map<number, FeedRow>
  sites: Map<number, SiteRow>
  articles: Map<number, ArticleRow>
  /** By `${articleId}:${lang}`. */
  titles: Map<string, TitleRow>
  /** By article id: the member's own read and like state. */
  states: Map<number, StateRow>
  /** By article id: the member's own recommendations. */
  recommendations: Map<number, RecommendationRow>
  /** By id: the member's live highlights (a deleted one is not held). */
  highlights: Map<string, HighlightRow>
  claims: Map<number, ClaimRow>
  /** By `${contentKey}:${lang}`. */
  translations: Map<string, TranslationRow>
  /** By the followed member's id: the people the member follows (an unfollowed one is not held). */
  follows: Map<string, FollowRow>
}

export type Confirmed = { cursor: number; tables: Tables }

/** A mutation the device made, and where the server has got to with it. */
export type Pending = {
  mutation: Mutation
  /** Set once a push was answered: the head seq after it was applied (or found applied). */
  ackedAt?: number
}

export const emptyTables = (): Tables => ({
  profile: null,
  prefs: new Map(),
  subscriptions: new Map(),
  feeds: new Map(),
  sites: new Map(),
  articles: new Map(),
  titles: new Map(),
  states: new Map(),
  recommendations: new Map(),
  highlights: new Map(),
  claims: new Map(),
  translations: new Map(),
  follows: new Map(),
})

export const titleKey = (articleId: number, lang: string) => `${articleId}:${lang}`
export const translationKey = (contentKey: string, lang: string) => `${contentKey}:${lang}`

/** A shallow copy whose maps can be changed without touching the original. */
function copy(tables: Tables): Tables {
  return {
    profile: tables.profile,
    prefs: new Map(tables.prefs),
    subscriptions: new Map(tables.subscriptions),
    feeds: new Map(tables.feeds),
    sites: new Map(tables.sites),
    articles: new Map(tables.articles),
    titles: new Map(tables.titles),
    states: new Map(tables.states),
    recommendations: new Map(tables.recommendations),
    highlights: new Map(tables.highlights),
    claims: new Map(tables.claims),
    translations: new Map(tables.translations),
    follows: new Map(tables.follows),
  }
}

/**
 * Fold a pull into the confirmed tables. Rows replace what is held under their key. Then the
 * device keeps only what it can show: an article stays while its feed is subscribed or the
 * member keeps it (liked, recommended or highlighted); the server sends a kept article back whole
 * the moment it becomes kept again.
 */
export function applyPull(confirmed: Confirmed, pull: PullResponse): Confirmed {
  const t = pull.reset ? emptyTables() : copy(confirmed.tables)
  const r = pull.rows
  for (const row of r.profile) t.profile = row
  for (const row of r.prefs) t.prefs.set(row.key, row)
  for (const row of r.feeds) t.feeds.set(row.id, row)
  for (const row of r.sites) t.sites.set(row.id, row)
  for (const row of r.articles) t.articles.set(row.id, row)
  for (const row of r.titles) t.titles.set(titleKey(row.articleId, row.lang), row)
  for (const row of r.states) t.states.set(row.articleId, row)
  for (const row of r.recommendations) t.recommendations.set(row.articleId, row)
  for (const row of r.highlights) {
    if (row.deletedAt === null) t.highlights.set(row.id, row)
    else t.highlights.delete(row.id)
  }
  for (const row of r.claims) t.claims.set(row.id, row)
  for (const row of r.translations)
    t.translations.set(translationKey(row.contentKey, row.lang), row)
  for (const row of r.subscriptions) t.subscriptions.set(row.feedId, row)
  for (const row of r.follows) {
    if (row.deletedAt === null) t.follows.set(row.userId, row)
    else t.follows.delete(row.userId)
  }
  for (const stone of pull.tombstones) {
    if (stone.entity === 'article') t.articles.delete(Number(stone.key))
  }
  prune(t)
  return { cursor: pull.cursor, tables: t }
}

/**
 * Whether the member keeps an article whatever they subscribe to: liked, recommended or
 * highlighted. `highlighted` is the set of articles with a live highlight, built once per prune.
 */
const isKept = (t: Tables, articleId: number, highlighted: Set<number>) =>
  t.states.get(articleId)?.likedAt != null ||
  t.recommendations.get(articleId)?.deletedAt === null ||
  highlighted.has(articleId)

/** Forget articles of feeds the member no longer follows, except the ones they keep. */
function prune(t: Tables, onlyFeed?: number) {
  const highlighted = new Set([...t.highlights.values()].map((h) => h.articleId))
  for (const [id, article] of t.articles) {
    if (onlyFeed !== undefined && article.feedId !== onlyFeed) continue
    if (t.subscriptions.get(article.feedId)?.deletedAt === null) continue
    if (isKept(t, id, highlighted)) continue
    t.articles.delete(id)
    t.states.delete(id)
    for (const key of t.titles.keys()) if (key.startsWith(`${id}:`)) t.titles.delete(key)
  }
}

/** A read state the member has not touched yet. */
const blankState = (articleId: number): StateRow => ({
  articleId,
  readAt: null,
  likedAt: null,
  likedUpdatedAt: null,
  seq: 0,
})

/**
 * Predict one mutation, as the server will apply it (`apps/api/src/sync/push.ts`). Same rules:
 * read is set once; likes, recommendations and prefs go to the later `at`; a watermark never
 * moves backwards. Counts move with the member's own change, which is all a device can know.
 */
export function applyMutation(tables: Tables, m: Mutation): Tables {
  const t = copy(tables)
  switch (m.type) {
    case 'markRead': {
      const s = t.states.get(m.articleId) ?? blankState(m.articleId)
      if (s.readAt === null) t.states.set(m.articleId, { ...s, readAt: m.at })
      return t
    }
    case 'setLiked': {
      const s = t.states.get(m.articleId) ?? blankState(m.articleId)
      if (s.likedUpdatedAt !== null && m.at <= s.likedUpdatedAt) return t
      const wasLiked = s.likedAt !== null
      t.states.set(m.articleId, {
        ...s,
        likedAt: m.liked ? m.at : null,
        likedUpdatedAt: m.at,
        readAt: s.readAt ?? m.at,
      })
      const article = t.articles.get(m.articleId)
      if (article && wasLiked !== m.liked) {
        t.articles.set(m.articleId, {
          ...article,
          likeCount: Math.max(0, article.likeCount + (m.liked ? 1 : -1)),
        })
      }
      return t
    }
    case 'markAllRead': {
      for (const [feedId, sub] of t.subscriptions) {
        if (sub.deletedAt !== null) continue
        if (m.feedId !== undefined && feedId !== m.feedId) continue
        let newest = 0
        for (const a of t.articles.values()) if (a.feedId === feedId && a.id > newest) newest = a.id
        const target = Math.min(m.upTo, newest)
        if (target > sub.watermarkId) t.subscriptions.set(feedId, { ...sub, watermarkId: target })
      }
      return t
    }
    case 'subscribe': {
      const sub = t.subscriptions.get(m.feedId)
      if (!sub) {
        t.subscriptions.set(m.feedId, {
          feedId: m.feedId,
          watermarkId: 0,
          createdAt: m.at,
          deletedAt: null,
          seq: 0,
        })
      } else if (sub.deletedAt !== null) {
        t.subscriptions.set(m.feedId, { ...sub, deletedAt: null })
      }
      return t
    }
    case 'unsubscribe': {
      const sub = t.subscriptions.get(m.feedId)
      if (sub && sub.deletedAt === null) {
        t.subscriptions.set(m.feedId, { ...sub, deletedAt: m.at })
        prune(t, m.feedId)
      }
      return t
    }
    case 'setPref': {
      const held = t.prefs.get(m.key)
      if (!held || m.at >= held.updatedAt) {
        t.prefs.set(m.key, { key: m.key, value: m.value, updatedAt: m.at, seq: held?.seq ?? 0 })
      }
      return t
    }
    case 'setProfile': {
      if (t.profile) {
        t.profile = {
          ...t.profile,
          ...(m.readingLang ? { readingLang: m.readingLang } : {}),
          ...(m.uiLocale ? { uiLocale: m.uiLocale } : {}),
        }
      }
      return t
    }
    case 'setPrivacy': {
      // In order, as this device made them; the server decides between devices by `at`, and its
      // row replaces this one with the next pull. Booleans: `false` is a value, not an absence.
      if (t.profile) {
        t.profile = {
          ...t.profile,
          ...(m.publicSubscriptions !== undefined
            ? { publicSubscriptions: m.publicSubscriptions }
            : {}),
          ...(m.publicLikes !== undefined ? { publicLikes: m.publicLikes } : {}),
        }
      }
      return t
    }
    case 'recommend': {
      // The server also decides by the later `at`, which this row does not carry; a concurrent
      // device's different answer arrives with the next pull, and confirmed rows always win.
      const held = t.recommendations.get(m.articleId)
      const was = held !== undefined && held.deletedAt === null
      t.recommendations.set(m.articleId, {
        articleId: m.articleId,
        note: m.note?.trim() || null,
        createdAt: held?.createdAt ?? m.at,
        deletedAt: null,
        seq: held?.seq ?? 0,
      })
      bumpRecommend(t, m.articleId, was ? 0 : 1)
      return t
    }
    case 'unrecommend': {
      const held = t.recommendations.get(m.articleId)
      if (!held || held.deletedAt !== null) return t
      t.recommendations.set(m.articleId, { ...held, deletedAt: m.at })
      bumpRecommend(t, m.articleId, -1)
      return t
    }
    case 'putHighlight': {
      const held = t.highlights.get(m.id)
      if (held && m.at < held.updatedAt) return t
      t.highlights.set(m.id, {
        id: m.id,
        articleId: held?.articleId ?? m.articleId,
        contentKey: m.contentKey,
        side: m.side,
        lang: m.lang,
        leafId: m.leafId,
        start: m.start,
        end: m.end,
        quote: m.quote,
        prefix: m.prefix,
        suffix: m.suffix,
        note: m.note?.trim() || null,
        createdAt: held?.createdAt ?? m.at,
        updatedAt: m.at,
        deletedAt: null,
        seq: held?.seq ?? 0,
      })
      return t
    }
    case 'deleteHighlight': {
      t.highlights.delete(m.id)
      return t
    }
    case 'follow': {
      // Who they are arrives with the pull; until then the row has only their id, and the page
      // that followed them knows the rest. (The server ignores a self-follow; no page offers one.)
      if (t.follows.has(m.userId)) return t
      t.follows.set(m.userId, {
        userId: m.userId,
        handle: null,
        displayName: null,
        createdAt: m.at,
        deletedAt: null,
        seq: 0,
      })
      return t
    }
    case 'unfollow': {
      t.follows.delete(m.userId)
      return t
    }
  }
}

function bumpRecommend(t: Tables, articleId: number, delta: number) {
  const article = t.articles.get(articleId)
  if (article && delta !== 0) {
    t.articles.set(articleId, {
      ...article,
      recommendCount: Math.max(0, article.recommendCount + delta),
    })
  }
}

/** What the device shows: the confirmed tables with every pending mutation replayed on top. */
export function view(confirmed: Confirmed, pending: readonly Pending[]): Tables {
  let t = confirmed.tables
  for (const p of pending) t = applyMutation(t, p.mutation)
  return t
}

/**
 * Drop the pending mutations the confirmed tables already hold: acknowledged by a push, and
 * reached by a pull. One acknowledged later than the cursor stays, or the screen would show it
 * undone until the next pull.
 */
export function settle(confirmed: Confirmed, pending: readonly Pending[]): Pending[] {
  return pending.filter((p) => p.ackedAt === undefined || p.ackedAt > confirmed.cursor)
}

/** The tables as plain arrays, to persist or compare. */
export function rowsOf(tables: Tables) {
  return {
    profile: tables.profile,
    prefs: [...tables.prefs.values()],
    subscriptions: [...tables.subscriptions.values()],
    feeds: [...tables.feeds.values()],
    sites: [...tables.sites.values()],
    articles: [...tables.articles.values()],
    titles: [...tables.titles.values()],
    states: [...tables.states.values()],
    recommendations: [...tables.recommendations.values()],
    highlights: [...tables.highlights.values()],
    claims: [...tables.claims.values()],
    translations: [...tables.translations.values()],
    follows: [...tables.follows.values()],
  }
}

export type {
  ArticleRow,
  ClaimRow,
  FeedRow,
  FollowRow,
  HighlightRow,
  SiteRow,
  SubscriptionRow,
  TitleRow,
  TranslationRow,
}

export type TableRows = ReturnType<typeof rowsOf>

/** The inverse of `rowsOf`: tables back from what was persisted. */
export function tablesFromRows(rows: TableRows): Tables {
  return {
    profile: rows.profile,
    prefs: new Map(rows.prefs.map((r) => [r.key, r])),
    subscriptions: new Map(rows.subscriptions.map((r) => [r.feedId, r])),
    feeds: new Map(rows.feeds.map((r) => [r.id, r])),
    sites: new Map(rows.sites.map((r) => [r.id, r])),
    articles: new Map(rows.articles.map((r) => [r.id, r])),
    titles: new Map(rows.titles.map((r) => [titleKey(r.articleId, r.lang), r])),
    states: new Map(rows.states.map((r) => [r.articleId, r])),
    recommendations: new Map(rows.recommendations.map((r) => [r.articleId, r])),
    highlights: new Map(rows.highlights.map((r) => [r.id, r])),
    claims: new Map(rows.claims.map((r) => [r.id, r])),
    translations: new Map(rows.translations.map((r) => [translationKey(r.contentKey, r.lang), r])),
    follows: new Map(rows.follows.map((r) => [r.userId, r])),
  }
}
