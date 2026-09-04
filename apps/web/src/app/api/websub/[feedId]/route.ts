import { getWebsub, markWebsubVerified } from '@tela/db/queries'
import { createJobSender } from '@tela/db/queue'
import { verifyHubSignature, WEBSUB_LEASE_SECONDS } from '@tela/ingest'
import { getDb } from '@/lib/platform/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ feedId: string }> }

const MAX_NOTIFICATION_BYTES = 5 * 1024 * 1024

async function feedIdOf(ctx: Ctx): Promise<number | null> {
  const n = Number((await ctx.params).feedId)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Hub intent verification (WebSub §5.3): echo the challenge only for a subscription we asked
 * for, on the topic we asked for. Anything else is a 404, which tells the hub "no".
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const feedId = await feedIdOf(ctx)
  if (!feedId) return new Response('not found', { status: 404 })
  const q = new URL(req.url).searchParams
  const challenge = q.get('hub.challenge')
  const topic = q.get('hub.topic')
  if (q.get('hub.mode') !== 'subscribe' || !challenge || !topic) {
    return new Response('not found', { status: 404 })
  }
  const requested = Number(q.get('hub.lease_seconds'))
  const lease = Number.isFinite(requested) && requested > 0 ? requested : WEBSUB_LEASE_SECONDS
  const db = await getDb()
  const row = await getWebsub(db, feedId)
  if (!row || row.topicUrl !== topic) return new Response('not found', { status: 404 })
  const verified = await markWebsubVerified(db, feedId, topic, lease)
  if (!verified) return new Response('not found', { status: 404 })
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
}

/**
 * Content notification (WebSub §7): verify the signature with the shared secret, then fetch the
 * feed through the normal pipeline rather than trusting the pushed body.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const feedId = await feedIdOf(ctx)
  if (!feedId) return new Response('not found', { status: 404 })
  const db = await getDb()
  const row = await getWebsub(db, feedId)
  if (!row || row.status !== 'active') return new Response('not found', { status: 404 })
  const body = new Uint8Array(await req.arrayBuffer())
  if (body.byteLength > MAX_NOTIFICATION_BYTES) return new Response('too large', { status: 413 })
  if (!(await verifyHubSignature(row.secret, body, req.headers.get('x-hub-signature')))) {
    return new Response('bad signature', { status: 403 })
  }
  try {
    await createJobSender(db).send('feed.fetch', { feedId }, { singletonKey: String(feedId) })
  } catch (err) {
    console.warn('[tela] websub ping could not enqueue feed.fetch', { feedId, err: String(err) })
  }
  return new Response(null, { status: 204 })
}
