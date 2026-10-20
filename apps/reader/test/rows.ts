/** Rows as a pull brings them, with defaults, for the reader's unit tests. */
import {
  type ArticleRow,
  emptyRows,
  type PullResponse,
  type SubscriptionRow,
  type TitleRow,
} from '@tela/sync'

export const DAY = 86_400_000
export const NOW = 100 * DAY

export const article = (id: number, over: Partial<ArticleRow> = {}): ArticleRow => ({
  id,
  feedId: 1,
  url: null,
  title: `Post ${id}`,
  author: null,
  publishedAt: null,
  fetchedAt: NOW - DAY,
  sortAt: NOW - DAY,
  sourceLang: 'en',
  excerpt: null,
  contentKey: null,
  wordCount: 0,
  readingMinutes: 1,
  extractState: 'none',
  likeCount: 0,
  recommendCount: 0,
  seq: 1,
  ...over,
})

export const sub = (feedId: number, over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  feedId,
  watermarkId: 0,
  createdAt: 0,
  deletedAt: null,
  seq: 1,
  ...over,
})

/** A title the jobs made in `lang`, as the mock translator words it. */
export const title = (articleId: number, lang: string, seq = 1): TitleRow => ({
  articleId,
  lang,
  title: `${lang}:Post ${articleId}`,
  excerpt: null,
  status: 'done',
  seq,
})

/** A pull as a tela-api asked for one language's titles answers it (`?titles=`). */
export const inLang = (p: PullResponse, titlesLang: string): PullResponse => ({ ...p, titlesLang })

export const pull = (
  cursor: number,
  rows: Partial<PullResponse['rows']>,
  reset = false,
): PullResponse => ({
  cursor,
  more: false,
  reset,
  rows: { ...emptyRows(), ...rows },
  tombstones: [],
})

export const profile = {
  handle: 'reader',
  displayName: null,
  bio: null,
  uiLocale: null,
  readingLang: null,
  publicSubscriptions: false,
  publicLikes: false,
  gravatar: false,
  gravatarFound: null,
  avatarUploaded: false,
  avatar: null,
  seq: 1,
}
