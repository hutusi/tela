import { articles, feeds } from '@tela/db'
import { siteNeedsAssets } from '@tela/db/queries'
import { fetchFeed } from '@tela/ingest'
import { READING_LANGUAGES } from '@tela/shared'
import { eq, inArray } from 'drizzle-orm'
import type { Job } from 'pg-boss'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import { type FeedFetchJob, QUEUES } from '../queues'

/** Queue eager title/excerpt translation into every reading language the article is not in. */
async function enqueueTitleTranslations(ctx: WorkerContext, articleIds: number[]) {
  if (articleIds.length === 0) return 0
  const rows = await ctx.db
    .select({ id: articles.id, sourceLang: articles.sourceLang })
    .from(articles)
    .where(inArray(articles.id, articleIds))
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

export async function handleFeedFetch(ctx: WorkerContext, jobs: Job<FeedFetchJob>[]) {
  for (const job of jobs) {
    const started = Date.now()
    const result = await fetchFeed(ctx.db, ctx.http, job.data.feedId)
    let titleJobs = 0
    if (result.status === 'fetched') {
      titleJobs = await enqueueTitleTranslations(ctx, [
        ...result.newArticleIds,
        ...result.updatedArticleIds,
      ])
      await enqueueSiteAssets(ctx, job.data.feedId)
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
      ...summary,
    }
    if (result.status === 'error' || result.status === 'dead') log.warn('feed fetch failed', fields)
    else log.info('feed fetched', fields)
  }
}
