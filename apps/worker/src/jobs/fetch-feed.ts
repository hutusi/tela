import { feeds } from '@tela/db'
import { siteNeedsAssets } from '@tela/db/queries'
import { createJobSender } from '@tela/db/queue'
import { type FetchFeedOptions, fetchFeed, type RegionPolicy } from '@tela/ingest'
import { READING_LANGUAGES } from '@tela/shared'
import { eq } from 'drizzle-orm'
import type { Job } from 'pg-boss'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import { type FeedFetchJob, QUEUES } from '../queues'
import { maybeQueueWebsub } from './websub'

/**
 * Ceiling on articles per fetch that get eager title jobs. A first fetch of a long archive, or
 * a hostile feed with thousands of items, otherwise turns into that many model calls; feeds
 * list newest first, and those are the posts lists show, so they are the ones worth it.
 */
export const TITLE_JOBS_PER_FETCH = 100

/**
 * Title/excerpt translation into every reading language the article is not in, queued through
 * the article's own transaction so the jobs commit with it: a crash between storing an article
 * and queueing its titles cannot lose them, and a retried fetch (which sees those articles as
 * unchanged) has nothing to make up. pg-boss serves equal priorities in creation order, so the
 * newest posts are translated first as well.
 */
function titleEnqueuer(counters: {
  articles: number
  jobs: number
}): NonNullable<FetchFeedOptions['onArticleStored']> {
  return async (tx, article) => {
    if (counters.articles >= TITLE_JOBS_PER_FETCH) return
    counters.articles += 1
    const sender = createJobSender(tx)
    for (const target of READING_LANGUAGES) {
      if (article.sourceLang === target) continue
      const id = await sender.send(
        QUEUES.translateTitle,
        { articleId: article.id, targetLang: target },
        { singletonKey: `${article.id}:${target}`, priority: 5 },
      )
      if (id) counters.jobs += 1
    }
  }
}

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
