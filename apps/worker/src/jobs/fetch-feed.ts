import { articles, feeds } from '@tela/db'
import { siteNeedsAssets } from '@tela/db/queries'
import { fetchFeed, type RegionPolicy } from '@tela/ingest'
import { READING_LANGUAGES } from '@tela/shared'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import type { Job } from 'pg-boss'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import { type FeedFetchJob, QUEUES } from '../queues'
import { maybeQueueWebsub } from './websub'

/**
 * Ceiling on title jobs one fetch may create per language. A first fetch of a long archive, or
 * a hostile feed with thousands of items, otherwise turns into that many model calls; the
 * newest posts are the ones lists show, so they are the ones worth translating eagerly.
 */
export const TITLE_JOBS_PER_FETCH = 100

/** Queue eager title/excerpt translation into every reading language the article is not in. */
async function enqueueTitleTranslations(ctx: WorkerContext, articleIds: number[]) {
  if (articleIds.length === 0) return 0
  // Newest first, in the order the list shows them: pg-boss serves equal priorities in creation
  // order, so the titles readers see at the top are translated first.
  const rows = await ctx.db
    .select({ id: articles.id, sourceLang: articles.sourceLang })
    .from(articles)
    .where(inArray(articles.id, articleIds))
    .orderBy(desc(sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt})`), desc(articles.id))
    .limit(TITLE_JOBS_PER_FETCH)
  let sent = 0
  for (const row of rows) {
    for (const target of READING_LANGUAGES) {
      if (row.sourceLang === target) continue
      const id = await ctx.boss.send(
        QUEUES.translateTitle,
        { articleId: row.id, targetLang: target },
        { singletonKey: `${row.id}:${target}`, priority: 5 },
      )
      if (id) sent += 1
    }
  }
  return sent
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
    const result = await fetchFeed(
      ctx.db,
      ctx.http,
      job.data.feedId,
      policy ? { region: policy } : {},
    )
    let titleJobs = 0
    let websub = false
    if (result.status === 'fetched') {
      titleJobs = await enqueueTitleTranslations(ctx, [
        ...result.newArticleIds,
        ...result.updatedArticleIds,
      ])
      await enqueueSiteAssets(ctx, job.data.feedId)
    }
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
      titleJobs,
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
