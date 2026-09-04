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

/** Parse the reading view's search params, tolerating garbage. */
export function parseReadingParams(
  raw: Record<string, string | string[] | undefined>,
): ReadingParams {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const filterRaw = one(raw.filter)
  const filter = FILTERS.includes(filterRaw as ArticleFilter) ? (filterRaw as ArticleFilter) : 'all'
  const modeRaw = one(raw.mode)
  const mode = MODES.includes(modeRaw as ReadingMode) ? (modeRaw as ReadingMode) : 'side'
  const num = (v: string | undefined) => {
    const n = Number(v)
    return v && Number.isInteger(n) && n > 0 ? n : null
  }
  return { filter, feedId: num(one(raw.feed)), articleId: num(one(raw.article)), mode }
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
