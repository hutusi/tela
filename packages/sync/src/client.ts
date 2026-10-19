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
import {
  isReadingLanguage,
  MAX_BLOGROLL_BLOGS,
  MAX_BLOGROLLS,
  MAX_FOLDERS,
  type ReadingLanguage,
} from '@tela/shared'
import type { Mutation } from './mutations'
import { completePull, type PullResponse } from './protocol'
import type {
  ArticleRow,
  BlogrollBlogRow,
  BlogrollRow,
  ClaimRow,
  FeedFolderRow,
  FeedRow,
  FolderRow,
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
  /** By id: the member's live folders (a deleted one is not held, ADR 0048). */
  folders: Map<string, FolderRow>
  /** By feed id: which folder each blog is in, `folderId` null for none. */
  feedFolders: Map<number, FeedFolderRow>
  /** By id: the member's live blogrolls (a deleted one is not held, ADR 0050). */
  blogrolls: Map<string, BlogrollRow>
  /**
   * By `${blogrollId}:${feedId}` (`blogrollBlogKey`): the blogs in the member's blogrolls, removed
   * ones included, so a blog put back gets its note back.
   */
  blogrollBlogs: Map<string, BlogrollBlogRow>
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
  folders: new Map(),
  feedFolders: new Map(),
  blogrolls: new Map(),
  blogrollBlogs: new Map(),
})

export const titleKey = (articleId: number, lang: string) => `${articleId}:${lang}`
export const translationKey = (contentKey: string, lang: string) => `${contentKey}:${lang}`
export const blogrollBlogKey = (blogrollId: string, feedId: number) => `${blogrollId}:${feedId}`

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
    folders: new Map(tables.folders),
    feedFolders: new Map(tables.feedFolders),
    blogrolls: new Map(tables.blogrolls),
    blogrollBlogs: new Map(tables.blogrollBlogs),
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
  for (const row of r.folders) {
    if (row.deletedAt === null) t.folders.set(row.id, row)
    else t.folders.delete(row.id)
  }
  for (const row of r.feedFolders) t.feedFolders.set(row.feedId, row)
  // Blogrolls (ADR 0050): blogs first, so a blogroll deleted in this page takes the ones that came
  // with it. A blog of a blogroll not held yet is kept: a page can end before the blogroll's own
  // row, when that changed after its blogs did. A removed blog is kept too, with its note.
  for (const row of r.blogrollBlogs) {
    t.blogrollBlogs.set(blogrollBlogKey(row.blogrollId, row.feedId), row)
  }
  for (const row of r.blogrolls) {
    if (row.deletedAt === null) t.blogrolls.set(row.id, row)
    else {
      t.blogrolls.delete(row.id)
      dropBlogsOf(t, row.id)
    }
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

type SetBlogrollPublic = Extract<Mutation, { type: 'setBlogrollPublic' }>

/**
 * Whether a blogroll cannot be made public yet (ADR 0050), as `privacyUnsettled` says of a
 * privacy switch: a change this device made to it is not in the confirmed rows yet, or the
 * confirmed rows do not hold the blogroll at all (made on this device and not pulled back). A show
 * names the version the server held, and until then the device cannot know it.
 */
export function blogrollPublicUnsettled(
  confirmed: Confirmed,
  pending: readonly Pending[],
  id: string,
): boolean {
  if (!confirmed.tables.blogrolls.has(id)) return true
  return settle(confirmed, pending).some(
    (p) => p.mutation.type === 'setBlogrollPublic' && p.mutation.id === id,
  )
}

/**
 * A blogroll made public or private now, as the mutation to make, or null for a show that has to
 * wait (`blogrollPublicUnsettled`). A hide always applies; a show names in `base` the version in
 * the **confirmed** rows, never the view's, for the reason `privacyChange` gives.
 */
export function blogrollPublicChange(
  confirmed: Confirmed,
  pending: readonly Pending[],
  id: string,
  on: boolean,
): Omit<SetBlogrollPublic, 'mid' | 'at'> | null {
  const held = confirmed.tables.blogrolls.get(id)?.publicVersion ?? 0
  if (!on) return { type: 'setBlogrollPublic', id, isPublic: false, base: held }
  if (blogrollPublicUnsettled(confirmed, pending, id)) return null
  return { type: 'setBlogrollPublic', id, isPublic: true, base: held }
}

/**
 * Predict one mutation, as the server will apply it (`apps/api/src/sync/push.ts`). Same rules:
 * read is set once, unless the member marks the post unread, and then read and unread go to the
 * later `at`; likes, recommendations and prefs go to the later `at`; a watermark never moves
 * backwards. Counts move with the member's own change, which is all a device can know.
 *
 * `tables` is left as it was: the answer is a copy.
 */
export function applyMutation(tables: Tables, m: Mutation): Tables {
  const t = copy(tables)
  applyInPlace(t, m)
  return t
}

/** How many blogs a blogroll holds that are not taken out. */
function liveBlogCount(t: Tables, blogrollId: string): number {
  let n = 0
  for (const row of t.blogrollBlogs.values()) {
    if (row.blogrollId === blogrollId && row.removedAt === null) n++
  }
  return n
}

/** Let a blogroll's blogs go with it: a deleted blogroll is not held, nor what was in it. */
function dropBlogsOf(t: Tables, blogrollId: string) {
  const prefix = `${blogrollId}:`
  for (const key of t.blogrollBlogs.keys()) if (key.startsWith(prefix)) t.blogrollBlogs.delete(key)
}

/**
 * `applyMutation` on tables already copied, changed where they are: what `view` replays every
 * pending mutation with, so a long queue (a held subscribe-all is hundreds) copies the tables once
 * rather than once per mutation. Only the maps of `t` change. A row is never changed in place but
 * replaced, since the maps of a copy hold the same row objects as the confirmed tables.
 */
function applyInPlace(t: Tables, m: Mutation): void {
  switch (m.type) {
    case 'markRead': {
      // As the server decides: a first read is clock-less, unless it reads a post marked unread,
      // when the later `at` decides and the read keeps its clock (ADR 0009); a later read of a
      // read post keeps the first time and moves the clock to its own.
      const s = t.states.get(m.articleId) ?? blankState(m.articleId)
      const clock = s.readUpdatedAt ?? null
      if (s.readAt === null) {
        if (clock !== null && m.at < clock) return
        t.states.set(m.articleId, {
          ...s,
          readAt: m.at,
          readUpdatedAt: clock === null ? null : m.at,
        })
      } else if (m.at > Math.max(s.readAt, clock ?? 0)) {
        t.states.set(m.articleId, { ...s, readUpdatedAt: m.at })
      }
      return
    }
    case 'markUnread': {
      // To the later `at` against any read or unread already made, the first read's own time
      // included.
      const s = t.states.get(m.articleId) ?? blankState(m.articleId)
      if (m.at < Math.max(s.readUpdatedAt ?? 0, s.readAt ?? 0)) return
      t.states.set(m.articleId, { ...s, readAt: null, readUpdatedAt: m.at })
      return
    }
    case 'setLiked': {
      const s = t.states.get(m.articleId) ?? blankState(m.articleId)
      if (s.likedUpdatedAt !== null && m.at <= s.likedUpdatedAt) return
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
      return
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
      // the mark-all's clock: those marked before it, not one marked since. One already read by
      // hand keeps its first time and takes the later clock.
      for (const [id, s] of t.states) {
        if (s.readUpdatedAt == null) continue
        if (s.readAt === null ? s.readUpdatedAt > m.at : s.readUpdatedAt >= m.at) continue
        const a = t.articles.get(id)
        if (!a || a.id > m.upTo || t.subscriptions.get(a.feedId)?.deletedAt !== null) continue
        if (m.feedId !== undefined && a.feedId !== m.feedId) continue
        t.states.set(id, { ...s, readAt: s.readAt ?? m.at, readUpdatedAt: m.at })
      }
      return
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
      return
    }
    case 'unsubscribe': {
      const sub = t.subscriptions.get(m.feedId)
      if (sub && sub.deletedAt === null) {
        t.subscriptions.set(m.feedId, { ...sub, deletedAt: m.at })
        prune(t, m.feedId)
      }
      return
    }
    case 'setPref': {
      // One the account takes from this browser fills only a pref no row is held for, with no
      // clock, as the server writes it; if the server has a row this device never held, the next
      // pull brings it.
      const held = t.prefs.get(m.key)
      if (m.ifAbsent) {
        if (!held) t.prefs.set(m.key, { key: m.key, value: m.value, updatedAt: 0, seq: 0 })
        return
      }
      if (!held || m.at >= held.updatedAt) {
        t.prefs.set(m.key, { key: m.key, value: m.value, updatedAt: m.at, seq: held?.seq ?? 0 })
      }
      return
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
      return
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
      return
    }
    case 'setAvatar': {
      // Off takes a Gravatar away at once, though not an upload, which comes first. On, or
      // Refresh, waits for the server's row: it names the new address, which this device does
      // not build.
      if (t.profile) {
        const keeps = m.gravatar || t.profile.avatarUploaded
        t.profile = { ...t.profile, gravatar: m.gravatar, ...(keeps ? {} : { avatar: null }) }
      }
      return
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
      return
    }
    case 'unrecommend': {
      const held = t.recommendations.get(m.articleId)
      if (!held || held.deletedAt !== null) return
      t.recommendations.set(m.articleId, { ...held, deletedAt: m.at })
      bumpRecommend(t, m.articleId, -1)
      return
    }
    case 'putHighlight': {
      const held = t.highlights.get(m.id)
      if (held && m.at < held.updatedAt) return
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
      return
    }
    case 'deleteHighlight': {
      t.highlights.delete(m.id)
      return
    }
    case 'follow': {
      // Who they are arrives with the pull; until then the row has only their id, and the page
      // that followed them knows the rest. (The server ignores a self-follow; no page offers one.)
      if (t.follows.has(m.userId)) return
      t.follows.set(m.userId, {
        userId: m.userId,
        handle: null,
        displayName: null,
        avatar: null,
        createdAt: m.at,
        deletedAt: null,
        seq: 0,
      })
      return
    }
    case 'unfollow': {
      t.follows.delete(m.userId)
      return
    }
    case 'putFolder': {
      // As the server decides: the later `at` wins, and a new folder past the limit is not made.
      // A folder deleted elsewhere is not held, so a rename of it shows until the pull that says
      // it was refused; the server never brings it back.
      const held = t.folders.get(m.id)
      if (held && m.at < held.updatedAt) return
      if (!held && t.folders.size >= MAX_FOLDERS) return
      t.folders.set(m.id, {
        id: m.id,
        name: m.name.trim(),
        createdAt: held?.createdAt ?? m.at,
        updatedAt: m.at,
        deletedAt: null,
        seq: held?.seq ?? 0,
      })
      return
    }
    case 'deleteFolder': {
      // Delete wins, and its blogs are in no folder, each keeping its move's clock.
      if (!t.folders.delete(m.id)) return
      for (const [feedId, row] of t.feedFolders) {
        if (row.folderId === m.id) t.feedFolders.set(feedId, { ...row, folderId: null })
      }
      return
    }
    case 'fileFeed': {
      // Into a folder this device holds, or none; the later `at` wins. A feed merged into another
      // is filed under the one it became by the server, and the pull says so.
      if (m.folderId !== null && !t.folders.has(m.folderId)) return
      const held = t.feedFolders.get(m.feedId)
      if (held && m.at < held.updatedAt) return
      t.feedFolders.set(m.feedId, {
        feedId: m.feedId,
        folderId: m.folderId,
        updatedAt: m.at,
        seq: held?.seq ?? 0,
      })
      return
    }
    case 'putBlogroll': {
      // As the server decides (ADR 0050): the later `at` wins, a new blogroll past the limit is
      // not made, and public or private counts only when it is made; after that it is
      // `setBlogrollPublic`'s alone. A blogroll deleted elsewhere is not held, so an edit of it
      // shows until the pull that says it was refused, as a folder's does.
      const held = t.blogrolls.get(m.id)
      if (held && m.at < held.updatedAt) return
      if (!held && t.blogrolls.size >= MAX_BLOGROLLS) return
      t.blogrolls.set(m.id, {
        id: m.id,
        name: m.name.trim(),
        description: m.description.trim(),
        isPublic: held ? held.isPublic : m.isPublic,
        publicVersion: held?.publicVersion ?? 0,
        createdAt: held?.createdAt ?? m.at,
        updatedAt: m.at,
        deletedAt: null,
        seq: held?.seq ?? 0,
      })
      return
    }
    case 'setBlogrollPublic': {
      // As a privacy switch is predicted (issue #16): a hide always applies, a show only while it
      // names the version held, and nothing here counts versions, so the version held is the
      // confirmed one. `blogrollPublicChange` makes no show while this device's own change to the
      // blogroll is unsettled, so no change ahead of it moves the version it names.
      const held = t.blogrolls.get(m.id)
      if (!held) return
      if (m.isPublic && m.base !== held.publicVersion) return
      t.blogrolls.set(m.id, { ...held, isPublic: m.isPublic })
      return
    }
    case 'deleteBlogroll': {
      // Delete wins, and the blogroll's blogs go with it. The server keeps their rows; a deleted
      // blogroll's are never sent again.
      if (!t.blogrolls.delete(m.id)) return
      dropBlogsOf(t, m.id)
      return
    }
    case 'rollBlog': {
      // Into a blogroll this device holds, to the later `at`; past the limit only a blog already
      // in it. One put back goes to the end, one already in keeps its place, and the note stays
      // as it was. A feed merged into another is put in as the one it became by the server, and
      // the pull says so.
      if (!t.blogrolls.has(m.blogrollId)) return
      const key = blogrollBlogKey(m.blogrollId, m.feedId)
      const held = t.blogrollBlogs.get(key)
      const live = held !== undefined && held.removedAt === null
      if (!live && liveBlogCount(t, m.blogrollId) >= MAX_BLOGROLL_BLOGS) return
      if (held && m.at < held.updatedAt) return
      t.blogrollBlogs.set(key, {
        blogrollId: m.blogrollId,
        feedId: m.feedId,
        note: held?.note ?? null,
        noteAt: held?.noteAt ?? 0,
        addedAt: live ? held.addedAt : m.at,
        updatedAt: m.at,
        removedAt: null,
        seq: held?.seq ?? 0,
      })
      return
    }
    case 'unrollBlog': {
      // To the later `at`, and the clock moves forward even on a blog already taken out, so an
      // older put-back arriving after this one loses (the `unfollow` lesson). No row, no change.
      if (!t.blogrolls.has(m.blogrollId)) return
      const key = blogrollBlogKey(m.blogrollId, m.feedId)
      const held = t.blogrollBlogs.get(key)
      if (!held) return
      if (held.removedAt === null && m.at < held.updatedAt) return
      t.blogrollBlogs.set(key, {
        ...held,
        removedAt: held.removedAt ?? m.at,
        updatedAt: Math.max(held.updatedAt, m.at),
      })
      return
    }
    case 'noteBlog': {
      // On the note's own clock, to the later `at`: it is written on a blog taken out too, for
      // when it is put back, and never puts one back.
      if (!t.blogrolls.has(m.blogrollId)) return
      const key = blogrollBlogKey(m.blogrollId, m.feedId)
      const held = t.blogrollBlogs.get(key)
      if (!held || m.at < held.noteAt) return
      t.blogrollBlogs.set(key, { ...held, note: m.note?.trim() || null, noteAt: m.at })
      return
    }
    default: {
      // Exhaustive for every type this build knows; a change from a later build that a rollback
      // left in this device's queue changes nothing here, and its push says what the server
      // makes of it. Without this, an older build's view threw on a follow and booted blank.
      const unknown: never = m
      void unknown
      return
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

/**
 * What the device shows: the confirmed tables with every pending mutation replayed on top. The
 * tables are copied once and every mutation replayed on the copy, so a queue of hundreds (a held
 * subscribe-all) costs one copy, not one per mutation (ADR 0050). With nothing pending it is the
 * confirmed tables themselves, so what is cached by their identity stays.
 */
export function view(confirmed: Confirmed, pending: readonly Pending[]): Tables {
  if (pending.length === 0) return confirmed.tables
  const t = copy(confirmed.tables)
  for (const p of pending) applyInPlace(t, p.mutation)
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

/**
 * The language a member reads posts in (ADR 0040): their own choice, else their interface
 * language, the account's before the page's, else English. A reader always passes the tables it
 * renders (the view), so a choice still on its way to the server already counts, and the page
 * never asks for one language's titles while it shows another's. The account's interface language
 * comes before `uiLocale`, the page's, which takes it from the account only after a render: asked
 * in between, the page's would name the cookie's language for a moment, and the device would
 * fetch that language's titles for nothing.
 */
export function readingLangOf(
  profile: Pick<ProfileRow, 'readingLang' | 'uiLocale'> | null | undefined,
  uiLocale: string,
): ReadingLanguage {
  for (const lang of [profile?.readingLang, profile?.uiLocale, uiLocale]) {
    if (isReadingLanguage(lang)) return lang
  }
  return 'en'
}

/**
 * How many articles one request for titles may name (`POST /api/v1/sync/titles`): tela-api's
 * `TITLE_IDS_MAX` (apps/api/src/app.ts), which answers more with 400 `invalid_ids`.
 */
const TITLE_IDS_PER_REQUEST = 1000

/**
 * A pull as the device holding only `lang`'s titles takes it, and whether it brought that
 * language: whether the device still holds `lang` whole after folding it in, if it did before. A
 * tela-api asked for one language answers with it (`titlesLang`); one that predates the question
 * (a rollback) sends every language and says none, and filtered here that is `lang`'s as well. A
 * pull in another language (asked for before the member switched) brings none of `lang`'s, though
 * its cursor passes theirs: its titles are dropped, and the device must fetch `lang`'s again.
 */
export function titlesIn(
  pull: PullResponse,
  lang: string,
): { pull: PullResponse; folded: boolean } {
  const sent = (pull as PullResponse & { titlesLang?: string }).titlesLang
  const folded = sent === undefined || sent === lang
  const titles = pull.rows.titles as TitleRow[] | undefined
  if (titles === undefined) return { pull, folded }
  const kept = folded ? titles.filter((row) => row.lang === lang) : []
  if (kept.length === titles.length) return { pull, folded }
  return { pull: { ...pull, rows: { ...pull.rows, titles: kept } }, folded }
}

/**
 * Title rows fetched by id, folded into `tables`: only `lang`'s, only for articles the device
 * holds (one let go meanwhile stays gone), and the later write of each, by seq, so a page read
 * before a pull that brought a newer title never puts the older one back. The same tables when
 * nothing changed.
 */
export function mergeTitles(tables: Tables, rows: readonly TitleRow[], lang: string): Tables {
  let titles: Map<string, TitleRow> | null = null
  for (const row of rows) {
    if (row.lang !== lang || !tables.articles.has(row.articleId)) continue
    const key = titleKey(row.articleId, lang)
    const held = (titles ?? tables.titles).get(key)
    if (held && held.seq >= row.seq) continue
    titles ??= new Map(tables.titles)
    titles.set(key, row)
  }
  return titles ? { ...tables, titles } : tables
}

/**
 * The next articles to ask `lang`'s titles for: those the device holds with an id past `after`
 * and no title in `lang`, lowest first, up to `limit`. A post written in `lang` is never asked
 * for: no title is ever made in a post's own language. A pass goes by id, each page `after` the
 * last one asked, because a post the server has no title for (not translated yet, or its blog
 * opted out) stays missing, and a pass that went by what is missing alone would ask for it for
 * ever. The ids are the device's, not the server's horizon: it keeps posts older than that.
 */
export function nextTitleIds(
  tables: Tables,
  lang: string,
  limit = TITLE_IDS_PER_REQUEST,
  after = 0,
): number[] {
  const ids: number[] = []
  for (const article of tables.articles.values()) {
    if (article.id <= after || article.sourceLang === lang) continue
    if (!tables.titles.has(titleKey(article.id, lang))) ids.push(article.id)
  }
  return ids.sort((a, b) => a - b).slice(0, limit)
}

/** The tables with every title not in `lang` let go; the same tables when there was none. */
export function pruneTitlesTo(tables: Tables, lang: string): Tables {
  let titles: Map<string, TitleRow> | null = null
  for (const [key, row] of tables.titles) {
    if (row.lang === lang) continue
    titles ??= new Map(tables.titles)
    titles.delete(key)
  }
  return titles ? { ...tables, titles } : tables
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
    folders: [...tables.folders.values()],
    feedFolders: [...tables.feedFolders.values()],
    blogrolls: [...tables.blogrolls.values()],
    blogrollBlogs: [...tables.blogrollBlogs.values()],
  }
}

export type {
  ArticleRow,
  BlogrollBlogRow,
  BlogrollRow,
  ClaimRow,
  FeedFolderRow,
  FeedRow,
  FolderRow,
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
    folders: new Map(rows.folders.map((r) => [r.id, r])),
    feedFolders: new Map(rows.feedFolders.map((r) => [r.feedId, r])),
    blogrolls: new Map(rows.blogrolls.map((r) => [r.id, r])),
    blogrollBlogs: new Map(
      rows.blogrollBlogs.map((r) => [blogrollBlogKey(r.blogrollId, r.feedId), r]),
    ),
  }
}
