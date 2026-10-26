/**
 * Adding feeds (ADR 0024): discovery and adding by URL go to tela-jobs' `Ingest` RPC, because they
 * fetch; OPML import registers without fetching, in three statements, and the sweeps fetch the
 * feeds from there. Its folders become the member's folders (ADR 0048), and an export keeps them.
 * Subscribing to a feed Tela already has is a mutation, not an RPC (ADR 0025).
 */

import { buildOpml, MAX_OPML_BYTES } from '@tela/content/opml'
import { asUrl, normalizeOrigin } from '@tela/content/url'
import {
  claimDue,
  consumeLimit,
  dueFeeds,
  FEED_FETCH_TTL_MS,
  fileImportedFeeds,
  first,
  importFeeds,
  type JobQueues,
  nextUtcDay,
  readSetting,
  subscribe,
  subscriptionRoom,
  type TelaDb,
} from '@tela/data'
import type { Jobs } from '@tela/platform'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import { readAtMost } from '../read-at-most'

const ERROR_STATUS = {
  invalid_url: 400,
  unreachable: 422,
  not_a_feed: 422,
  feed_too_large: 422,
  feed_limit: 429,
} as const

/**
 * A member's limit reached, as the refusal says it (ADR 0063): which limit, how many it allows,
 * and for the day's, when it comes back. A shell from before it reads only `error`.
 */
export async function feedLimitAnswer(db: TelaDb, now: number) {
  return {
    error: 'feed_limit' as const,
    limit: await readSetting(db, 'member.feedsPerDay'),
    resetsAt: nextUtcDay(now),
  }
}

async function subscriptionLimitAnswer(db: TelaDb) {
  return {
    error: 'subscription_limit' as const,
    limit: await readSetting(db, 'member.maxSubscriptions'),
  }
}

/**
 * Whether the member holds as many subscriptions as the cap allows, and the URL they typed is no
 * feed they follow already: one they follow takes no place, so adding it again is answered as
 * ever. Found by the URL as tela-jobs registers it, and through a merge, as `addFeed` finds one;
 * a page or a redirect that leads to a feed they follow is not known before the fetch this check
 * is there to save, and is refused.
 */
async function atSubscriptionCap(db: TelaDb, userId: string, feedUrl: string) {
  const url = asUrl(feedUrl)?.toString() ?? null
  const row = await first<{ room: number; following: number }>(
    db,
    sql`select ${subscriptionRoom(userId)} as room,
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

async function readBody(c: { req: { text(): Promise<string> } }): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await c.req.text()) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function feedRoutes(deps: ApiDeps) {
  const { db, ingest } = deps
  const routes = new Hono<ApiEnv>()

  routes.post('/discover', async (c) => {
    const member = c.get('member')
    const { url } = await readBody(c)
    if (typeof url !== 'string') return c.json({ error: 'invalid_url' }, 400)
    if (!(await consumeLimit(db, 'discover', member.id, deps.clock.now())).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    const result = await ingest.discover({ url })
    if ('error' in result) return c.json(result, ERROR_STATUS[result.error])
    return c.json(result)
  })

  routes.post('/', async (c) => {
    const member = c.get('member')
    const { feedUrl } = await readBody(c)
    if (typeof feedUrl !== 'string') return c.json({ error: 'invalid_url' }, 400)
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'subscribe', member.id, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    // Before the fetch, so a member at the cap adds no feed nobody would read. The subscribe below
    // is held to the cap as well, for two adds at once.
    if (await atSubscriptionCap(db, member.id, feedUrl)) {
      return c.json(await subscriptionLimitAnswer(db), 409)
    }
    const added = await ingest.addFeed({ feedUrl, actorId: member.id, withinDay: true })
    if ('error' in added) {
      if (added.error === 'feed_limit') return c.json(await feedLimitAnswer(db, now), 429)
      return c.json(added, ERROR_STATUS[added.error])
    }
    if (!(await subscribe(db, member.id, added.feedId, now))) {
      return c.json(await subscriptionLimitAnswer(db), 409)
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
    return c.json({ feedId: added.feedId, siteId: added.siteId })
  })

  routes.post('/opml', async (c) => {
    const member = c.get('member')
    // Read no further than the cap: a file sent without a length is cut off there, not held.
    if (Number(c.req.header('content-length') ?? '0') > MAX_OPML_BYTES) {
      return c.json({ error: 'opml_too_large' }, 413)
    }
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await readAtMost(c.req.raw.body, MAX_OPML_BYTES)
    } catch {
      return c.json({ error: 'unreadable' }, 400)
    }
    if (!bytes) return c.json({ error: 'opml_too_large' }, 413)
    const text = new TextDecoder().decode(bytes)
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'opmlImport', member.id, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    // Parsed in tela-jobs, which bundles the XML parsers already; tela-api stays lean.
    const read = await ingest.readOpml({ opml: text })
    if ('error' in read) return c.json(read, 400)
    const urls = read.urls
    const feeds = urls.flatMap((feedUrl) => {
      const origin = normalizeOrigin(feedUrl)
      return origin ? [{ feedUrl, host: new URL(feedUrl).hostname.toLowerCase(), origin }] : []
    })
    // Feeds Tela has subscribe free; new ones are added up to the member's day, and the rest wait
    // for `member.pendingFeeds` (ADR 0063), all within the subscription cap.
    const brought = await importFeeds(db, { userId: member.id, feeds, now })
    // An older tela-jobs reads no folders; its import files nothing, as imports always did. A feed
    // that waits is filed in none when it arrives: a waiting row keeps no folder.
    const filed = await fileImportedFeeds(db, member.id, read.folders ?? [], now)
    // New feeds are due now: the next sweep fetches them, politely per host.
    return c.json({
      // What a shell from before ADR 0063 reads: the blogs of the file the member now follows.
      feeds: brought.following,
      subscribed: brought.subscribed,
      added: brought.added,
      waiting: brought.waiting,
      over: brought.over,
      perDay: brought.exempt ? null : brought.perDay,
      maxSubscriptions: brought.exempt ? null : brought.maxSubscriptions,
      resetsAt: nextUtcDay(now),
      folders: filed.folders,
      filed: filed.filed,
    })
  })

  routes.get('/opml', async (c) => {
    const member = c.get('member')
    // Each folder by name, its blogs by title, then the blogs in none. A deleted folder is none.
    const rows = await db.all<{
      feed_url: string
      title: string
      home_url: string
      folder: string | null
    }>(sql`
      select f.feed_url, coalesce(f.title, s.title, s.home_url) as title, s.home_url,
        d.name as folder
      from subscriptions sub join feeds f on f.id = sub.feed_id join sites s on s.id = f.site_id
      left join feed_folders ff on ff.user_id = sub.user_id and ff.feed_id = sub.feed_id
      left join folders d on d.id = ff.folder_id and d.deleted_at is null
      where sub.user_id = ${member.id} and sub.deleted_at is null
      order by d.name is null, lower(d.name), d.name, lower(coalesce(f.title, s.title, s.home_url))
    `)
    const opml = buildOpml(
      rows.map((r) => ({
        feedUrl: r.feed_url,
        title: r.title,
        homeUrl: r.home_url,
        folder: r.folder,
      })),
      { title: 'Tela subscriptions', dateCreated: new Date(deps.clock.now()) },
    )
    return c.body(opml, 200, {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': 'attachment; filename="tela-subscriptions.opml"',
      'cache-control': 'no-store',
    })
  })

  return routes
}
