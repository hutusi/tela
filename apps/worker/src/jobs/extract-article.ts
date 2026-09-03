import { extractArticleContent } from '@tela/ingest/extract'
import type { Job } from 'pg-boss'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import type { ArticleExtractJob } from '../queues'

export async function handleArticleExtract(ctx: WorkerContext, jobs: Job<ArticleExtractJob>[]) {
  for (const job of jobs) {
    const result = await extractArticleContent(ctx.db, ctx.http, job.data.articleId)
    const fields = { articleId: job.data.articleId, jobId: job.id, ...result }
    if (result.status === 'failed') log.warn('article extraction failed', fields)
    else log.info('article extraction done', fields)
  }
}
