import {
  candidateFeedUrls,
  findFeedLinks,
  findMetaRefresh,
  looksLikeFeed,
  normalizeOrigin,
  parseFeedText,
} from '@tela/content'
import type { FeedFormat } from '@tela/shared'
import { type HttpClient, HttpError, type HttpResponse } from './http'
import { FEED_MAX_BYTES } from './items'

export type DiscoveredFeed = {
  url: string
  title: string | null
  format: FeedFormat
  itemCount: number
  homeUrl: string | null
}

export type DiscoverOptions = {
  /** How many declared or well-known candidates to verify by fetching. */
  maxCandidates?: number
}

function withScheme(input: string): string {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed.replace(/^\/+/, '')}`
}

/**
 * A body cut off at the cap that was a feed: a 200 whose start, decoded as the body would have
 * been, reads as one by the test a whole body gets. A page past the cap, a 404 with a large page,
 * or a JSON API is not a feed too large.
 */
function feedCutOff(err: HttpError): boolean {
  const head = err.headText
  if (err.kind !== 'too_large' || err.status !== 200 || !head) return false
  // Cut short, a JSON Feed no longer parses, but its version URL still says what it is.
  return looksLikeFeed(head) || (/^\s*\{/.test(head) && head.includes('jsonfeed.org/version/'))
}

/** The feed at `url`, if it is one; `too_large` for a feed past `FEED_MAX_BYTES`. */
async function tryFeed(
  http: HttpClient,
  url: string,
): Promise<DiscoveredFeed | 'too_large' | null> {
  let res: Awaited<ReturnType<HttpClient['get']>>
  try {
    res = await http.get(url, { maxBytes: FEED_MAX_BYTES })
  } catch (err) {
    if (err instanceof HttpError) return feedCutOff(err) ? 'too_large' : null
    throw err
  }
  if (res.status !== 200 || !res.body || !looksLikeFeed(res.body)) return null
  try {
    const parsed = parseFeedText(res.body, res.finalUrl)
    return {
      url: res.finalUrl,
      title: parsed.title,
      format: parsed.format,
      itemCount: parsed.items.length,
      homeUrl: parsed.homeUrl,
    }
  } catch {
    return null
  }
}

async function getPage(http: HttpClient, url: string): Promise<HttpResponse | null> {
  return http.get(url, { accept: 'text/html, application/xhtml+xml, */*;q=0.5' }).catch((err) => {
    if (err instanceof HttpError) return null
    throw err
  })
}

/**
 * The page to look at when the one typed declares no feed: where its meta refresh sends (Hugo's
 * multilingual root, byvoid.com to `/zht/`), else the blog's home, which declares the feed a
 * page of it may not (paulgraham.com/articles.html). Null when the typed page is the home.
 */
function secondPage(page: HttpResponse | null, url: string): string | null {
  const ok = page?.status === 200 ? page : null
  const refresh = ok?.body ? findMetaRefresh(ok.body, ok.finalUrl) : null
  if (refresh) return refresh
  const at = page?.finalUrl ?? url
  const origin = normalizeOrigin(at)
  if (!origin) return null
  const home = `${origin}/`
  return new URL(at).href.split('#')[0] === home ? null : home
}

/**
 * Find feeds for a URL: the URL itself, feeds declared by the page (or, when it declares none, by
 * one more page: `secondPage`), then well-known paths on the origin of each; a WordPress comments
 * feed only when nothing else was found. Every returned feed has been fetched and parsed. Throws a
 * `too_large` HttpError when nothing was found but a candidate was too large to read, so the member
 * is told that rather than that the blog has no feed.
 */
export async function discoverFeeds(
  http: HttpClient,
  input: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredFeed[]> {
  const maxCandidates = options.maxCandidates ?? 5
  const url = withScheme(input)
  let tooLarge: string | null = null
  const direct = await tryFeed(http, url)
  if (direct === 'too_large') tooLarge = url
  else if (direct) return [direct]

  const page = await getPage(http, url)
  const found: DiscoveredFeed[] = []
  const seen = new Set<string>()
  const consider = async (candidate: string) => {
    if (seen.has(candidate) || found.length >= maxCandidates) return
    seen.add(candidate)
    const feed = await tryFeed(http, candidate)
    if (feed === 'too_large') tooLarge ??= candidate
    else if (feed && !found.some((f) => f.url === feed.url)) found.push(feed)
  }
  const declared = async (from: HttpResponse | null) => {
    if (from?.status !== 200 || !from.body) return
    for (const link of findFeedLinks(from.body, from.finalUrl).slice(0, maxCandidates)) {
      await consider(link.url)
    }
  }

  await declared(page)
  let second: HttpResponse | null = null
  if (found.length === 0) {
    const next = secondPage(page, url)
    second = next ? await getPage(http, next) : null
    await declared(second)
  }
  if (found.length === 0) {
    // The well-known paths on the typed page's origin first, so a site found before the second
    // page existed is found the same; then on the second page's, when it answered from another
    // (a refresh to the blog's new domain).
    const origins = new Set([normalizeOrigin(page?.finalUrl ?? url)])
    if (second?.status === 200) origins.add(normalizeOrigin(second.finalUrl))
    for (const candidate of [...origins].flatMap((o) => (o ? candidateFeedUrls(o) : []))) {
      await consider(candidate)
      if (found.length > 0) break
    }
  }
  if (found.length === 0 && tooLarge) {
    throw new HttpError('too_large', `${tooLarge} is larger than ${FEED_MAX_BYTES} bytes`)
  }
  const posts = found.filter((f) => !isCommentsFeed(f.url))
  return posts.length > 0 ? posts : found
}

/**
 * WordPress's feed of every comment on the blog, which it declares beside the posts' own
 * (`/comments/feed/`, or `?feed=comments-rss2` without pretty permalinks). Offered as a second
 * choice, "Comments for Austin Kleon" could be followed by mistake, so it is offered only when the
 * blog has no other feed.
 */
function isCommentsFeed(url: string): boolean {
  const { pathname, searchParams } = new URL(url)
  return (
    /\/comments\/feed(\/|$)/i.test(pathname) || /^comments-/i.test(searchParams.get('feed') ?? '')
  )
}
