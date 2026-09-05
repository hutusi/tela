import type { PgBoss, Queue } from 'pg-boss'

/** Queue names. The web app enqueues on some of these through pg-boss's Drizzle adapter. */
export const QUEUES = {
  feedFetch: 'feed.fetch',
  articleExtract: 'article.extract',
  translateTitle: 'translate.title',
  translateBody: 'translate.body',
  siteAssets: 'site.assets',
  siteClaimVerify: 'site.claim.verify',
  websubSubscribe: 'websub.subscribe',
  schedulerTick: 'scheduler.tick',
  maintenanceDaily: 'maintenance.daily',
  healthCheck: 'health.check',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

export type FeedFetchJob = { feedId: number }
export type ArticleExtractJob = { articleId: number }
export type SiteAssetsJob = { siteId: number }
export type TranslateTitleJob = { articleId: number; targetLang: string }
/** `onDemand` marks a reader-initiated request, which the daily budget does not gate. */
export type TranslateBodyJob = { articleId: number; targetLang: string; onDemand?: boolean }
export type SiteClaimVerifyJob = { claimId: number }
export type WebsubSubscribeJob = { feedId: number }

type QueueSpec = Omit<Queue, 'name'>

const DEAD_LETTER_SUFFIX = '.dead'

/** Per-queue policy: dedup keys, retries with backoff, expiry, and a dead-letter queue. */
const SPECS: Record<QueueName, QueueSpec> = {
  [QUEUES.feedFetch]: {
    policy: 'short',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 120,
  },
  [QUEUES.articleExtract]: {
    policy: 'short',
    retryLimit: 2,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 120,
  },
  [QUEUES.translateTitle]: {
    policy: 'short',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 120,
  },
  [QUEUES.translateBody]: {
    policy: 'short',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // A capped article is at most ~14 chunks; chunks already stored survive an expiry anyway.
    expireInSeconds: 600,
  },
  [QUEUES.siteAssets]: {
    policy: 'short',
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    expireInSeconds: 120,
  },
  [QUEUES.siteClaimVerify]: {
    policy: 'short',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 60,
  },
  [QUEUES.websubSubscribe]: {
    policy: 'short',
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    expireInSeconds: 60,
  },
  [QUEUES.schedulerTick]: { policy: 'singleton', retryLimit: 0, expireInSeconds: 55 },
  [QUEUES.maintenanceDaily]: { policy: 'singleton', retryLimit: 1, expireInSeconds: 600 },
  [QUEUES.healthCheck]: { policy: 'singleton', retryLimit: 0, expireInSeconds: 240 },
}

/** Create or update every queue (idempotent), plus a dead-letter queue per work queue. */
export async function ensureQueues(boss: PgBoss) {
  for (const [name, spec] of Object.entries(SPECS) as Array<[QueueName, QueueSpec]>) {
    const isTick =
      name === QUEUES.schedulerTick ||
      name === QUEUES.maintenanceDaily ||
      name === QUEUES.healthCheck
    const deadLetter = isTick ? undefined : `${name}${DEAD_LETTER_SUFFIX}`
    if (deadLetter && !(await boss.getQueue(deadLetter))) {
      await boss.createQueue(deadLetter, { policy: 'standard', retentionSeconds: 30 * 24 * 3600 })
    }
    const options: QueueSpec = deadLetter ? { ...spec, deadLetter } : spec
    const existing = await boss.getQueue(name)
    if (!existing) {
      await boss.createQueue(name, options)
      continue
    }
    // pg-boss refuses updateQueue() when `policy` is present, even unchanged: the policy is fixed
    // at creation. Send only the settings that can change; a policy drift is a manual migration.
    const { policy, ...mutable } = options
    if (policy && existing.policy !== policy) {
      throw new Error(
        `queue ${name} has policy ${existing.policy} but the code wants ${policy}; recreate it`,
      )
    }
    await boss.updateQueue(name, mutable)
  }
}
