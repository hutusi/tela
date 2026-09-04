import type { Job } from 'pg-boss'
import { processSiteAssets } from '../assets/site-assets'
import { verifyClaim } from '../claims/verify'
import type { WorkerContext } from '../context'
import { log } from '../logger'
import type { SiteAssetsJob, SiteClaimVerifyJob } from '../queues'

export async function handleSiteClaimVerify(ctx: WorkerContext, jobs: Job<SiteClaimVerifyJob>[]) {
  for (const job of jobs) {
    const result = await verifyClaim(
      { db: ctx.db, http: ctx.http, publicUrl: ctx.config.PUBLIC_URL },
      job.data.claimId,
    )
    const fields = { claimId: job.data.claimId, jobId: job.id, ...result }
    if (result.status === 'failed') log.warn('claim verification failed', fields)
    else log.info('claim verification done', fields)
  }
}

export async function handleSiteAssets(ctx: WorkerContext, jobs: Job<SiteAssetsJob>[]) {
  for (const job of jobs) {
    const result = await processSiteAssets(
      { db: ctx.db, http: ctx.http, store: ctx.assets },
      job.data.siteId,
    )
    log.info('site assets processed', { siteId: job.data.siteId, jobId: job.id, ...result })
  }
}
