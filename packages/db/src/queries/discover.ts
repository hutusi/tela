import { isTopic, type SiteListing } from '@tela/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { articles, feeds, profiles, siteClaims, sites, subscriptions } from '../schema'
import { detachUnvouchedFeeds } from './provenance'
import { likePattern, normalizeQuery } from './search'

const NO_USER = '00000000-0000-0000-0000-000000000000'

export type DiscoverSite = {
  id: number
  title: string
  homeUrl: string
  description: string | null
  faviconKey: string | null
  primaryLang: string | null
  listing: string
  claimed: boolean
  topics: string[]
  readerCount: number
  /** The site's primary feed (lowest id). */
  feedId: number | null
  latestTitle: string | null
  latestAt: Date | null
  postsLast30d: number
  /** Whether the user follows the site's primary feed (what the card's button toggles). */
  isSubscribed: boolean
}

export type DiscoverFilter = {
  topic?: string | null
  lang?: string | null
  userId?: string | null
  limit?: number
  /** Free-text match on name, host, and description (trigram ILIKE), ranked by name similarity. */
  query?: string | null
  /** Search only: also return private sites the user subscribes to, not just listed ones. */
  includeSubscribed?: boolean
}

/** Listed and featured sites for the Discover page, with what the card shows. */
export async function listDiscoverSites(
  db: Db,
  filter: DiscoverFilter = {},
): Promise<DiscoverSite[]> {
  const uid = filter.userId ?? NO_USER
  const topic = filter.topic && isTopic(filter.topic) ? filter.topic : null
  const lang = filter.lang?.trim() || null
  const query = normalizeQuery(filter.query ?? undefined)
  const pattern = likePattern(query)
  const visible = filter.includeSubscribed
    ? sql`(s.listing in ('listed', 'featured') or exists (
        select 1 from subscriptions sub join feeds f on f.id = sub.feed_id
        where f.site_id = s.id and sub.user_id = ${uid}))`
    : sql`s.listing in ('listed', 'featured')`
  const rows = await db.execute<{
    id: number
    title: string | null
    home_url: string
    description: string | null
    favicon_key: string | null
    primary_lang: string | null
    listing: string
    claimed_by: string | null
    topics: string[]
    reader_count: number
    feed_id: number | null
    latest_title: string | null
    latest_at: Date | null
    posts_30d: number
    subscribed: boolean
  }>(sql`
    select s.id, s.title, s.home_url, s.description, s.favicon_key, s.primary_lang, s.listing,
           s.claimed_by, s.topics, s.reader_count,
           pf.id as feed_id,
           la.title as latest_title, la.at as latest_at,
           coalesce(p30.n, 0)::int as posts_30d,
           exists (
             select 1 from subscriptions sub where sub.feed_id = pf.id and sub.user_id = ${uid}
           ) as subscribed
    from sites s
    left join lateral (select f.id from feeds f where f.site_id = s.id order by f.id limit 1) pf on true
    left join lateral (
      select a.title, coalesce(a.published_at, a.fetched_at) as at
      from articles a join feeds f on f.id = a.feed_id
      where f.site_id = s.id order by 2 desc limit 1
    ) la on true
    left join lateral (
      select count(*) as n from articles a join feeds f on f.id = a.feed_id
      where f.site_id = s.id and coalesce(a.published_at, a.fetched_at) > now() - interval '30 days'
    ) p30 on true
    where ${visible}
      ${topic ? sql`and ${topic} = any(s.topics)` : sql``}
      ${lang ? sql`and s.primary_lang = ${lang}` : sql``}
      ${
        query
          ? sql`and (s.title ilike ${pattern} or s.home_url ilike ${pattern}
                     or coalesce(s.description, '') ilike ${pattern}
                     or exists (select 1 from feeds ft where ft.site_id = s.id
                                and coalesce(ft.title, '') ilike ${pattern}))`
          : sql``
      }
    order by ${query ? sql`similarity(coalesce(s.title, ''), ${query}) desc,` : sql``}
             (s.listing = 'featured') desc, (s.claimed_by is not null) desc,
             s.reader_count desc, s.id
    limit ${Math.min(filter.limit ?? 60, 200)}
  `)
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title ?? r.home_url.replace(/^https?:\/\//, ''),
    homeUrl: r.home_url,
    description: r.description,
    faviconKey: r.favicon_key,
    primaryLang: r.primary_lang,
    listing: r.listing,
    claimed: r.claimed_by !== null,
    topics: r.topics ?? [],
    readerCount: Number(r.reader_count),
    feedId: r.feed_id === null ? null : Number(r.feed_id),
    latestTitle: r.latest_title,
    latestAt: r.latest_at ? new Date(r.latest_at) : null,
    postsLast30d: Number(r.posts_30d),
    isSubscribed: r.subscribed,
  }))
}

/** Languages of listed sites (optionally within a topic), for the language menu. */
export async function discoverLanguageCounts(
  db: Db,
  topic?: string | null,
): Promise<Array<{ lang: string; count: number }>> {
  const t = topic && isTopic(topic) ? topic : null
  const rows = await db.execute<{ lang: string; n: number }>(sql`
    select primary_lang as lang, count(*)::int as n from sites
    where listing in ('listed', 'featured') and primary_lang is not null
      ${t ? sql`and ${t} = any(topics)` : sql``}
    group by primary_lang order by n desc, primary_lang
  `)
  return rows.map((r) => ({ lang: r.lang, count: Number(r.n) }))
}

export type SitePage = {
  site: typeof sites.$inferSelect
  feeds: Array<{ id: number; feedUrl: string; title: string | null; isSubscribed: boolean }>
  articles: Array<{
    id: number
    title: string
    publishedAt: Date | null
    fetchedAt: Date
    sourceLang: string | null
  }>
  claimant: { handle: string; displayName: string | null } | null
  isOwner: boolean
}

/** Everything the public site page shows. */
export async function getSitePage(
  db: Db,
  siteId: number,
  userId: string | null,
): Promise<SitePage | null> {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId))
  if (!site) return null
  const uid = userId ?? NO_USER
  const feedRows = await db
    .select({
      id: feeds.id,
      feedUrl: feeds.feedUrl,
      title: feeds.title,
      subscribedFeedId: subscriptions.feedId,
    })
    .from(feeds)
    .leftJoin(subscriptions, and(eq(subscriptions.feedId, feeds.id), eq(subscriptions.userId, uid)))
    .where(eq(feeds.siteId, siteId))
    .orderBy(feeds.id)
  const recent = await db
    .select({
      id: articles.id,
      title: articles.title,
      publishedAt: articles.publishedAt,
      fetchedAt: articles.fetchedAt,
      sourceLang: articles.sourceLang,
    })
    .from(articles)
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(eq(feeds.siteId, siteId))
    .orderBy(desc(sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt})`), desc(articles.id))
    .limit(20)
  let claimant: SitePage['claimant'] = null
  if (site.claimedBy) {
    const [p] = await db
      .select({ handle: profiles.handle, displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, site.claimedBy))
    claimant = p ?? null
  }
  return {
    site,
    feeds: feedRows.map((f) => ({
      id: f.id,
      feedUrl: f.feedUrl,
      title: f.title,
      isSubscribed: f.subscribedFeedId !== null,
    })),
    articles: recent,
    claimant,
    isOwner: userId !== null && site.claimedBy === userId,
  }
}

export type ClaimRow = typeof siteClaims.$inferSelect

function randomToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The user's claim on a site, created pending if none exists. Verified claims are returned as
 * is. The unique (site, user) index makes concurrent calls converge on one row.
 */
export async function getOrCreateClaim(db: Db, siteId: number, userId: string): Promise<ClaimRow> {
  const [inserted] = await db
    .insert(siteClaims)
    .values({ siteId, userId, method: 'meta', token: randomToken(), status: 'pending' })
    .onConflictDoNothing({ target: [siteClaims.siteId, siteClaims.userId] })
    .returning()
  if (inserted) return inserted
  const [existing] = await db
    .select()
    .from(siteClaims)
    .where(and(eq(siteClaims.siteId, siteId), eq(siteClaims.userId, userId)))
  if (!existing) throw new Error(`claim for site ${siteId} vanished`)
  return existing
}

export async function getClaim(db: Db, claimId: number): Promise<ClaimRow | null> {
  const [row] = await db.select().from(siteClaims).where(eq(siteClaims.id, claimId))
  return row ?? null
}

/** Reset a failed claim to pending before re-verification. */
export async function resetClaim(db: Db, claimId: number): Promise<void> {
  await db
    .update(siteClaims)
    .set({ status: 'pending', error: null })
    .where(eq(siteClaims.id, claimId))
}

export type ClaimResultOutcome = 'verified' | 'failed' | 'conflict' | 'missing'

/**
 * Record the verifier's result; on success the site becomes claimed and listed. The site row is
 * locked and its owner checked in the same transaction, so a later verifier (a co-author whose
 * rel="me" link is also on the page, or a domain's next owner) cannot take a site away from the
 * member who already proved control of it: that claim fails as `conflict` instead.
 */
export async function markClaimResult(
  db: Db,
  claimId: number,
  result:
    | { ok: true; method: 'meta' | 'rel_me'; declaredFeedUrls?: string[] }
    | { ok: false; error: string },
): Promise<ClaimResultOutcome> {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(siteClaims)
      .where(eq(siteClaims.id, claimId))
      .for('update')
    if (!claim) return 'missing'
    const now = new Date()
    const fail = async (error: string) => {
      await tx
        .update(siteClaims)
        .set({ status: 'failed', error: error.slice(0, 500), lastCheckedAt: now })
        .where(eq(siteClaims.id, claimId))
    }
    if (!result.ok) {
      await fail(result.error)
      return 'failed'
    }
    const [site] = await tx
      .select({ claimedBy: sites.claimedBy })
      .from(sites)
      .where(eq(sites.id, claim.siteId))
      .for('update')
    if (!site) return 'missing'
    if (site.claimedBy !== null && site.claimedBy !== claim.userId) {
      await fail('site already claimed by another member')
      return 'conflict'
    }
    await tx
      .update(siteClaims)
      .set({
        status: 'verified',
        method: result.method,
        error: null,
        lastCheckedAt: now,
        verifiedAt: now,
      })
      .where(eq(siteClaims.id, claimId))
    await tx
      .update(sites)
      .set({
        claimedBy: claim.userId,
        claimedAt: now,
        listing: sql`case when ${sites.listing} = 'private' then 'listed'::site_listing else ${sites.listing} end`,
        declaredFeedUrls: result.declaredFeedUrls ?? [],
      })
      .where(eq(sites.id, claim.siteId))
    // Feeds that joined while the site was unclaimed, and that the owner's home page does not
    // declare, move to the origin that serves them.
    await detachUnvouchedFeeds(tx, claim.siteId)
    return 'verified'
  })
}

/** Claimants curate their site's topics (validated against the fixed list). */
export async function setSiteTopics(
  db: Db,
  siteId: number,
  userId: string,
  topics: string[],
): Promise<boolean> {
  const valid = [...new Set(topics.filter(isTopic))]
  const rows = await db
    .update(sites)
    .set({ topics: valid })
    .where(and(eq(sites.id, siteId), eq(sites.claimedBy, userId)))
    .returning({ id: sites.id })
  return rows.length > 0
}

/** Sites whose assets have never been checked (for the assets job). */
export async function siteNeedsAssets(db: Db, siteId: number): Promise<boolean> {
  const [row] = await db
    .select({ checked: sites.assetsCheckedAt })
    .from(sites)
    .where(eq(sites.id, siteId))
  return row !== undefined && row.checked === null
}

export type CurateSiteInput = {
  /** New listing. Seeding only ever passes 'featured'. */
  listing?: SiteListing
  /** Editorial topics, applied only while the site is unclaimed. */
  topics?: string[]
  /** Also move a 'rejected' site. Seeding never passes this. */
  force?: boolean
  /** Compute the result without writing, so a preview cannot drift from what a run would do. */
  dryRun?: boolean
}

export type CurateSiteResult = {
  siteId: number
  /** State after the call. */
  listing: SiteListing
  topics: string[]
  listingChanged: boolean
  topicsChanged: boolean
  claimed: boolean
  /** Why a requested write was withheld. */
  withheld: 'rejected' | 'claimed' | null
}

/**
 * The operator's curation write: the counterpart to `setSiteTopics`, which belongs to the
 * claimant and so cannot serve the editorial seed. Three rules make a re-run safe:
 *
 * - **Topics are written only while the site is unclaimed.** A claimant curates their own
 *   topics, including choosing to have none, and a seed re-run must not stomp that.
 * - **`rejected` is sticky.** Hiding a site is a deliberate operator act; only `force` undoes it.
 * - **No-op writes are skipped**, so `updated_at` does not churn when nothing changed.
 *
 * It does not encode "never downgrade" — un-featuring has to be possible — so a caller that
 * wants monotonic promotion gets it by only ever passing a higher listing.
 */
export async function curateSite(
  db: Db,
  siteId: number,
  input: CurateSiteInput,
): Promise<CurateSiteResult | null> {
  const wanted = input.topics === undefined ? null : [...new Set(input.topics.filter(isTopic))]
  return db.transaction(async (tx) => {
    const [site] = await tx
      .select({ listing: sites.listing, topics: sites.topics, claimedBy: sites.claimedBy })
      .from(sites)
      .where(eq(sites.id, siteId))
      .for('update')
    if (!site) return null
    const claimed = site.claimedBy !== null
    const rejected = site.listing === 'rejected' && input.force !== true
    const nextListing =
      input.listing === undefined || rejected || input.listing === site.listing
        ? null
        : input.listing
    const nextTopics = wanted === null || claimed || sameTopics(site.topics, wanted) ? null : wanted
    if (!input.dryRun && (nextListing !== null || nextTopics !== null)) {
      await tx
        .update(sites)
        .set({
          ...(nextListing === null ? {} : { listing: nextListing }),
          ...(nextTopics === null ? {} : { topics: nextTopics }),
        })
        .where(eq(sites.id, siteId))
    }
    return {
      siteId,
      listing: nextListing ?? site.listing,
      topics: nextTopics ?? site.topics,
      listingChanged: nextListing !== null,
      topicsChanged: nextTopics !== null,
      claimed,
      withheld: rejected ? 'rejected' : wanted !== null && claimed ? 'claimed' : null,
    }
  })
}

function sameTopics(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}
