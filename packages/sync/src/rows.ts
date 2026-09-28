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
  claims: ClaimRow[]
  translations: TranslationRow[]
}

export type SyncTable = keyof SyncRows
