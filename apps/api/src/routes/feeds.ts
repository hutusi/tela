/**
 * Adding feeds (ADR 0024), as the web words it: discovery, adding by URL and OPML import are the
 * rules in `core/feeds.ts`, which the API's `/v1/feeds` shares (ADR 0065). An export keeps the
 * member's folders (ADR 0048). Subscribing to a feed Tela already has is a mutation, not an RPC
 * (ADR 0025).
 */

import { buildOpml, MAX_OPML_BYTES } from '@tela/content/opml'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import { addFeedFor, discoverFeeds, importFeeds } from '../core/feeds'
import type { ApiDeps } from '../deps'
import { readAtMost } from '../read-at-most'
import { webActor } from '../web-actor'

export { feedLimitAnswer, fetchSoon } from '../core/feeds'

const ERROR_STATUS = {
  invalid_url: 400,
  unreachable: 422,
  not_a_feed: 422,
  feed_too_large: 422,
  feed_limit: 429,
  subscription_limit: 409,
} as const

async function readBody(c: { req: { text(): Promise<string> } }): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await c.req.text()) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The web's answer to a refusal: the hour's limit says only that, as it always has. */
const refusal = (answer: { error: string }) =>
  answer.error === 'rate_limited' ? { error: 'rate_limited' } : answer

export function feedRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.post('/discover', async (c) => {
    const { url } = await readBody(c)
    if (typeof url !== 'string') return c.json({ error: 'invalid_url' }, 400)
    const result = await discoverFeeds(deps, await webActor(c, db), url)
    if ('error' in result) {
      return c.json(
        refusal(result),
        result.error === 'rate_limited' ? 429 : ERROR_STATUS[result.error],
      )
    }
    return c.json(result)
  })

  routes.post('/', async (c) => {
    const { feedUrl } = await readBody(c)
    if (typeof feedUrl !== 'string') return c.json({ error: 'invalid_url' }, 400)
    const added = await addFeedFor(deps, await webActor(c, db), { feedUrl })
    if ('error' in added) {
      return c.json(
        refusal(added),
        added.error === 'rate_limited' ? 429 : ERROR_STATUS[added.error],
      )
    }
    return c.json({ feedId: added.feedId, siteId: added.siteId })
  })

  routes.post('/opml', async (c) => {
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
    const result = await importFeeds(deps, await webActor(c, db), new TextDecoder().decode(bytes))
    if ('error' in result) {
      return c.json(refusal(result), result.error === 'rate_limited' ? 429 : 400)
    }
    return c.json({
      // What a shell from before ADR 0063 reads: the blogs of the file the member now follows.
      feeds: result.following,
      subscribed: result.subscribed,
      added: result.added,
      waiting: result.waiting,
      over: result.over,
      perDay: result.perDay,
      maxSubscriptions: result.maxSubscriptions,
      resetsAt: result.resetsAt,
      folders: result.folders,
      filed: result.filed,
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
