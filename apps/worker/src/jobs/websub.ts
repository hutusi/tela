import { feeds } from '@tela/db'
import { getWebsub, websubDueForRenewal } from '@tela/db/queries'
import { eq } from 'drizzle-orm'
import type { Job } from 'pg-boss'
import { allowPrivateHosts, type WorkerContext } from '../context'
import { log } from '../logger'
import { QUEUES, type WebsubSubscribeJob } from '../queues'
import { subscribeFeedToHub, websubNeedsRequest } from '../websub/subscribe'

function deps(ctx: WorkerContext) {
  return {
    db: ctx.db,
    publicUrl: ctx.config.PUBLIC_URL,
    fetch: ctx.fetch,
    timeoutMs: ctx.config.FETCH_TIMEOUT_MS,
    allowPrivateHosts: allowPrivateHosts(),
  }
}

export async function handleWebsubSubscribe(ctx: WorkerContext, jobs: Job<WebsubSubscribeJob>[]) {
  for (const job of jobs) {
    const result = await subscribeFeedToHub(deps(ctx), job.data.feedId)
    const fields = { feedId: job.data.feedId, jobId: job.id, ...result }
    if (result.status === 'failed') log.warn('websub subscription failed', fields)
    else log.info('websub subscription', fields)
  }
}

/** After a fetch: queue a hub subscription when the feed advertises one and ours is missing or ending. */
export async function maybeQueueWebsub(ctx: WorkerContext, feedId: number): Promise<boolean> {
  if (!ctx.config.WEBSUB_ENABLED) return false
  const [feed] = await ctx.db
    .select({ hubUrl: feeds.hubUrl })
    .from(feeds)
    .where(eq(feeds.id, feedId))
  if (!feed?.hubUrl) return false
  if (!websubNeedsRequest(await getWebsub(ctx.db, feedId))) return false
  const id = await ctx.boss.send(
    QUEUES.websubSubscribe,
    { feedId },
    { singletonKey: String(feedId) },
  )
  return id !== null
}

/** Daily: renew leases that end soon and retry stale or failed subscriptions. */
export async function queueWebsubRenewals(ctx: WorkerContext): Promise<number> {
  if (!ctx.config.WEBSUB_ENABLED) return 0
  let sent = 0
  for (const feedId of await websubDueForRenewal(ctx.db)) {
    const id = await ctx.boss.send(
      QUEUES.websubSubscribe,
      { feedId },
      { singletonKey: String(feedId) },
    )
    if (id) sent += 1
  }
  return sent
}
