/**
 * Reading URLs. The URL is the one owner of which article is open (ADR 0017's rule, which the
 * local-first reader keeps): every pane is a function of it and the local store.
 */
import { FILTERS, type Filter } from '../store/selectors'

export type ReadingMode = 'side' | 'trans' | 'orig'

/**
 * Which list is shown: a filter (All, Today, Liked), one blog (`feedId`) or a folder of the
 * member's (`folderId`, ADR 0048). A blog and a folder are exclusive, and either one is read with
 * the filter at `all`.
 */
export type ReadingParams = {
  filter: Filter
  feedId: number | null
  folderId: string | null
  articleId: number | null
  mode: ReadingMode | null
}

const MODES: ReadingMode[] = ['side', 'trans', 'orig']

function positiveId(raw: string | null): number | null {
  const n = Number(raw)
  return raw && Number.isInteger(n) && n > 0 ? n : null
}

/**
 * A folder id as the device mints one (the shape `putFolder` accepts). Kept here rather than
 * imported, since the mutations module brings its zod schemas into the bundle (AGENTS.md).
 */
const FOLDER_ID = /^[A-Za-z0-9-]{8,64}$/

function folderIdParam(raw: string | null): string | null {
  return raw !== null && FOLDER_ID.test(raw) ? raw : null
}

export function readingModeParam(raw: string | null): ReadingMode | null {
  return MODES.includes(raw as ReadingMode) ? (raw as ReadingMode) : null
}

/** A folder named in the URL wins over a blog or a filter beside it, as `readingHref` writes it. */
export function parseReadingParams(search: URLSearchParams): ReadingParams {
  const filter = search.get('filter')
  const folderId = folderIdParam(search.get('folder'))
  return {
    filter: folderId === null && FILTERS.includes(filter as Filter) ? (filter as Filter) : 'all',
    feedId: folderId === null ? positiveId(search.get('feed')) : null,
    folderId,
    articleId: positiveId(search.get('article')),
    mode: readingModeParam(search.get('mode')),
  }
}

/** Whether the URL lists that filter, not one blog or a folder. */
export function listsFilter(params: ReadingParams, filter: Filter): boolean {
  return params.feedId === null && params.folderId === null && params.filter === filter
}

/**
 * Build a /reading URL; defaults are omitted so links stay clean. A folder drops a blog and a
 * filter given beside it.
 */
export function readingHref(params: Partial<ReadingParams>): string {
  const q = new URLSearchParams()
  if (params.folderId) q.set('folder', params.folderId)
  else {
    if (params.filter && params.filter !== 'all') q.set('filter', params.filter)
    if (params.feedId) q.set('feed', String(params.feedId))
  }
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
