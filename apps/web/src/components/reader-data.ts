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

/**
 * One top-level block of a body.
 *
 * The reader pairs a translation against its original a block at a time, so both bodies cross
 * the wire already split. `id` is the block's first `data-tb`; blocks that carry none — an
 * `<hr>`, an image-only `<figure>` — fall back to their position, which is stable because both
 * sides are the same elements in the same order.
 */
export type ReaderBlock = {
  id: string
  tag: string
  html: string
}

export type ReaderTranslation = {
  targetLang: string
  state: ReaderTranslationState
  failedBlocks: number
  /** Ids of the top-level blocks holding one, so the reader can mark where the source shows. */
  untranslatedBlocks: string[]
  /** Rendered translated body, present only when it is fresh and readable. */
  blocks: ReaderBlock[] | null
  title: string | null
}

export type ReaderArticle = {
  id: number
  title: string
  author: string | null
  url: string | null
  /**
   * Already formatted, and deliberately not a Date.
   *
   * `relativeTime` reads the clock and formats in the local time zone. Doing that in a client
   * component runs it twice — once on the server, once on hydration — and the worker is UTC while
   * the reader is not, so the two can disagree by a threshold or by a whole day.
   */
  publishedLabel: string
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
  blocks: ReaderBlock[]
  /** Present when the article is not in the reading language. */
  translation: ReaderTranslation | null
  recommendation: { note: string | null } | null
  /** Full text is being fetched for a summary-only article: say so and poll. */
  extracting: boolean
  /** Opaque tag for what this was built from; the poller waits for it to change. */
  revision: string
}

/** The reader pane state supplied by a server render. */
export type InitialReaderState =
  | { kind: 'empty' }
  | { kind: 'ready'; data: ReaderData }
  | { kind: 'gone'; articleId: number }
