/**
 * The rows the Overview's queues show, each as complete as its ledger's own (the contract's
 * claim, feed, site and dead-letter rows), so a click opens the same record. The library ledgers
 * build these rows for their lists too; these statements are the Overview's own.
 */
import { isRedueKind, type TelaDb } from '@tela/data'
import type {
  ClaimMethod,
  ClaimStatus,
  FeedFormat,
  FeedStatus,
  FetchRegion,
  SiteListing,
} from '@tela/shared'
import type {
  AdminActionName,
  AdminClaimRow,
  AdminDeadRow,
  AdminFeedRow,
  AdminPerson,
  AdminSiteRow,
} from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { type Names, targetOf } from './names'

type Row = Record<string, unknown>

const num = (v: unknown): number => Number(v ?? 0)
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** A member from `<prefix>_id`, `<prefix>_handle` and `<prefix>_name` columns, or null. */
function person(row: Row, prefix: string): AdminPerson | null {
  const id = row[`${prefix}_id`]
  const handle = row[`${prefix}_handle`]
  if (id === null || id === undefined || handle === null || handle === undefined) return null
  return { id: String(id), handle: String(handle), name: strOrNull(row[`${prefix}_name`]) }
}

/** A failed claim no operator has looked at since it was last checked. */
export const CLAIM_NEEDS_REVIEW = sql`c.status = 'failed'
  and (c.reviewed_at is null or c.reviewed_at < c.last_checked_at)`

/** A feed that is failing or timing out, while it is still being fetched. */
export const FEED_FAILING = sql`f.status = 'active' and (f.error_count > 0 or f.timeout_streak >= 3)`

/** A blog Discover could list: nobody has claimed it, and the doors keep it private. */
export const DISCOVER_CANDIDATE = sql`s.listing = 'private' and s.claimed_by is null`

export const DEAD_UNRESOLVED = sql`d.resolved_at is null`

/** Claims, with their claimant, a different owner (a dispute) and their lease, `where` given. */
export function claimRows(db: TelaDb, now: number, where: SQL, order: SQL, limit: number) {
  return db.all(sql`
    select c.id, c.site_id, s.title as site_title, s.home_url,
      c.user_id as claimant_id, cp.handle as claimant_handle, cp.display_name as claimant_name,
      op.user_id as owner_id, op.handle as owner_handle, op.display_name as owner_name,
      c.method, c.status, c.error, c.vouched_by, c.created_at, c.last_checked_at, c.verified_at,
      c.reviewed_at, l.attempts, case when l.not_before > ${now} then l.not_before end as next_try,
      s.reader_count
    from site_claims c join sites s on s.id = c.site_id
    left join profiles cp on cp.user_id = c.user_id
    left join profiles op on op.user_id = s.claimed_by and s.claimed_by <> c.user_id
    left join leases l on l.kind = 'site.claim' and l.key = cast(c.id as text)
    where ${where}
    order by ${order}
    limit ${limit}
  `)
}

export function toClaimRow(row: Row, actions: AdminActionName[]): AdminClaimRow {
  return {
    id: String(row.id),
    actions,
    claimId: num(row.id),
    siteId: num(row.site_id),
    siteTitle: strOrNull(row.site_title),
    homeUrl: String(row.home_url),
    claimant: person(row, 'claimant'),
    owner: person(row, 'owner'),
    method: row.method as ClaimMethod,
    status: row.status as ClaimStatus,
    error: strOrNull(row.error),
    vouched: row.vouched_by !== null && row.vouched_by !== undefined,
    createdAt: num(row.created_at),
    lastCheckedAt: numOrNull(row.last_checked_at),
    verifiedAt: numOrNull(row.verified_at),
    reviewedAt: numOrNull(row.reviewed_at),
    attempts: numOrNull(row.attempts),
    nextTry: numOrNull(row.next_try),
    readerCount: num(row.reader_count),
  }
}

/** Feeds with their blog, its owner and how many members follow the feed, `where` given. */
export function feedRows(db: TelaDb, where: SQL, order: SQL, limit: number) {
  return db.all(sql`
    select f.id, f.site_id, s.title as site_title, s.home_url, f.feed_url, f.format, f.status,
      f.fetch_region, f.error_count, f.timeout_streak, f.last_error, f.last_fetched_at,
      f.last_item_at, f.next_fetch_at, f.merged_into,
      op.user_id as owner_id, op.handle as owner_handle, op.display_name as owner_name,
      (select count(*) from subscriptions r where r.feed_id = f.id and r.deleted_at is null)
        as reader_count
    from feeds f join sites s on s.id = f.site_id
    left join profiles op on op.user_id = s.claimed_by
    where ${where}
    order by ${order}
    limit ${limit}
  `)
}

export function toFeedRow(row: Row, actions: AdminActionName[]): AdminFeedRow {
  return {
    id: String(row.id),
    actions,
    feedId: num(row.id),
    siteId: num(row.site_id),
    siteTitle: strOrNull(row.site_title),
    homeUrl: String(row.home_url),
    feedUrl: String(row.feed_url),
    format: (row.format ?? null) as FeedFormat | null,
    status: row.status as FeedStatus,
    region: row.fetch_region as FetchRegion,
    errorCount: num(row.error_count),
    timeoutStreak: num(row.timeout_streak),
    lastError: strOrNull(row.last_error),
    lastFetchedAt: numOrNull(row.last_fetched_at),
    lastItemAt: numOrNull(row.last_item_at),
    nextFetchAt: num(row.next_fetch_at),
    mergedInto: numOrNull(row.merged_into),
    owner: person(row, 'owner'),
    readerCount: num(row.reader_count),
  }
}

/**
 * Sites with their owner, feeds and topics, `where` given. A feed merged into another is an
 * address, not a feed of its own, so it counts toward neither the feeds nor their health; the
 * worst state among the rest is the site's.
 */
export function siteRows(db: TelaDb, where: SQL, order: SQL, limit: number) {
  return db.all(sql`
    select s.id, s.title, s.home_url, s.favicon_key, s.listing, s.reader_count, s.primary_lang,
      s.translation_opt_out, s.created_at,
      op.user_id as owner_id, op.handle as owner_handle, op.display_name as owner_name,
      (select count(*) from feeds f where f.site_id = s.id and f.merged_into is null) as feed_count,
      (select case
          when count(*) = 0 then 'none'
          when sum(f.status = 'dead') > 0 then 'dead'
          when sum(f.status = 'active' and f.timeout_streak >= 3) > 0 then 'timeout'
          when sum(f.status = 'active' and f.error_count > 0) > 0 then 'failing'
          when sum(f.status = 'paused') > 0 then 'paused'
          else 'ok' end
        from feeds f where f.site_id = s.id and f.merged_into is null) as feed_health,
      exists (select 1 from site_claims c where c.site_id = s.id and ${CLAIM_NEEDS_REVIEW})
        as claim_failing,
      (select json_group_array(topic) from (
        select topic from site_topics t where t.site_id = s.id order by topic)) as topics
    from sites s
    left join profiles op on op.user_id = s.claimed_by
    where ${where}
    order by ${order}
    limit ${limit}
  `)
}

export function toSiteRow(row: Row, actions: AdminActionName[]): AdminSiteRow {
  let topics: string[] = []
  try {
    topics = (JSON.parse(String(row.topics ?? '[]')) as unknown[]).map(String)
  } catch {}
  return {
    id: String(row.id),
    actions,
    siteId: num(row.id),
    title: strOrNull(row.title),
    homeUrl: String(row.home_url),
    faviconKey: strOrNull(row.favicon_key),
    listing: row.listing as SiteListing,
    owner: person(row, 'owner'),
    readerCount: num(row.reader_count),
    feedCount: num(row.feed_count),
    feedHealth: row.feed_health as AdminSiteRow['feedHealth'],
    claimFailing: num(row.claim_failing) === 1,
    primaryLang: strOrNull(row.primary_lang),
    translationOptOut: num(row.translation_opt_out) === 1,
    topics,
    createdAt: num(row.created_at),
  }
}

/** Dead letters, `where` given (over `d`). */
export function deadRows(db: TelaDb, where: SQL, order: SQL, limit: number) {
  return db.all(sql`
    select d.id, d.kind, d.key, d.attempts, d.error, d.at, d.resolved_at, d.resolution
    from dead_letters d
    where ${where}
    order by ${order}
    limit ${limit}
  `)
}

/** What can be done to a dead letter: retried while unresolved and of a kind REDUE knows. */
export function deadActions(kind: string, resolved: boolean): AdminActionName[] {
  if (resolved) return []
  return isRedueKind(kind) ? ['dead.retry', 'dead.dismiss'] : ['dead.dismiss']
}

export function toDeadRow(row: Row, names: Names): AdminDeadRow {
  const kind = String(row.kind)
  const key = String(row.key)
  const resolvedAt = numOrNull(row.resolved_at)
  const resolution = row.resolution === 'retried' || row.resolution === 'dismissed'
  return {
    id: `dead:${num(row.id)}`,
    actions: deadActions(kind, resolvedAt !== null),
    type: 'dead',
    deadId: num(row.id),
    kind,
    key,
    attempts: num(row.attempts),
    error: strOrNull(row.error),
    at: num(row.at),
    resolvedAt,
    resolution: resolution ? (row.resolution as 'retried' | 'dismissed') : null,
    target: targetOf(names, kind, key),
  }
}
