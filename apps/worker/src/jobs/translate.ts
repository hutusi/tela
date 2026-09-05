import type { Job } from 'pg-boss'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import { QUEUES, type TranslateBodyJob, type TranslateTitleJob } from '../queues'
import { translateArticleBody } from '../translation/translate-body'
import { translateArticleTitle } from '../translation/translate-title'

function deps(ctx: WorkerContext) {
  return {
    db: ctx.db,
    translator: ctx.translator,
    dailyBudgetTokens: ctx.config.LLM_DAILY_BUDGET_TOKENS,
    maxArticleTokens: ctx.config.LLM_MAX_ARTICLE_TOKENS,
  }
}

export async function handleTranslateBody(ctx: WorkerContext, jobs: Job<TranslateBodyJob>[]) {
  for (const job of jobs) {
    const started = Date.now()
    const { articleId, targetLang } = job.data
    // The flag travels in the payload: pg-boss only exposes a job's priority with
    // includeMetadata, so reading it here would make every job look on-demand.
    const onDemand = job.data.onDemand === true
    const result = await translateArticleBody(deps(ctx), articleId, targetLang, {
      onDemand,
      ...(job.data.requestedBy ? { requestedBy: job.data.requestedBy } : {}),
    })
    const fields = { articleId, targetLang, jobId: job.id, ms: Date.now() - started, ...result }
    if (result.status === 'failed') log.warn('body translation failed', fields)
    else log.info('body translation done', fields)
  }
}

/** Seconds until the next UTC day starts, when tokensUsedToday resets. */
export function secondsUntilNextUtcDay(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

export async function handleTranslateTitle(ctx: WorkerContext, jobs: Job<TranslateTitleJob>[]) {
  for (const job of jobs) {
    const { articleId, targetLang } = job.data
    const result = await translateArticleTitle(deps(ctx), articleId, targetLang)
    const fields = { articleId, targetLang, jobId: job.id, ...result }
    if (result.status === 'deferred') {
      // Budget exhausted: try again tomorrow. The `short` policy only dedups created jobs, so
      // this re-send is accepted while the current job is still active.
      await ctx.boss.send(QUEUES.translateTitle, job.data, {
        singletonKey: `${articleId}:${targetLang}`,
        priority: 5,
        startAfter: secondsUntilNextUtcDay(),
      })
      log.info('title translation deferred', fields)
    } else if (result.status === 'failed') log.warn('title translation failed', fields)
    else log.debug('title translation done', fields)
  }
}
