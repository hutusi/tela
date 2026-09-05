import { eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '../client'
import { feeds, sites } from '../schema'
import { recomputeSiteReaderCounts } from './reader'

export type ProvenanceFeed = {
  id: number
  siteId: number
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

/** Where a feed's content comes from: the origin that last served it, or its URL's origin before any fetch. */
export function feedOrigin(feed: Pick<ProvenanceFeed, 'feedUrl' | 'servedOrigin'>): string | null {
  return feed.servedOrigin ?? originOf(feed.feedUrl)
}

/**
 * Whether a site vouches for a feed. An unclaimed site is a placeholder and vouches for
 * anything; the cleanup happens when someone proves control. A claimed site vouches for a feed
 * that was served from the site's own origin, that its home page declares (`declared_feed_urls`,
 * recorded at verification), or that the claimant added. Nothing else may put posts under a
 * member's site: not a declared home, not a URL on the site's origin that redirects elsewhere,
 * and not a URL's origin alone while the feed has never been fetched (a same-origin URL maps
 * back to the same site anyway, so a legitimate unfetched feed loses nothing).
 */
export function feedIsVouched(
  feed: Pick<ProvenanceFeed, 'feedUrl' | 'servedOrigin' | 'addedBy'>,
  site: ProvenanceSite,
): boolean {
  if (site.claimedBy === null) return true
  if (feed.addedBy !== null && feed.addedBy === site.claimedBy) return true
  if (feed.servedOrigin !== null && feed.servedOrigin === site.homeUrl) return true
  return site.declaredFeedUrls.includes(feed.feedUrl)
}

/**
 * Re-point a feed to the site keyed by `origin`, creating it if needed (being served from an
 * origin is provenance for that origin's site, claimed or not), drop the site it left when that
 * was an empty unclaimed placeholder, and recount both sites. Returns the feed's site id after.
 */
export async function moveFeedToOriginSite(
  tx: DbExecutor,
  feed: Pick<ProvenanceFeed, 'id' | 'siteId'>,
  origin: string,
): Promise<number> {
  const [existing] = await tx.select({ id: sites.id }).from(sites).where(eq(sites.homeUrl, origin))
  let targetId = existing?.id
  if (targetId === undefined) {
    const [created] = await tx
      .insert(sites)
      .values({ homeUrl: origin })
      .onConflictDoNothing({ target: sites.homeUrl })
      .returning({ id: sites.id })
    targetId = created?.id
    if (targetId === undefined) {
      const [raced] = await tx.select({ id: sites.id }).from(sites).where(eq(sites.homeUrl, origin))
      targetId = raced?.id
    }
  }
  if (targetId === undefined || targetId === feed.siteId) return feed.siteId
  await tx.update(feeds).set({ siteId: targetId }).where(eq(feeds.id, feed.id))
  const [left] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(feeds)
    .where(eq(feeds.siteId, feed.siteId))
  const [old] = await tx
    .select({ claimedBy: sites.claimedBy })
    .from(sites)
    .where(eq(sites.id, feed.siteId))
  if ((left?.n ?? 0) === 0 && old?.claimedBy === null) {
    await tx.delete(sites).where(eq(sites.id, feed.siteId))
  }
  await recomputeSiteReaderCounts(tx, [feed.siteId, targetId])
  return targetId
}

/**
 * After a claim is verified: move every feed the new owner's site does not vouch for onto the
 * origin that serves it. A squatter that joined while the site was an unclaimed placeholder is
 * evicted the moment the real owner proves control. Returns how many feeds moved.
 */
export async function detachUnvouchedFeeds(tx: DbExecutor, siteId: number): Promise<number> {
  const [site] = await tx
    .select({
      homeUrl: sites.homeUrl,
      claimedBy: sites.claimedBy,
      declaredFeedUrls: sites.declaredFeedUrls,
    })
    .from(sites)
    .where(eq(sites.id, siteId))
  if (!site || site.claimedBy === null) return 0
  const rows = await tx
    .select({
      id: feeds.id,
      siteId: feeds.siteId,
      feedUrl: feeds.feedUrl,
      servedOrigin: feeds.servedOrigin,
      addedBy: feeds.addedBy,
    })
    .from(feeds)
    .where(eq(feeds.siteId, siteId))
  let moved = 0
  for (const feed of rows) {
    if (feedIsVouched(feed, site)) continue
    const origin = feedOrigin(feed)
    if (!origin) continue
    if ((await moveFeedToOriginSite(tx, feed, origin)) !== siteId) moved += 1
  }
  return moved
}
