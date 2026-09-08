import type { ArticleFilter } from '@tela/db/queries'

export type ReadingMode = 'side' | 'trans' | 'orig'

export type ReadingParams = {
  filter: ArticleFilter
  feedId: number | null
  articleId: number | null
  mode: ReadingMode
}

export const FILTERS: ArticleFilter[] = ['all', 'today', 'liked']
const MODES: ReadingMode[] = ['side', 'trans', 'orig']

function one(value: string | string[] | null | undefined): string | null | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveId(value: string | string[] | null | undefined): number | null {
  const raw = one(value)
  const n = Number(raw)
  return raw && Number.isInteger(n) && n > 0 ? n : null
}

/** Parse the article carried by a reading URL, tolerating garbage. */
export function parseReadingArticleId(value: string | string[] | null | undefined): number | null {
  return positiveId(value)
}

/** Parse the reader's display mode from either server or browser search params. */
export function parseReadingMode(value: string | string[] | null | undefined): ReadingMode {
  const raw = one(value)
  return MODES.includes(raw as ReadingMode) ? (raw as ReadingMode) : 'side'
}

/** Parse the reading view's search params, tolerating garbage. */
export function parseReadingParams(
  raw: Record<string, string | string[] | undefined>,
): ReadingParams {
  const filterRaw = one(raw.filter)
  const filter = FILTERS.includes(filterRaw as ArticleFilter) ? (filterRaw as ArticleFilter) : 'all'
  return {
    filter,
    feedId: positiveId(raw.feed),
    articleId: parseReadingArticleId(raw.article),
    mode: parseReadingMode(raw.mode),
  }
}

/** Build a /reading URL; defaults are omitted so links stay clean. */
export function readingHref(params: Partial<ReadingParams>): string {
  const q = new URLSearchParams()
  if (params.filter && params.filter !== 'all') q.set('filter', params.filter)
  if (params.feedId) q.set('feed', String(params.feedId))
  if (params.articleId) q.set('article', String(params.articleId))
  if (params.mode && params.mode !== 'side' && params.articleId) q.set('mode', params.mode)
  const s = q.toString()
  return s ? `/reading?${s}` : '/reading'
}
