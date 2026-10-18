/**
 * A blogroll's addresses (ADR 0050): its page at `/l/<id>`, the public endpoint it reads, and
 * Discover's Blogrolls tab with its endpoint. The id's shape comes from `@tela/shared`, never the
 * mutations module, which would bring its zod schemas into the bundle (AGENTS.md).
 */
import { BLOGROLL_ID } from '@tela/shared'

export const isBlogrollId = (raw: string | null | undefined): raw is string =>
  typeof raw === 'string' && BLOGROLL_ID.test(raw)

export const blogrollHref = (id: string) => `/l/${id}`

/** The public answer for a blogroll others can see; 404 for a private, deleted or unknown one. */
export const blogrollPath = (id: string) => `/api/v1/public/blogrolls/${id}`

/** Discover's Blogrolls tab. */
export const BLOGROLLS_HREF = '/discover/blogrolls'
/** Its endpoint, without a cursor; `forgetPublic` takes this as the prefix of every page. */
export const BLOGROLLS_PATH = '/api/v1/public/discover/blogrolls'

/** A page cursor as tela-api writes one: `<publicSince>:<id>`. */
const CURSOR = /^\d{1,15}:[A-Za-z0-9]{12}$/

export function blogrollsCursor(search: URLSearchParams): string | null {
  const cursor = search.get('cursor')
  return cursor && CURSOR.test(cursor) ? cursor : null
}

export const blogrollsApiPath = (cursor: string | null) =>
  cursor ? `${BLOGROLLS_PATH}?cursor=${encodeURIComponent(cursor)}` : BLOGROLLS_PATH

export const blogrollsHref = (cursor: string | null) =>
  cursor ? `${BLOGROLLS_HREF}?cursor=${encodeURIComponent(cursor)}` : BLOGROLLS_HREF
