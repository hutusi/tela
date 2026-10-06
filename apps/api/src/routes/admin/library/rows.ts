/**
 * The library's rows as the console reads them: a blog, a claim on one, a feed. Each is a select
 * over its table and the few joins that name people, and a mapping to the contract's shape that
 * also says which actions apply to the row now. Lists and records read the same columns, so a row
 * in a ledger and the same row in a record never disagree.
 */
import type { ClaimMethod, ClaimStatus, FeedFormat, FeedStatus, FetchRegion } from '@tela/shared'
import type { AdminActionName, AdminClaimRow, AdminFeedRow, AdminSiteRow } from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { like, personOf } from './common'

/** A claim that failed and that no operator has looked at since it last failed (alias `c`). */
export const NEEDS_REVIEW = sql`(c.status = 'failed'
  and (c.reviewed_at is null or c.reviewed_at < c.last_checked_at))`

/**
 * How bad a feed's state is (alias `f`), for a site's worst: dead, then failing, then timing out
 * (which the relay may fix), then paused by an operator, then fine. Merged feeds are left out by
 * the callers: their state is the feed they merged into.
 */
const FEED_RANK = sql`(case when f.status = 'dead' then 4 when f.status = 'paused' then 1
  when f.timeout_streak >= 3 then 2 when f.error_count > 0 then 3 else 0 end)`
const HEALTH_BY_RANK = ['ok', 'paused', 'timeout', 'failing', 'dead'] as const

/** A feed in trouble: failing, timing out or dead (alias `f`). */
const FEED_TROUBLE = sql`(f.status = 'dead'
  or (f.status = 'active' and (f.error_count > 0 or f.timeout_streak >= 3)))`

// ---------------------------------------------------------------------------------------------
// Sites

/**
 * Every column a site row needs, from `sites s left join profiles op` (the owner), with what its
 * feeds brought since `since` (30 days back) and its newest post. Never who added it (ADR 0039).
 * The post subqueries are index seeks per feed (`articles_feed_sort_idx`), as on Discover.
 */
export const siteSelect = (since: number) => sql`
  select s.id, s.title, s.home_url, s.favicon_key, s.listing, s.claimed_by,
    op.handle as owner_handle, op.display_name as owner_name, s.reader_count, s.primary_lang,
    s.translation_opt_out, s.created_at, s.description, s.claimed_at, s.reviewed_at,
    (select count(*) from feeds f where f.site_id = s.id and f.merged_into is null) as feed_count,
    (select max(${FEED_RANK}) from feeds f where f.site_id = s.id and f.merged_into is null)
      as feed_rank,
    exists (select 1 from feeds f where f.site_id = s.id and f.status = 'active') as fetchable,
    exists (select 1 from feeds f where f.site_id = s.id and f.status = 'active'
      and f.error_count > 0) as fetch_helps,
    exists (select 1 from site_claims c where c.site_id = s.id and ${NEEDS_REVIEW})
      as claim_failing,
    (select json_group_array(t.topic) from site_topics t where t.site_id = s.id) as topics,
    (select count(*) from articles a join feeds f on f.id = a.feed_id
      where f.site_id = s.id and f.merged_into is null and a.sort_at >= ${since}) as posts_30d,
    (select a.title from articles a join feeds f on f.id = a.feed_id
      where f.site_id = s.id and f.merged_into is null
      order by a.sort_at desc, a.id desc limit 1) as latest_title,
    (select max(a.sort_at) from articles a join feeds f on f.id = a.feed_id
      where f.site_id = s.id and f.merged_into is null) as latest_at
  from sites s left join profiles op on op.user_id = s.claimed_by`

export type SiteRaw = {
  id: number
  title: string | null
  home_url: string
  favicon_key: string | null
  listing: AdminSiteRow['listing']
  claimed_by: string | null
  owner_handle: string | null
  owner_name: string | null
  reader_count: number
  primary_lang: string | null
  translation_opt_out: number
  created_at: number
  description: string | null
  claimed_at: number | null
  reviewed_at: number | null
  feed_count: number
  feed_rank: number | null
  fetchable: number
  fetch_helps: number
  claim_failing: number
  topics: string
  posts_30d: number
  latest_title: string | null
  latest_at: number | null
}

/** A site that needs attention (alias `s`): a feed in trouble, or a claim to review. */
export const SITE_ATTENTION = sql`(exists (select 1 from feeds f where f.site_id = s.id and
  ${FEED_TROUBLE}) or exists (select 1 from site_claims c where c.site_id = s.id and ${NEEDS_REVIEW}))`

/** A site matching a search (alias `s`, owner `op`): its title, address, a feed's, or its owner. */
export function siteMatches(pattern: string | null): SQL {
  if (pattern === null) return sql`true`
  return sql`(${like(sql`s.title`, pattern)} or ${like(sql`s.home_url`, pattern)}
    or ${like(sql`op.handle`, pattern)}
    or exists (select 1 from feeds f where f.site_id = s.id and ${like(sql`f.feed_url`, pattern)}))`
}

/**
 * A private blog nobody claimed and no operator has decided about yet: one Not for Discover
 * applies to (ADR 0041). The review queue is these, narrowed to ones read and fetched.
 */
export const undecided = (raw: Pick<SiteRaw, 'listing' | 'claimed_by' | 'reviewed_at'>) =>
  raw.listing === 'private' && raw.claimed_by === null && raw.reviewed_at === null

/**
 * What a site's listing lets an operator do, the likeliest first. `private` is never offered. In
 * Discover, an undecided blog asks the review queue's question first: list it, or not for
 * Discover; Feature and Hide are the stronger answers either way. Sites leaves that question to
 * Discover, and keeps room for Fetch all feeds.
 */
export function listingActions(
  raw: Pick<SiteRaw, 'listing' | 'claimed_by' | 'reviewed_at'>,
  area: 'sites' | 'discover',
): AdminActionName[] {
  switch (raw.listing) {
    case 'featured':
      return ['site.restore', 'site.hide']
    case 'listed':
      return ['site.feature', 'site.hide']
    case 'private':
      return area === 'discover' && undecided(raw)
        ? ['site.list', 'site.dismiss', 'site.feature', 'site.hide']
        : ['site.feature', 'site.list', 'site.hide']
    case 'rejected':
      return ['site.restore']
  }
}

/**
 * A site row. The Sites ledger adds Fetch all feeds when the site has a feed to fetch, first when
 * one of them is failing (the likeliest fix), and keeps four, since keys 1 to 3 act on the first.
 * Discover offers the listing alone.
 */
export function siteRow(raw: SiteRaw, area: 'sites' | 'discover'): AdminSiteRow {
  let actions = listingActions(raw, area)
  if (area === 'sites' && raw.fetchable === 1) {
    actions = raw.fetch_helps === 1 ? ['site.fetchAll', ...actions] : [...actions, 'site.fetchAll']
  }
  let topics: string[] = []
  try {
    topics = (JSON.parse(raw.topics) as string[]).sort()
  } catch {}
  return {
    id: String(raw.id),
    actions: actions.slice(0, 4),
    siteId: raw.id,
    title: raw.title,
    homeUrl: raw.home_url,
    faviconKey: raw.favicon_key,
    listing: raw.listing,
    owner: personOf(raw.claimed_by, raw.owner_handle, raw.owner_name),
    readerCount: raw.reader_count,
    feedCount: raw.feed_count,
    feedHealth: raw.feed_rank === null ? 'none' : (HEALTH_BY_RANK[raw.feed_rank] ?? 'ok'),
    claimFailing: raw.claim_failing === 1,
    primaryLang: raw.primary_lang,
    translationOptOut: raw.translation_opt_out === 1,
    topics,
    createdAt: raw.created_at,
    postsLast30d: raw.posts_30d,
    latestTitle: raw.latest_title,
    latestAt: raw.latest_at,
    reviewedAt: raw.reviewed_at,
  }
}

// ---------------------------------------------------------------------------------------------
// Claims

/**
 * Every column a claim row needs: the claim, its site, its claimant (`cp`), the site's owner when
 * that is someone else (`op`, a dispute), and its check's lease while one is held or backing off.
 */
export const CLAIM_SELECT = sql`
  select c.id, c.site_id, s.title, s.home_url, s.favicon_key, s.reader_count, c.user_id,
    cp.handle as claimant_handle, cp.display_name as claimant_name,
    op.user_id as owner_id, op.handle as owner_handle, op.display_name as owner_name,
    c.method, c.status, c.error, c.vouched_by, c.created_at, c.last_checked_at, c.verified_at,
    c.reviewed_at, substr(c.token, 1, 8) as token_head,
    l.attempts as lease_attempts, l.until as lease_until, l.not_before as lease_not_before
  from site_claims c join sites s on s.id = c.site_id
  left join profiles cp on cp.user_id = c.user_id
  left join profiles op on op.user_id = s.claimed_by and s.claimed_by <> c.user_id
  left join leases l on l.kind = 'site.claim' and l.key = cast(c.id as text)`

export type ClaimRaw = {
  id: number
  site_id: number
  title: string | null
  home_url: string
  favicon_key: string | null
  reader_count: number
  user_id: string
  claimant_handle: string | null
  claimant_name: string | null
  owner_id: string | null
  owner_handle: string | null
  owner_name: string | null
  method: ClaimMethod
  status: ClaimStatus
  error: string | null
  vouched_by: string | null
  created_at: number
  last_checked_at: number | null
  verified_at: number | null
  reviewed_at: number | null
  token_head: string
  lease_attempts: number | null
  lease_until: number | null
  lease_not_before: number | null
}

/** A claim matching a search (aliases as `CLAIM_SELECT`): its blog, a feed of it, either member. */
export function claimMatches(pattern: string | null): SQL {
  if (pattern === null) return sql`true`
  return sql`(${like(sql`s.title`, pattern)} or ${like(sql`s.home_url`, pattern)}
    or ${like(sql`cp.handle`, pattern)} or ${like(sql`op.handle`, pattern)}
    or exists (select 1 from feeds f where f.site_id = s.id and ${like(sql`f.feed_url`, pattern)}))`
}

const needsReview = (raw: ClaimRaw) =>
  raw.status === 'failed' &&
  (raw.reviewed_at === null ||
    (raw.last_checked_at !== null && raw.reviewed_at < raw.last_checked_at))

/**
 * What can be done to a claim. Vouching is not offered on a blog someone else owns (it would
 * answer `taken`), and Dismiss only while the claim waits for review.
 */
function claimActions(raw: ClaimRaw): AdminActionName[] {
  if (raw.status === 'verified') return ['claim.remove']
  const vouch: AdminActionName[] = raw.owner_id === null ? ['claim.vouch'] : []
  if (raw.status === 'pending') return [...vouch, 'claim.reject']
  return [
    'claim.recheck',
    ...vouch,
    'claim.reject',
    ...(needsReview(raw) ? (['claim.dismiss'] as const) : []),
  ]
}

export function claimRow(raw: ClaimRaw, now: number): AdminClaimRow {
  // A lease given back for a retry waits until `not_before`; a held one is running now.
  const backingOff = raw.lease_until !== null && raw.lease_until < now
  return {
    id: String(raw.id),
    actions: claimActions(raw),
    claimId: raw.id,
    siteId: raw.site_id,
    siteTitle: raw.title,
    homeUrl: raw.home_url,
    faviconKey: raw.favicon_key,
    claimant: personOf(raw.user_id, raw.claimant_handle, raw.claimant_name),
    owner: personOf(raw.owner_id, raw.owner_handle, raw.owner_name),
    method: raw.method,
    status: raw.status,
    error: raw.error,
    vouched: raw.vouched_by !== null,
    createdAt: raw.created_at,
    lastCheckedAt: raw.last_checked_at,
    verifiedAt: raw.verified_at,
    reviewedAt: raw.reviewed_at,
    attempts: raw.lease_attempts,
    nextTry: backingOff ? raw.lease_not_before : null,
    readerCount: raw.reader_count,
  }
}

// ---------------------------------------------------------------------------------------------
// Feeds

/** Every column a feed row needs, from `feeds f join sites s`, with the site's owner (`op`). */
export const FEED_SELECT = sql`
  select f.id, f.site_id, s.title as site_title, s.home_url, s.favicon_key, f.feed_url, f.format,
    f.status,
    f.fetch_region, f.error_count, f.timeout_streak, f.last_error, f.last_fetched_at,
    f.last_item_at, f.next_fetch_at, f.merged_into, s.claimed_by as owner_id,
    op.handle as owner_handle, op.display_name as owner_name,
    (select count(*) from subscriptions sub where sub.feed_id = f.id and sub.deleted_at is null)
      as reader_count
  from feeds f join sites s on s.id = f.site_id
  left join profiles op on op.user_id = s.claimed_by`

export type FeedRaw = {
  id: number
  site_id: number
  site_title: string | null
  home_url: string
  favicon_key: string | null
  feed_url: string
  format: FeedFormat | null
  status: FeedStatus
  fetch_region: FetchRegion
  error_count: number
  timeout_streak: number
  last_error: string | null
  last_fetched_at: number | null
  last_item_at: number | null
  next_fetch_at: number
  merged_into: number | null
  owner_id: string | null
  owner_handle: string | null
  owner_name: string | null
  reader_count: number
}

/** A feed matching a search: its address, its blog's title or address, or the blog's owner. */
export function feedMatches(pattern: string | null): SQL {
  if (pattern === null) return sql`true`
  return sql`(${like(sql`f.feed_url`, pattern)} or ${like(sql`s.title`, pattern)}
    or ${like(sql`s.home_url`, pattern)} or ${like(sql`op.handle`, pattern)})`
}

/**
 * What can be done to a feed. A merged feed is read-only: its next fetch would merge it again
 * (ADR 0028). The relay is offered only where one is configured; going back to fetching directly
 * always is, since a feed set to the relay without one cannot be fetched at all.
 */
function feedActions(raw: FeedRaw, relay: boolean): AdminActionName[] {
  if (raw.merged_into !== null) return []
  if (raw.status === 'dead') return ['feed.revive']
  if (raw.status === 'paused') return ['feed.resume']
  const region: AdminActionName[] =
    raw.fetch_region === 'cn' ? ['feed.global'] : relay ? ['feed.relay'] : []
  return ['feed.fetch', 'feed.pause', ...region]
}

export function feedRow(raw: FeedRaw, relay: boolean): AdminFeedRow {
  return {
    id: String(raw.id),
    actions: feedActions(raw, relay),
    feedId: raw.id,
    siteId: raw.site_id,
    siteTitle: raw.site_title,
    homeUrl: raw.home_url,
    faviconKey: raw.favicon_key,
    feedUrl: raw.feed_url,
    format: raw.format,
    status: raw.status,
    region: raw.fetch_region,
    errorCount: raw.error_count,
    timeoutStreak: raw.timeout_streak,
    lastError: raw.last_error,
    lastFetchedAt: raw.last_fetched_at,
    lastItemAt: raw.last_item_at,
    nextFetchAt: raw.next_fetch_at,
    mergedInto: raw.merged_into,
    owner: personOf(raw.owner_id, raw.owner_handle, raw.owner_name),
    readerCount: raw.reader_count,
  }
}

/**
 * Whether tela-jobs runs with the China relay, from its tick's heartbeat (the tick reports its
 * switches there). A heartbeat that does not say counts as no relay. One row, or none.
 */
export const RELAY_SELECT = sql`
  select coalesce(json_extract(info, '$.config.relay'), 0) as relay
  from ops_heartbeats where name = 'tick'`

export const relayOf = (rows: unknown): boolean =>
  Array.isArray(rows) && (rows[0] as { relay?: unknown } | undefined)?.relay === 1
