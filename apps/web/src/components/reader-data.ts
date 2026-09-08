/**
 * Everything the reader pane renders, in a shape that survives a fetch.
 *
 * The pane is rendered on the client so that opening an article costs a route handler rather than
 * a React server render — around 20 ms against 67 ms, on the one interaction a reader repeats
 * (ADR 0017). That means this crosses `JSON.stringify`, so dates are ISO strings and only the
 * fields the pane actually uses are here: a `/reading` document was 170 KB, and most of the
 * article row never reached the screen.
 */

export type ReaderTranslationState =
  | 'none'
  | 'requested'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'

export type ReaderTranslation = {
  targetLang: string
  state: ReaderTranslationState
  failedBlocks: number
  /** Rendered translated body, present only when it is fresh and readable. */
  html: string | null
  title: string | null
}

export type ReaderArticle = {
  id: number
  title: string
  author: string | null
  url: string | null
  /** ISO strings, not Dates: this arrives as JSON. */
  publishedAt: string | null
  fetchedAt: string
  sourceLang: string | null
  readingMinutes: number | null
  likeCount: number
  recommendCount: number
  isRead: boolean
  isLiked: boolean
  feedId: number
  feedTitle: string
  site: { title: string | null; description: string | null; readerCount: number }
}

export type ReaderData = {
  article: ReaderArticle
  /** Rendered original body, images already routed through the signed proxy. */
  html: string
  /** Present when the article is not in the reading language. */
  translation: ReaderTranslation | null
  recommendation: { note: string | null } | null
  /** Full text is being fetched for a summary-only article: say so and poll. */
  extracting: boolean
  /** Opaque tag for what this was built from; the poller waits for it to change. */
  revision: string
}
