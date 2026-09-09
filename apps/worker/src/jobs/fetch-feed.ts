import { feeds } from '@tela/db'
import { siteNeedsAssets } from '@tela/db/queries'
import { fetchFeed, type RegionPolicy } from '@tela/ingest'
import { eq } from 'drizzle-orm'
import type { Job } from 'pg-boss'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import { type FeedFetchJob, QUEUES } from '../queues'
import { titleEnqueuer } from '../title-jobs'
import { maybeQueueWebsub } from './websub'

/** First successful fetch of a site: look for its favicon and cover once. */
async function enqueueSiteAssets(ctx: WorkerContext, feedId: number) {
  const [feed] = await ctx.db
    .select({ siteId: feeds.siteId })
    .from(feeds)
    .where(eq(feeds.id, feedId))
  if (!feed || !(await siteNeedsAssets(ctx.db, feed.siteId))) return
  await ctx.boss.send(
    QUEUES.siteAssets,
    { siteId: feed.siteId },
    { singletonKey: String(feed.siteId) },
  )
}

/** Region flips are allowed only when a relay exists and our own connectivity checks out. */
function regionPolicy(ctx: WorkerContext): RegionPolicy | undefined {
  if (!ctx.config.RELAY_URL) return undefined
  return {
    relayAvailable: true,
    controlOk: async () => {
      try {
        const res = await ctx.http.get(ctx.config.RELAY_CONTROL_URL, { accept: '*/*' })
        return res.status >= 200 && res.status < 500
      } catch {
        return false
      }
    },
  }
}

export async function handleFeedFetch(ctx: WorkerContext, jobs: Job<FeedFetchJob>[]) {
  const policy = regionPolicy(ctx)
  for (const job of jobs) {
    const started = Date.now()
    const titles = { articles: 0, jobs: 0 }
    const result = await fetchFeed(ctx.db, ctx.http, job.data.feedId, {
      ...(policy ? { region: policy } : {}),
      onArticleStored: titleEnqueuer(titles),
    })
    let websub = false
    if (result.status === 'fetched') await enqueueSiteAssets(ctx, job.data.feedId)
    if (result.status === 'fetched' || result.status === 'unchanged') {
      websub = await maybeQueueWebsub(ctx, job.data.feedId)
    }
    const {
      newArticleIds: _n,
      updatedArticleIds: _u,
      ...summary
    } = result.status === 'fetched'
      ? result
      : { ...result, newArticleIds: [], updatedArticleIds: [] }
    const fields = {
      feedId: job.data.feedId,
      jobId: job.id,
      ms: Date.now() - started,
      titleJobs: titles.jobs,
      websub,
      ...summary,
    }
    if (result.status === 'error' && result.kind === 'region_flip') {
      log.info('feed routed through the relay', fields)
    } else if (result.status === 'error' || result.status === 'dead') {
      log.warn('feed fetch failed', fields)
    } else {
      log.info('feed fetched', fields)
    }
  }
}
