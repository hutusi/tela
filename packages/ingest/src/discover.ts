import {
  candidateFeedUrls,
  findFeedLinks,
  looksLikeFeed,
  normalizeOrigin,
  parseFeedText,
} from '@tela/content'
import type { FeedFormat } from '@tela/shared'
import { type HttpClient, HttpError } from './http'

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

async function tryFeed(http: HttpClient, url: string): Promise<DiscoveredFeed | null> {
  let res: Awaited<ReturnType<HttpClient['get']>>
  try {
    res = await http.get(url)
  } catch (err) {
    if (err instanceof HttpError) return null
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

/**
 * Find feeds for a URL: the URL itself, feeds declared by the page, then well-known paths.
 * Every returned feed has been fetched and parsed.
 */
export async function discoverFeeds(
  http: HttpClient,
  input: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredFeed[]> {
  const maxCandidates = options.maxCandidates ?? 5
  const url = withScheme(input)
  const direct = await tryFeed(http, url)
  if (direct) return [direct]

  const page = await http
    .get(url, { accept: 'text/html, application/xhtml+xml, */*;q=0.5' })
    .catch((err) => {
      if (err instanceof HttpError) return null
      throw err
    })
  const found: DiscoveredFeed[] = []
  const seen = new Set<string>()
  const consider = async (candidate: string) => {
    if (seen.has(candidate) || found.length >= maxCandidates) return
    seen.add(candidate)
    const feed = await tryFeed(http, candidate)
    if (feed && !found.some((f) => f.url === feed.url)) found.push(feed)
  }

  if (page && page.status === 200 && page.body) {
    for (const link of findFeedLinks(page.body, page.finalUrl).slice(0, maxCandidates)) {
      await consider(link.url)
    }
  }
  if (found.length === 0) {
    const origin = normalizeOrigin(page?.finalUrl ?? url)
    if (origin) {
      for (const candidate of candidateFeedUrls(origin)) {
        await consider(candidate)
        if (found.length > 0) break
      }
    }
  }
  return found
}
