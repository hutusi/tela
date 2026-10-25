/**
 * Tela's own feeds (ADR 0062): a public blogroll as RSS and OPML (`/l/<id>.rss`, `/l/<id>.opml`)
 * and Discover's (`/discover/articles.rss`, `/discover.opml`), each with the tela-api endpoint it
 * is rendered from, and the page it is of. `?hl=` pins the language the titles are read in, read
 * as a page's is (`hlLocale`: `zh-TW` is Traditional); a feed without one carries every post as
 * written.
 *
 * Pure: the edge routes and renders with these, and the pages link to them.
 */
import { hlLocale, isTopic, type Topic, type UiLocale } from '@tela/shared'
import { blogrollHref, isBlogrollId } from './blogroll-href'
import { articlesHref, tabHref } from './discover-href'

export type FeedFormat = 'rss' | 'opml'

export type FeedRoute =
  | { kind: 'blogroll'; id: string; format: FeedFormat; hl: UiLocale | null; api: string }
  | { kind: 'discover'; format: FeedFormat; topic: Topic | null; hl: UiLocale | null; api: string }
  /** Under `/l/`, a feed's name, of no blogroll's shape: a 404, asked of nobody. */
  | { kind: 'missing' }

/** The endpoint a blogroll's feeds are made from; 404 for one others cannot see. */
export const blogrollFeedApiPath = (id: string) => `/api/v1/public/feeds/blogrolls/${id}`

/** The endpoint Discover's feeds are made from. */
export const discoverFeedApiPath = (topic: string | null) =>
  topic ? `/api/v1/public/feeds/discover?topic=${topic}` : '/api/v1/public/feeds/discover'

/** The feed a URL names, or null for a path that is none. */
export function feedRoute(url: URL): FeedRoute | null {
  // The same reading as a page's (ADR 0060), so a link that pins a page pins its feed alike.
  const hl = hlLocale(url.searchParams.get('hl'))
  const roll = url.pathname.match(/^\/l\/([^/]*)\.(rss|opml)$/)
  if (roll) {
    const id = roll[1]
    if (!isBlogrollId(id)) return { kind: 'missing' }
    const format = roll[2] as FeedFormat
    return { kind: 'blogroll', id, format, hl, api: blogrollFeedApiPath(id) }
  }
  const format =
    url.pathname === '/discover/articles.rss'
      ? 'rss'
      : url.pathname === '/discover.opml'
        ? 'opml'
        : null
  if (!format) return null
  const asked = url.searchParams.get('topic')
  const topic = isTopic(asked) ? asked : null
  return { kind: 'discover', format, topic, hl, api: discoverFeedApiPath(topic) }
}

function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v)
  const s = q.toString()
  return s ? `${path}?${s}` : path
}

/**
 * A blogroll's feed. Its OPML lists the blogs by their own names, which no language changes, so
 * only its RSS takes `hl`.
 */
export function blogrollFeedHref(id: string, format: FeedFormat, hl?: string | null): string {
  return withQuery(`${blogrollHref(id)}.${format}`, { hl: format === 'rss' ? hl : null })
}

/** One of Discover's feeds, narrowed to a topic, its titles (and its own title) in `hl`. */
export function discoverFeedHref(
  format: FeedFormat,
  o: { topic?: string | null; hl?: string | null } = {},
): string {
  const path = format === 'rss' ? '/discover/articles.rss' : '/discover.opml'
  return withQuery(path, { topic: o.topic && isTopic(o.topic) ? o.topic : null, hl: o.hl })
}

/** Where a feed is itself: its canonical address, the query as Tela writes it. */
export function feedSelfHref(route: Exclude<FeedRoute, { kind: 'missing' }>): string {
  return route.kind === 'blogroll'
    ? blogrollFeedHref(route.id, route.format, route.hl)
    : discoverFeedHref(route.format, { topic: route.topic, hl: route.hl })
}

/**
 * The page a feed is of, pinned to its language when it is: a blogroll's page, or Discover's
 * Articles (newest first) or Blogs, by topic.
 */
export function feedPageHref(route: Exclude<FeedRoute, { kind: 'missing' }>): string {
  const hl = route.hl
  if (route.kind === 'blogroll') return withQuery(blogrollHref(route.id), { hl })
  if (route.format === 'rss') {
    const page = articlesHref({ topic: route.topic, sort: 'new' })
    return hl ? `${page}${page.includes('?') ? '&' : '?'}hl=${hl}` : page
  }
  return withQuery(`${tabHref('blogs')}`, { topic: route.topic, hl })
}
