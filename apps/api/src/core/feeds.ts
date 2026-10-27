/**
 * Adding feeds (ADRs 0024, 0063): the rules the web's `/api/v1/feeds` and the API's `/v1/feeds`
 * share (ADR 0065). Discovery and adding by URL go to tela-jobs' `Ingest` RPC, because they fetch;
 * an OPML import registers without fetching, and the sweeps fetch the feeds from there. Its
 * folders become the member's folders (ADR 0048).
 *
 * Each is held to the actor's limits: the hour's attempts (`ACTION_LIMITS`), feeds new to Tela a
 * day, and the subscription cap, unless the actor is exempt (an admin on the web; an app never
 * is, ADR 0064). A refusal says which limit, and when it lifts, so a surface can say when to try
 * again (`retryAfterSec`, `resetsAt`).
 */
import { asUrl, normalizeOrigin } from '@tela/content/url'
import {
  type Actor,
  type BroughtFeed,
  importFeeds as bringFeeds,
  claimDue,
  consumeLimit,
  dueFeeds,
  FEED_COLUMNS,
  FEED_FETCH_TTL_MS,
  fileImportedFeeds,
  first,
  type JobQueues,
  nextUtcDay,
  readSetting,
  siteColumns,
  subscribe,
  subscriptionRoom,
  type TelaDb,
} from '@tela/data'
import type { DiscoverResult, IngestError } from '@tela/ingest/pipeline'
import type { Jobs } from '@tela/platform'
import type { FeedRow, SiteRow } from '@tela/sync'
import { sql } from 'drizzle-orm'
import type { ApiDeps } from '../deps'

/** Too many attempts this hour; `retryAfterSec` says when the window turns. */
export type RateLimited = { error: 'rate_limited'; retryAfterSec: number }

/** The day's feeds new to Tela are spent (ADR 0063): `limit` a day, again at `resetsAt`. */
export type FeedLimit = { error: 'feed_limit'; limit: number | null; resetsAt: number }

/** The member holds as many subscriptions as `limit` allows. */
export type SubscriptionLimit = { error: 'subscription_limit'; limit: number | null }

export type DiscoverAnswer = DiscoverResult | RateLimited

export type AddFeedAnswer =
  /** `created`: the feed is new to Tela, and was counted in the actor's day. */
  | { feedId: number; siteId: number; created: boolean }
  | { error: IngestError }
  | RateLimited
  | FeedLimit
  | SubscriptionLimit

/** What an OPML import did (ADR 0063), or why it did nothing. */
export type ImportAnswer =
  | {
      /** Of the file's blogs, how many the member now follows. */
      following: number
      /** Subscriptions made or revived. */
      subscribed: number
      /** Feeds new to Tela added (and subscribed). */
      added: number
      /** Feeds that wait for a later day, this import's and earlier ones'. */
      waiting: number
      /** Of the file's blogs, how many neither follow nor wait: past the subscription cap. */
      over: number
      /** The day's and the cap's limits as they held; null for none, or for an exempt actor. */
      perDay: number | null
      maxSubscriptions: number | null
      /** When the day's count starts again. */
      resetsAt: number
      /** Folders made, and blogs filed in folders. */
      folders: number
      filed: number
    }
  | { error: 'opml_invalid' }
  | RateLimited

/**
 * A member's limit on feeds new to Tela reached, as the refusal says it (ADR 0063): which limit,
 * how many it allows, and when it comes back. A shell from before it reads only `error`.
 */
export async function feedLimitAnswer(db: TelaDb, now: number): Promise<FeedLimit> {
  return {
    error: 'feed_limit',
    limit: await readSetting(db, 'member.feedsPerDay'),
    resetsAt: nextUtcDay(now),
  }
}

async function subscriptionLimitAnswer(db: TelaDb): Promise<SubscriptionLimit> {
  return { error: 'subscription_limit', limit: await readSetting(db, 'member.maxSubscriptions') }
}

/**
 * Whether the member holds as many subscriptions as the cap allows, and the URL they typed is no
 * feed they follow already: one they follow takes no place, so adding it again is answered as
 * ever. Found by the URL as tela-jobs registers it, and through a merge, as `addFeed` finds one;
 * a page or a redirect that leads to a feed they follow is not known before the fetch this check
 * is there to save, and is refused.
 */
async function atSubscriptionCap(db: TelaDb, actor: Actor, feedUrl: string) {
  const { userId } = actor
  const url = asUrl(feedUrl)?.toString() ?? null
  const row = await first<{ room: number; following: number }>(
    db,
    sql`select ${subscriptionRoom(userId, actor.exempt)} as room,
      exists (select 1 from feeds f join subscriptions s on s.feed_id = coalesce(f.merged_into, f.id)
        where f.feed_url = ${url} and s.user_id = ${userId} and s.deleted_at is null) as following`,
  )
  return Number(row?.room ?? 0) <= 0 && !row?.following
}

/** Claim a feed that has never been fetched and send it on, so a new subscriber sees posts now. */
export async function fetchSoon(db: TelaDb, jobs: Jobs<JobQueues>, feedId: number, now: number) {
  const owner = `feed.fetch:api:${now.toString(36)}`
  const claimed = await claimDue(db, {
    kind: 'feed.fetch',
    owner,
    now,
    ttlMs: FEED_FETCH_TTL_MS,
    limit: 1,
    due: sql`select * from (${dueFeeds(now)}) where key = ${feedId}`,
  })
  if (claimed.length > 0)
    await jobs.send('fetch', { kind: 'feed.fetch', key: String(feedId), owner })
}

/** Feeds for what a member typed: the URL itself, what the page declares, or well-known paths. */
export async function discoverFeeds(
  deps: ApiDeps,
  actor: Actor,
  url: string,
): Promise<DiscoverAnswer> {
  const limited = await consumeLimit(deps.db, 'discover', actor.userId, deps.clock.now())
  if (!limited.allowed) return { error: 'rate_limited', retryAfterSec: limited.retryAfterSec }
  return deps.ingest.discover({ url })
}

/**
 * Add a feed by URL and subscribe the member to it. A URL Tela already follows is taken as is; a
 * new one is fetched first, and counts against the actor's day. Refused before the fetch when
 * the member is at the subscription cap, so no feed is added that nobody would read; the
 * subscribe is held to the cap as well, for two adds at once.
 */
export async function addFeedFor(
  deps: ApiDeps,
  actor: Actor,
  input: { feedUrl: string },
): Promise<AddFeedAnswer> {
  const { db } = deps
  const { feedUrl } = input
  const now = deps.clock.now()
  const limited = await consumeLimit(db, 'subscribe', actor.userId, now)
  if (!limited.allowed) return { error: 'rate_limited', retryAfterSec: limited.retryAfterSec }
  if (await atSubscriptionCap(db, actor, feedUrl)) return subscriptionLimitAnswer(db)
  const added = await deps.ingest.addFeed({
    feedUrl,
    actorId: actor.userId,
    withinDay: true,
    exempt: actor.exempt,
  })
  if ('error' in added) {
    if (added.error === 'feed_limit') return feedLimitAnswer(db, now)
    return { error: added.error }
  }
  if (!(await subscribe(db, actor.userId, added.feedId, now, actor.exempt))) {
    return subscriptionLimitAnswer(db)
  }
  const feed = await first<{ last_fetched_at: number | null }>(
    db,
    sql`select last_fetched_at from feeds where id = ${added.feedId}`,
  )
  // Now, not the time before the RPC: tela-jobs stamped the new feed due at its own clock,
  // which the RPC's own duration has moved past `now`.
  if (feed && feed.last_fetched_at === null) {
    await fetchSoon(db, deps.jobs, added.feedId, deps.clock.now())
  }
  return { feedId: added.feedId, siteId: added.siteId, created: added.created }
}

/**
 * Which of `urls` (as discovery names feeds) Tela has a feed for, by URL and through a merge, as
 * `addFeed` would find them: subscribing to one adds nothing to the day's count. One statement,
 * the URLs as one JSON parameter.
 */
export async function knownFeeds(db: TelaDb, urls: string[]): Promise<Map<string, number>> {
  if (urls.length === 0) return new Map()
  const rows = await db.all<{ url: string; id: number }>(sql`
    select f.feed_url as url, coalesce(f.merged_into, f.id) as id from feeds f
    where f.feed_url in (select value from json_each(${JSON.stringify(urls)}))
  `)
  return new Map(rows.map((r) => [r.url, Number(r.id)]))
}

/** A feed and its blog as the actor's device would hold them, in the sync's row shapes. */
export async function readFeed(
  deps: Pick<ApiDeps, 'db'>,
  actor: Pick<Actor, 'userId'>,
  feedId: number,
): Promise<{ feed: FeedRow; site: SiteRow } | null> {
  const { db } = deps
  const [feeds, sites] = (await db.batch([
    db.all(sql`select ${FEED_COLUMNS} from feeds f where f.id = ${feedId}`),
    db.all(sql`select ${siteColumns(actor.userId)} from sites s
      where s.id = (select site_id from feeds where id = ${feedId})`),
  ] as never)) as unknown as [FeedRow[], Record<string, unknown>[]]
  const feed = feeds[0]
  const site = sites[0]
  if (!feed || !site) return null
  return {
    feed,
    site: {
      ...(site as unknown as SiteRow),
      owned: site.owned === 1,
      claimed: site.claimed === 1,
      translationOptOut: site.translationOptOut === 1,
    },
  }
}

/**
 * Import an OPML document's feeds (ADR 0063): those Tela has subscribe free; new ones are added up
 * to the actor's day, and the rest wait for `member.pendingFeeds`, all within the subscription
 * cap. Its folders file the blogs in no folder yet (ADR 0048). New feeds are due now: the next
 * sweep fetches them, politely per host.
 */
export async function importFeeds(
  deps: ApiDeps,
  actor: Actor,
  opml: string,
): Promise<ImportAnswer> {
  const { db } = deps
  const now = deps.clock.now()
  const limited = await consumeLimit(db, 'opmlImport', actor.userId, now)
  if (!limited.allowed) return { error: 'rate_limited', retryAfterSec: limited.retryAfterSec }
  // Parsed in tela-jobs, which bundles the XML parsers already; tela-api stays lean.
  const read = await deps.ingest.readOpml({ opml })
  if ('error' in read) return read
  const feeds = read.urls.flatMap((feedUrl): BroughtFeed[] => {
    const origin = normalizeOrigin(feedUrl)
    return origin ? [{ feedUrl, host: new URL(feedUrl).hostname.toLowerCase(), origin }] : []
  })
  const brought = await bringFeeds(db, { userId: actor.userId, exempt: actor.exempt, feeds, now })
  // An older tela-jobs reads no folders; its import files nothing, as imports always did. A feed
  // that waits is filed in none when it arrives: a waiting row keeps no folder.
  const filed = await fileImportedFeeds(db, actor.userId, read.folders ?? [], now)
  return {
    following: brought.following,
    subscribed: brought.subscribed,
    added: brought.added,
    waiting: brought.waiting,
    over: brought.over,
    perDay: brought.exempt ? null : brought.perDay,
    maxSubscriptions: brought.exempt ? null : brought.maxSubscriptions,
    resetsAt: nextUtcDay(now),
    folders: filed.folders,
    filed: filed.filed,
  }
}
