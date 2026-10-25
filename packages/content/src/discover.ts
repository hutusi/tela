import { findAll, getAttributeValue, textContent } from 'domutils'
import { parseDocument } from 'htmlparser2'
import { absoluteUrl } from './url'

const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'application/feed+json',
  'application/json',
  'text/xml',
  'application/xml',
])

/** Paths probed when a page declares no feed link. Ordered by how common they are. */
export const COMMON_FEED_PATHS = [
  '/feed',
  '/feed/',
  '/rss.xml',
  '/atom.xml',
  '/feed.xml',
  '/index.xml',
  '/rss',
  '/feed.json',
  '/feed/atom/',
  '/blog/feed',
  '/blog/rss.xml',
  '/posts/index.xml',
] as const

export type FeedCandidate = {
  url: string
  title: string | null
  type: string | null
  /** 'link' for declared alternates, 'anchor' for feed-looking hrefs in the body. */
  source: 'link' | 'anchor'
}

/** Feed URLs declared or hinted by an HTML page, best first, without duplicates. */
export function findFeedLinks(html: string, baseUrl: string): FeedCandidate[] {
  const doc = parseDocument(html)
  const out: FeedCandidate[] = []
  const seen = new Set<string>()
  const push = (c: FeedCandidate) => {
    if (seen.has(c.url)) return
    seen.add(c.url)
    out.push(c)
  }

  for (const link of findAll((el) => el.name === 'link', doc.children)) {
    const rel = (getAttributeValue(link, 'rel') ?? '').toLowerCase().split(/\s+/)
    const type = (getAttributeValue(link, 'type') ?? '').toLowerCase().split(';')[0]?.trim() ?? ''
    if (!rel.includes('alternate') || !FEED_TYPES.has(type)) continue
    const url = absoluteUrl(getAttributeValue(link, 'href') ?? '', baseUrl)
    if (!url) continue
    push({ url, title: getAttributeValue(link, 'title') ?? null, type, source: 'link' })
  }

  for (const a of findAll((el) => el.name === 'a', doc.children)) {
    const href = getAttributeValue(a, 'href') ?? ''
    if (!/(rss|atom|feed)(\.xml|\.json)?\/?$/i.test(href.split('?')[0] ?? '')) continue
    const url = absoluteUrl(href, baseUrl)
    if (!url) continue
    push({ url, title: textContent(a).trim() || null, type: null, source: 'anchor' })
  }

  return out
}

/**
 * Where a `<meta http-equiv="refresh">` sends the page, when that is another page. Hugo makes such
 * a page of a multilingual site's root and of every alias, and declares the feed only at the
 * target: byvoid.com's home sends to `/zht/`, which names `zht/feed.xml`. A refresh with no URL,
 * or back to the page itself, sends nowhere.
 */
export function findMetaRefresh(html: string, baseUrl: string): string | null {
  const doc = parseDocument(html)
  const here = absoluteUrl(baseUrl)?.split('#')[0]
  for (const meta of findAll((el) => el.name === 'meta', doc.children)) {
    if ((getAttributeValue(meta, 'http-equiv') ?? '').trim().toLowerCase() !== 'refresh') continue
    // "0; url=/zht/", "0;URL='/zht/'", or "0; /zht/": a delay, then the target.
    const target = (getAttributeValue(meta, 'content') ?? '').match(
      /^\s*\d*(?:\.\d*)?\s*[;,]\s*(?:url\s*=\s*)?(['"]?)(.*?)\1\s*$/i,
    )?.[2]
    const url = target ? absoluteUrl(target, baseUrl) : null
    if (url && url.split('#')[0] !== here) return url
  }
  return null
}

/** Well-known feed locations for a site origin. */
export function candidateFeedUrls(origin: string): string[] {
  return COMMON_FEED_PATHS.map((p) => new URL(p, origin).toString())
}
