/**
 * Discover's URLs (ADR 0044): This week at `/discover`, then Articles, Blogs and Readers, each
 * with the public endpoint it reads. A page's API path is written beside its URL, never derived
 * from it: the Blogs page moved to `/discover/blogs`, and its endpoint stayed where it was.
 */
import { isTopic } from '@tela/shared'

export type DiscoverTab = 'week' | 'articles' | 'blogs' | 'readers'
export const DISCOVER_TABS: readonly DiscoverTab[] = ['week', 'articles', 'blogs', 'readers']

export function tabHref(tab: DiscoverTab): string {
  return tab === 'week' ? '/discover' : `/discover/${tab}`
}

/** The tab a path names, or null for a path that is not one of Discover's. */
export function tabOf(pathname: string): DiscoverTab | null {
  if (pathname === '/discover') return 'week'
  const tab = pathname.match(/^\/discover\/(articles|blogs|readers)$/)?.[1]
  return (tab as DiscoverTab | undefined) ?? null
}

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/
const topicOf = (search: URLSearchParams) => {
  const topic = search.get('topic')
  return topic && isTopic(topic) ? topic : null
}
const langOf = (search: URLSearchParams) => {
  const lang = search.get('lang')
  return lang && LANG.test(lang) ? lang : null
}
const withQuery = (path: string, q: URLSearchParams) => {
  const s = q.toString()
  return s ? `${path}?${s}` : path
}

/** This week's endpoint; the page takes no parameters. */
export const WEEK_PATH = '/api/v1/public/discover/week'
/** Readers' endpoint, which Following's suggestions read too. */
export const READERS_PATH = '/api/v1/public/discover/readers'

/** Blogs: `page` counts from 1, and the first page's URL leaves it out. */
export type BlogsParams = { topic: string | null; lang: string | null; page: number }

export function parseBlogsParams(search: URLSearchParams): BlogsParams {
  const page = Number(search.get('page'))
  return {
    topic: topicOf(search),
    lang: langOf(search),
    page: Number.isInteger(page) && page > 1 && page <= 1000 ? page : 1,
  }
}

function blogsQuery(params: Partial<BlogsParams>): URLSearchParams {
  const q = new URLSearchParams()
  if (params.topic) q.set('topic', params.topic)
  if (params.lang) q.set('lang', params.lang)
  if (params.page && params.page > 1) q.set('page', String(params.page))
  return q
}

export function blogsHref(params: Partial<BlogsParams>): string {
  return withQuery('/discover/blogs', blogsQuery(params))
}

/** The Blogs page's endpoint: where Discover's only page always read from. */
export function blogsApiPath(params: BlogsParams): string {
  return withQuery('/api/v1/public/discover', blogsQuery(params))
}

/**
 * Articles: the most recommended first (`recs`, which the URL leaves out) or the newest; `cursor`
 * names the post a page starts after, as `<sortAt>:<id>`.
 */
export type ArticlesSort = 'recs' | 'new'
export type ArticlesParams = {
  topic: string | null
  lang: string | null
  sort: ArticlesSort
  cursor: string | null
}
export const ARTICLES_CURSOR = /^(-?\d{1,15}):(\d{1,12})$/

export function parseArticlesParams(search: URLSearchParams): ArticlesParams {
  const cursor = search.get('cursor')
  return {
    topic: topicOf(search),
    lang: langOf(search),
    sort: search.get('sort') === 'new' ? 'new' : 'recs',
    cursor: cursor && ARTICLES_CURSOR.test(cursor) ? cursor : null,
  }
}

function articlesQuery(params: Partial<ArticlesParams>, sort: boolean): URLSearchParams {
  const q = new URLSearchParams()
  if (params.topic) q.set('topic', params.topic)
  if (params.lang) q.set('lang', params.lang)
  if (sort && params.sort === 'new') q.set('sort', 'new')
  if (params.cursor) q.set('cursor', params.cursor)
  return q
}

export function articlesHref(params: Partial<ArticlesParams>): string {
  return withQuery('/discover/articles', articlesQuery(params, true))
}

/** The endpoint never sorts: the device orders the same answer either way. */
export function articlesApiPath(params: ArticlesParams): string {
  return withQuery('/api/v1/public/discover/articles', articlesQuery(params, false))
}

/**
 * Where an address from before the tabs goes: `/discover` with the Blogs page's filters was that
 * page, and now names `/discover/blogs`. The whole query stays, since a sign-in's return adds its
 * own (`door`, `via`). Null for anything else, This week included.
 */
export function legacyDiscover(pathname: string, search: string): string | null {
  if (pathname !== '/discover') return null
  const q = new URLSearchParams(search)
  if (!q.has('topic') && !q.has('lang') && !q.has('page')) return null
  return withQuery('/discover/blogs', q)
}
