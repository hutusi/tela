/**
 * The WebSub callback (the hub's side; the subscriber side is tela-jobs' `websub.subscribe`).
 * A ping marks the feed for a refetch and claims it at once; the pushed body is never trusted as
 * content, only as proof something changed (ADR 0021: the fetch goes through the one pipeline).
 */
import { bumpSeq, currentSeq, first } from '@tela/data'
import { HttpError, readCapped } from '@tela/ingest/http'
import { verifyHubSignature, WEBSUB_LEASE_SECONDS } from '@tela/ingest/websub'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import { fetchSoon } from './feeds'

const MAX_NOTIFICATION_BYTES = 5 * 1024 * 1024
const notFound = () => new Response('not found', { status: 404 })

export function websubRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()
  const feedIdOf = (raw: string) => {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  /**
   * Intent verification (WebSub §5.3): echo the challenge only for a subscription Tela asked
   * for, on the topic it asked for. Anything else is a 404, which tells the hub "no".
   */
  routes.get('/:feedId', async (c) => {
    const feedId = feedIdOf(c.req.param('feedId'))
    const challenge = c.req.query('hub.challenge')
    const topic = c.req.query('hub.topic')
    if (!feedId || c.req.query('hub.mode') !== 'subscribe' || !challenge || !topic)
      return notFound()
    const requested = Number(c.req.query('hub.lease_seconds'))
    const lease = Number.isFinite(requested) && requested > 0 ? requested : WEBSUB_LEASE_SECONDS
    const now = deps.clock.now()
    const rows = await db.all<{ feed_id: number }>(sql`
      update websub_subscriptions set status = 'active', lease_until = ${now + lease * 1000},
        verified_at = ${now}, last_error = null, updated_at = ${now}
      where feed_id = ${feedId} and topic_url = ${topic} and status in ('pending', 'active')
      returning feed_id
    `)
    if (rows.length === 0) return notFound()
    return c.text(challenge, 200)
  })

  /** Content notification (WebSub §7): check the signature, then refetch through the pipeline. */
  routes.post('/:feedId', async (c) => {
    const feedId = feedIdOf(c.req.param('feedId'))
    if (!feedId) return notFound()
    const sub = await first<{ secret: string }>(
      db,
      sql`select secret from websub_subscriptions where feed_id = ${feedId} and status = 'active'`,
    )
    if (!sub) return notFound()
    let body: Uint8Array
    try {
      // The signature covers the body, so it is read, but no further than the cap.
      body = await readCapped(c.req.raw, MAX_NOTIFICATION_BYTES)
    } catch (err) {
      if (err instanceof HttpError && err.kind === 'too_large') return c.text('too large', 413)
      throw err
    }
    if (!(await verifyHubSignature(sub.secret, body, c.req.header('x-hub-signature') ?? null))) {
      return c.text('bad signature', 403)
    }
    const now = deps.clock.now()
    // Due by state: a lost claim or message costs only the next sweep's minute.
    await db.batch([
      bumpSeq(db),
      db.run(
        sql`update feeds set refetch_requested_at = ${now}, seq = ${currentSeq} where id = ${feedId}`,
      ),
    ] as never)
    await fetchSoon(db, deps.jobs, feedId, now)
    return c.body(null, 204)
  })

  return routes
}
