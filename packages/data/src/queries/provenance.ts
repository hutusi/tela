/**
 * Whether a site vouches for a feed (ADR 0011). Pure; the same rules the Postgres layer had.
 * An unclaimed site is a placeholder and vouches for anything. A claimed site vouches for a feed
 * the claimant added, one served from the site's own origin, or one its home page declares.
 */
export type ProvenanceFeed = {
  feedUrl: string
  servedOrigin: string | null
  addedBy: string | null
}
export type ProvenanceSite = {
  homeUrl: string
  claimedBy: string | null
  declaredFeedUrls: string[]
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin.toLowerCase() : null
  } catch {
    return null
  }
}

/** Where a feed's content comes from: the origin that last served it, or its URL's origin. */
export function feedOrigin(feed: Pick<ProvenanceFeed, 'feedUrl' | 'servedOrigin'>): string | null {
  return feed.servedOrigin ?? originOf(feed.feedUrl)
}

export function feedIsVouched(feed: ProvenanceFeed, site: ProvenanceSite): boolean {
  if (site.claimedBy === null) return true
  if (feed.addedBy !== null && feed.addedBy === site.claimedBy) return true
  if (feed.servedOrigin !== null && feed.servedOrigin === site.homeUrl) return true
  return site.declaredFeedUrls.includes(feed.feedUrl)
}
