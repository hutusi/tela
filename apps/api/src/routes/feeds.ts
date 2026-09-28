/**
 * Adding feeds (ADR 0024): discovery and adding by URL go to tela-jobs' `Ingest` RPC, because they
 * fetch; OPML import registers without fetching, in three statements, and the sweeps fetch the
 * feeds from there. Subscribing to a feed Tela already has is a mutation, not an RPC (ADR 0025).
 */

import { buildOpml, MAX_OPML_BYTES } from '@tela/content/opml'
import { normalizeOrigin } from '@tela/content/url'
import {
  claimDue,
  consumeLimit,
  dueFeeds,
  FEED_FETCH_TTL_MS,
  first,
  importFeedUrls,
  type JobQueues,
  subscribe,
  subscribeMany,
  type TelaDb,
} from '@tela/data'
import type { Jobs } from '@tela/platform'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'

const ERROR_STATUS = { invalid_url: 400, unreachable: 422, not_a_feed: 422 } as const

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
    const added = await ingest.addFeed({ feedUrl, actorId: member.id })
    if ('error' in added) return c.json(added, ERROR_STATUS[added.error])
    await subscribe(db, member.id, added.feedId, now)
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
    const text = await c.req.text()
    if (new TextEncoder().encode(text).length > MAX_OPML_BYTES) {
      return c.json({ error: 'opml_too_large' }, 413)
    }
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
    const feedIds = await importFeedUrls(db, feeds, member.id, now)
    const subscribed = await subscribeMany(db, member.id, feedIds, now)
    // New feeds are due now: the next sweep fetches them, politely per host.
    return c.json({ feeds: feedIds.length, subscribed })
  })

  routes.get('/opml', async (c) => {
    const member = c.get('member')
    const rows = await db.all<{ feed_url: string; title: string; home_url: string }>(sql`
      select f.feed_url, coalesce(f.title, s.title, s.home_url) as title, s.home_url
      from subscriptions sub join feeds f on f.id = sub.feed_id join sites s on s.id = f.site_id
      where sub.user_id = ${member.id} and sub.deleted_at is null
      order by lower(coalesce(f.title, s.title, s.home_url))
    `)
    const opml = buildOpml(
      rows.map((r) => ({ feedUrl: r.feed_url, title: r.title, homeUrl: r.home_url })),
      new Date(deps.clock.now()),
    )
    return c.body(opml, 200, {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': 'attachment; filename="tela-subscriptions.opml"',
      'cache-control': 'no-store',
    })
  })

  return routes
}
