import type { Job } from 'pg-boss'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import type { TranslateBodyJob, TranslateTitleJob } from '../queues'
import { translateArticleBody } from '../translation/translate-body'
import { translateArticleTitle } from '../translation/translate-title'

function deps(ctx: WorkerContext) {
  return {
    db: ctx.db,
    translator: ctx.translator,
    dailyBudgetTokens: ctx.config.LLM_DAILY_BUDGET_TOKENS,
  }
}

export async function handleTranslateBody(ctx: WorkerContext, jobs: Job<TranslateBodyJob>[]) {
  for (const job of jobs) {
    const started = Date.now()
    const { articleId, targetLang } = job.data
    // Priority 10 marks reader-initiated requests; background prefetch runs at 1.
    const priority = (job as { priority?: number }).priority
    const onDemand = priority === undefined || priority >= 10
    const result = await translateArticleBody(deps(ctx), articleId, targetLang, { onDemand })
    const fields = { articleId, targetLang, jobId: job.id, ms: Date.now() - started, ...result }
    if (result.status === 'failed') log.warn('body translation failed', fields)
    else log.info('body translation done', fields)
  }
}

export async function handleTranslateTitle(ctx: WorkerContext, jobs: Job<TranslateTitleJob>[]) {
  for (const job of jobs) {
    const { articleId, targetLang } = job.data
    const result = await translateArticleTitle(deps(ctx), articleId, targetLang)
    const fields = { articleId, targetLang, jobId: job.id, ...result }
    if (result.status === 'failed') log.warn('title translation failed', fields)
    else log.debug('title translation done', fields)
  }
}
