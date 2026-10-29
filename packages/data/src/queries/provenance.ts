/**
 * Whether a site vouches for a feed (ADR 0011). Pure; the same rules the Postgres layer had.
 * An unclaimed site is a placeholder and vouches for anything. A claimed site vouches for a feed
 * the claimant added, one served from the blog itself (its site key, so on a shared host a
 * writer's own path, ADR 0069), or one its home page declares.
 */
import { type BlogRules, siteKeyOf } from '@tela/shared'

export type ProvenanceFeed = {
  feedUrl: string
  /** The site key of the address that last served it (`feeds.served_origin`). */
  servedOrigin: string | null
  addedBy: string | null
}
export type ProvenanceSite = {
  homeUrl: string
  claimedBy: string | null
  declaredFeedUrls: string[]
}

/** The blog a feed's content comes from: the key it was last served from, or its URL's. */
export function feedHome(
  feed: Pick<ProvenanceFeed, 'feedUrl' | 'servedOrigin'>,
  rules?: BlogRules,
): string | null {
  return feed.servedOrigin ?? siteKeyOf(feed.feedUrl, rules)
}

export function feedIsVouched(feed: ProvenanceFeed, site: ProvenanceSite): boolean {
  if (site.claimedBy === null) return true
  if (feed.addedBy !== null && feed.addedBy === site.claimedBy) return true
  if (feed.servedOrigin !== null && feed.servedOrigin === site.homeUrl) return true
  return site.declaredFeedUrls.includes(feed.feedUrl)
}
