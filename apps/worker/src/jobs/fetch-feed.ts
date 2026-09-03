import { fetchFeed } from '@tela/ingest'
import type { Job } from 'pg-boss'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import type { FeedFetchJob } from '../queues'

export async function handleFeedFetch(ctx: WorkerContext, jobs: Job<FeedFetchJob>[]) {
  for (const job of jobs) {
    const started = Date.now()
    const result = await fetchFeed(ctx.db, ctx.http, job.data.feedId)
    const fields = { feedId: job.data.feedId, jobId: job.id, ms: Date.now() - started, ...result }
    if (result.status === 'error' || result.status === 'dead') log.warn('feed fetch failed', fields)
    else log.info('feed fetched', fields)
  }
}
