/**
 * Reading URLs. The URL is the one owner of which article is open (ADR 0017's rule, which the
 * local-first reader keeps): every pane is a function of it and the local store.
 */
import { FILTERS, type Filter } from '../store/selectors'

export type ReadingMode = 'side' | 'trans' | 'orig'

export type ReadingParams = {
  filter: Filter
  feedId: number | null
  articleId: number | null
  mode: ReadingMode | null
}

const MODES: ReadingMode[] = ['side', 'trans', 'orig']

function positiveId(raw: string | null): number | null {
  const n = Number(raw)
  return raw && Number.isInteger(n) && n > 0 ? n : null
}

export function readingModeParam(raw: string | null): ReadingMode | null {
  return MODES.includes(raw as ReadingMode) ? (raw as ReadingMode) : null
}

export function parseReadingParams(search: URLSearchParams): ReadingParams {
  const filter = search.get('filter')
  return {
    filter: FILTERS.includes(filter as Filter) ? (filter as Filter) : 'all',
    feedId: positiveId(search.get('feed')),
    articleId: positiveId(search.get('article')),
    mode: readingModeParam(search.get('mode')),
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

/**
 * The canonical reading URL for a search string, with overrides. Two URLs can name one state and
 * differ as text (`?mode=side&article=1` against `?article=1`); compare through here, or a
 * history entry is stacked for a state the reader is already in.
 */
export function canonicalReadingHref(
  search: string,
  overrides: Partial<ReadingParams> = {},
): string {
  return readingHref({ ...parseReadingParams(new URLSearchParams(search)), ...overrides })
}
