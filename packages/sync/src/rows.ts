/**
 * The rows a reader's device holds, as tela-api sends them (ADR 0025). They are projections of the
 * D1 tables, carrying only what the reader shows or needs to decide, and every one carries the
 * `seq` of the batch that last wrote it. Times are epoch milliseconds.
 */

export type ProfileRow = {
  handle: string
  displayName: string | null
  bio: string | null
  uiLocale: string | null
  readingLang: string | null
  publicSubscriptions: boolean
  /** Whether the member's liked posts show on their profile and to their followers (ADR 0031). */
  publicLikes: boolean
  /** Whether the member shows their Gravatar (ADR 0032). */
  gravatar: boolean
  /** Their picture's address (`/avatar/…`), or null: the server's to say, never built here. */
  avatar: string | null
  seq: number
}

export type PrefRow = { key: string; value: unknown; updatedAt: number; seq: number }

/** `deletedAt` set means unsubscribed: drop the feed's articles unless liked or recommended. */
export type SubscriptionRow = {
  feedId: number
  /** Articles with an id at or below this are read (ADR 0009). */
  watermarkId: number
  createdAt: number
  deletedAt: number | null
  seq: number
}

export type FeedRow = {
  id: number
  siteId: number
  feedUrl: string
  title: string | null
  status: string
  lastFetchedAt: number | null
  lastError: string | null
  seq: number
}

export type SiteRow = {
  id: number
  homeUrl: string
  title: string | null
  description: string | null
  faviconKey: string | null
  primaryLang: string | null
  listing: string
  /** The member claimed this blog. */
  owned: boolean
  claimed: boolean
  readerCount: number
  translationOptOut: boolean
  seq: number
}

export type ArticleRow = {
  id: number
  feedId: number
  url: string | null
  title: string
  author: string | null
  publishedAt: number | null
  fetchedAt: number
  sortAt: number
  sourceLang: string | null
  excerpt: string | null
  /** The current version's content object, `c/<contentKey>.json`; null until the first version. */
  contentKey: string | null
  wordCount: number
  readingMinutes: number
  extractState: string
  likeCount: number
  recommendCount: number
  seq: number
}

export type TitleRow = {
  articleId: number
  lang: string
  title: string | null
  excerpt: string | null
  status: string
  seq: number
}

export type StateRow = {
  articleId: number
  readAt: number | null
  likedAt: number | null
  likedUpdatedAt: number | null
  seq: number
}

export type RecommendationRow = {
  articleId: number
  note: string | null
  createdAt: number
  deletedAt: number | null
  seq: number
}

/**
 * A passage the member marked in a post, with an optional note (ADR 0026). Private to them. It
 * points into one leaf of one content version: `leafId` and offsets into that leaf's text, plus the
 * quote and a little context either side, so it can be found again in a later version.
 * `side` says whether it was made on the original or on the translation into `lang`.
 */
export type HighlightRow = {
  id: string
  articleId: number
  contentKey: string
  side: 'original' | 'translation'
  lang: string | null
  leafId: string
  start: number
  end: number
  quote: string
  prefix: string
  suffix: string
  note: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  seq: number
}

export type ClaimRow = {
  id: number
  siteId: number
  method: string
  token: string
  status: string
  error: string | null
  verifiedAt: number | null
  seq: number
}

/** A body translation of one content version into one language. */
export type TranslationRow = {
  contentKey: string
  lang: string
  state: string
  chunkKeys: string[]
  objectKey: string | null
  failedLeaves: string[]
  seq: number
}

/**
 * Someone the member follows (ADR 0031), with how they appear: the pull sends the row again when
 * their profile changes. `deletedAt` set means unfollowed, and the device lets the row go.
 */
export type FollowRow = {
  /** The followed member's account id. */
  userId: string
  /** Null only in a prediction, until the pull brings the row. */
  handle: string | null
  displayName: string | null
  /** Their picture's address, or null (ADR 0032). */
  avatar: string | null
  createdAt: number
  deletedAt: number | null
  seq: number
}

export type Tombstone = { entity: string; key: string; seq: number }

export type SyncRows = {
  profile: ProfileRow[]
  prefs: PrefRow[]
  subscriptions: SubscriptionRow[]
  feeds: FeedRow[]
  sites: SiteRow[]
  articles: ArticleRow[]
  titles: TitleRow[]
  states: StateRow[]
  recommendations: RecommendationRow[]
  highlights: HighlightRow[]
  claims: ClaimRow[]
  translations: TranslationRow[]
  follows: FollowRow[]
}

export type SyncTable = keyof SyncRows
