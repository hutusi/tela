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
import { completePull, type PullResponse } from './protocol'
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
export function applyPull(confirmed: Confirmed, given: PullResponse): Confirmed {
  const pull = completePull(given)
  const t = pull.reset ? emptyTables() : copy(confirmed.tables)
  const r = pull.rows
  // A profile row from a tela-api that predates a field keeps the device's value for it, rather
  // than reading as the field's default until the profile next changes. A null picture is a
  // value (the Gravatar is off), so only a missing one falls back.
  const previous = confirmed.tables.profile
  for (const row of r.profile) {
    t.profile = {
      ...row,
      publicLikes: row.publicLikes ?? previous?.publicLikes ?? false,
      gravatar: row.gravatar ?? previous?.gravatar ?? false,
      gravatarFound:
        row.gravatarFound === undefined ? (previous?.gravatarFound ?? null) : row.gravatarFound,
      avatarUploaded: row.avatarUploaded ?? previous?.avatarUploaded ?? false,
      avatar: row.avatar === undefined ? (previous?.avatar ?? null) : row.avatar,
      isAdmin: row.isAdmin ?? previous?.isAdmin ?? false,
      uiLocaleAt: row.uiLocaleAt ?? previous?.uiLocaleAt ?? 0,
      readingLangAt: row.readingLangAt ?? previous?.readingLangAt ?? 0,
      publicSubscriptionsVersion:
        row.publicSubscriptionsVersion ?? previous?.publicSubscriptionsVersion ?? 0,
      publicLikesVersion: row.publicLikesVersion ?? previous?.publicLikesVersion ?? 0,
    }
  }
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

export type PrivacyFlag = 'publicSubscriptions' | 'publicLikes'
type SetPrivacy = Extract<Mutation, { type: 'setPrivacy' }>

/** Each privacy switch, and the profile field that counts its changes. */
const VERSION = {
  publicSubscriptions: 'publicSubscriptionsVersion',
  publicLikes: 'publicLikesVersion',
} as const
const PRIVACY = Object.keys(VERSION) as PrivacyFlag[]

/**
 * Whether a privacy switch cannot be turned on yet (issue #16): a change this device made to it is
 * not in the confirmed rows (still to be pushed, or acknowledged and not yet pulled), or no row
 * has come at all. A show names the version the server held, and until the change lands in a pull
 * the device cannot know which version that is: a show sent meanwhile would name the version from
 * before the change, and be refused. A hide is never held back.
 */
export function privacyUnsettled(
  confirmed: Confirmed,
  pending: readonly Pending[],
  flag: PrivacyFlag,
): boolean {
  if (confirmed.tables.profile === null) return true
  return settle(confirmed, pending).some(
    (p) => p.mutation.type === 'setPrivacy' && p.mutation[flag] !== undefined,
  )
}

/**
 * A privacy switch turned on or off now, as the mutation to make, or null for a show that has to
 * wait (`privacyUnsettled`). A hide names no version: it always applies. A show names in `base`
 * the version of its switch in the **confirmed** rows, the one the server held when this device
 * last heard, never the view's (issue #16). The view replays changes a pull may already hold, and
 * a show the server will refuse looks applied there, so a version read from it need not be one
 * the server ever held: a show based on it was refused when it should have applied, or applied
 * over a hide made elsewhere that this device had never seen. Against the confirmed version, a
 * show applies only while nothing has changed the switch since this device last pulled.
 */
export function privacyChange(
  confirmed: Confirmed,
  pending: readonly Pending[],
  flag: PrivacyFlag,
  on: boolean,
): Omit<SetPrivacy, 'mid' | 'at'> | null {
  if (!on) return { type: 'setPrivacy', [flag]: false }
  if (privacyUnsettled(confirmed, pending, flag)) return null
  const held = confirmed.tables.profile?.[VERSION[flag]] ?? 0
  return { type: 'setPrivacy', [flag]: true, base: { [flag]: held } }
}

/**
 * Predict one mutation, as the server will apply it (`apps/api/src/sync/push.ts`). Same rules:
 * read is set once, unless the member marks the post unread, and then read and unread go to the
 * later `at`; likes, recommendations and prefs go to the later `at`; a watermark never moves
 * backwards. Counts move with the member's own change, which is all a device can know.
 */
export function applyMutation(tables: Tables, m: Mutation): Tables {
  const t = copy(tables)
  switch (m.type) {
    case 'markRead': {
      // Set once, and clock-less, unless it reads a post marked unread: then the later `at`
      // decides, and the read keeps its clock (ADR 0009).
      const s = t.states.get(m.articleId) ?? blankState(m.articleId)
      const clock = s.readUpdatedAt ?? null
      if (s.readAt !== null || (clock !== null && m.at < clock)) return t
      t.states.set(m.articleId, { ...s, readAt: m.at, readUpdatedAt: clock === null ? null : m.at })
      return t
    }
    case 'markUnread': {
      // To the later `at` against any read or unread already made, the first read's own time
      // included.
      const s = t.states.get(m.articleId) ?? blankState(m.articleId)
      if (m.at < Math.max(s.readUpdatedAt ?? 0, s.readAt ?? 0)) return t
      t.states.set(m.articleId, { ...s, readAt: null, readUpdatedAt: m.at })
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
        // Liking reads, unless the member chose read or unread by hand: a like never moves that.
        readAt: s.readUpdatedAt != null ? s.readAt : (s.readAt ?? m.at),
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
      // A post marked unread beats the watermark, so those this covers are read by hand, with
      // the mark-all's clock: those marked before it, not one marked since.
      for (const [id, s] of t.states) {
        if (s.readAt !== null || s.readUpdatedAt == null || s.readUpdatedAt > m.at) continue
        const a = t.articles.get(id)
        if (!a || a.id > m.upTo || t.subscriptions.get(a.feedId)?.deletedAt !== null) continue
        if (m.feedId !== undefined && a.feedId !== m.feedId) continue
        t.states.set(id, { ...s, readAt: m.at, readUpdatedAt: m.at })
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
      // One the account takes from this browser fills only a pref no row is held for, with no
      // clock, as the server writes it; if the server has a row this device never held, the next
      // pull brings it.
      const held = t.prefs.get(m.key)
      if (m.ifAbsent) {
        if (!held) t.prefs.set(m.key, { key: m.key, value: m.value, updatedAt: 0, seq: 0 })
        return t
      }
      if (!held || m.at >= held.updatedAt) {
        t.prefs.set(m.key, { key: m.key, value: m.value, updatedAt: m.at, seq: held?.seq ?? 0 })
      }
      return t
    }
    case 'setProfile': {
      // Each language to the later `at`, as the server decides (ADR 0040), so a choice that loses
      // there loses here too, and the page never shows one the account does not hold. A reading
      // language of null is a value: it follows the interface.
      const p = t.profile
      if (p) {
        const next = { ...p }
        if (m.uiLocale !== undefined && m.adopt) {
          // Taken from this browser: only while the account has none, its clock left alone.
          next.uiLocale = p.uiLocale ?? m.uiLocale
        } else if (m.uiLocale !== undefined && m.at >= (p.uiLocaleAt ?? 0)) {
          next.uiLocale = m.uiLocale
          next.uiLocaleAt = m.at
        }
        if (m.readingLang !== undefined && m.at >= (p.readingLangAt ?? 0)) {
          next.readingLang = m.readingLang
          next.readingLangAt = m.at
        }
        t.profile = next
      }
      return t
    }
    case 'setPrivacy': {
      // As the server decides (issue #16): a hide always applies, and a show with a base only
      // while it names the version held, so a show a pull has passed is refused here as it is
      // there. Nothing here counts versions, so the version held is the confirmed one: replayed
      // over a pull that already holds the change, a count would add it twice. A show this device
      // makes waits until its other changes to the switch have settled (`privacyChange`), so no
      // change ahead of it in the queue moves the version it names. A show without a base applies
      // here; the server decides it by `at`, and its row replaces this one with the next pull.
      // `false` is a value.
      const p = t.profile
      if (p) {
        const next = { ...p }
        for (const flag of PRIVACY) {
          const v = m[flag]
          if (v === undefined) continue
          const base = m.base?.[flag]
          if (v && base !== undefined && base !== (p[VERSION[flag]] ?? 0)) continue
          next[flag] = v
        }
        t.profile = next
      }
      return t
    }
    case 'setAvatar': {
      // Off takes a Gravatar away at once, though not an upload, which comes first. On, or
      // Refresh, waits for the server's row: it names the new address, which this device does
      // not build.
      if (t.profile) {
        const keeps = m.gravatar || t.profile.avatarUploaded
        t.profile = { ...t.profile, gravatar: m.gravatar, ...(keeps ? {} : { avatar: null }) }
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
        avatar: null,
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
    default: {
      // Exhaustive for every type this build knows; a change from a later build that a rollback
      // left in this device's queue changes nothing here, and its push says what the server
      // makes of it. Without this, an older build's view threw on a follow and booted blank.
      const unknown: never = m
      void unknown
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
