import { createDb } from '@tela/db'
import { type Job, PgBoss } from 'pg-boss'
import { loadConfig } from './config'
import {
  createAssetsFromEnv,
  createHttp,
  createTranslatorFromEnv,
  type WorkerContext,
} from './context'
import { handleSiteAssets, handleSiteClaimVerify } from './jobs/claims-and-assets'
import { handleArticleExtract } from './jobs/extract-article'
import { handleFeedFetch } from './jobs/fetch-feed'
import { handleTranslateBody, handleTranslateTitle } from './jobs/translate'
import { log, setLogLevel } from './logger'
import {
  type ArticleExtractJob,
  ensureQueues,
  type FeedFetchJob,
  QUEUES,
  type SiteAssetsJob,
  type SiteClaimVerifyJob,
  type TranslateBodyJob,
  type TranslateTitleJob,
} from './queues'
import { startRelayServer } from './relay/server'
import { maintenanceDaily, schedulerTick } from './scheduler'

async function main() {
  const config = loadConfig()
  setLogLevel(config.LOG_LEVEL)
  log.info('worker starting', { roles: config.roles, node: process.version })

  const stops: Array<() => Promise<void>> = []
  const has = (role: (typeof config.roles)[number]) => config.roles.includes(role)

  if (config.needsDb && config.DATABASE_URL) {
    const db = createDb(config.DATABASE_URL, { max: 5 })
    const [row] = await db.execute<{ now: string }>('select now() as now')
    log.info('database connected', { now: row?.now })

    const boss = new PgBoss({
      connectionString: config.DATABASE_URL,
      schema: 'pgboss',
      application_name: 'tela-worker',
      max: 4,
    })
    boss.on('error', (err) => log.error('pg-boss error', { err: String(err) }))
    await boss.start()
    await ensureQueues(boss)
    log.info('queues ready')

    const translator = createTranslatorFromEnv()
    const assets = createAssetsFromEnv()
    const ctx: WorkerContext = { config, db, boss, http: createHttp(config), translator, assets }
    log.info('translator ready', { model: translator.model, assets: assets?.kind ?? 'none' })

    if (has('scheduler')) {
      await boss.schedule(QUEUES.schedulerTick, '* * * * *', {}, {})
      await boss.schedule(QUEUES.maintenanceDaily, '17 3 * * *', {}, {})
      await boss.work(QUEUES.schedulerTick, { pollingIntervalSeconds: 5 }, async () =>
        schedulerTick(ctx),
      )
      await boss.work(QUEUES.maintenanceDaily, { pollingIntervalSeconds: 30 }, async () =>
        maintenanceDaily(ctx),
      )
      // Run one tick at startup so a fresh deployment does not wait for the next minute.
      await schedulerTick(ctx)
    }
    if (has('fetch')) {
      await boss.work(
        QUEUES.feedFetch,
        { batchSize: 1, localConcurrency: config.FETCH_CONCURRENCY, pollingIntervalSeconds: 2 },
        (jobs) => handleFeedFetch(ctx, jobs as Job<FeedFetchJob>[]),
      )
    }
    if (has('extract')) {
      await boss.work(
        QUEUES.articleExtract,
        { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 },
        (jobs) => handleArticleExtract(ctx, jobs as Job<ArticleExtractJob>[]),
      )
    }
    if (has('translate')) {
      await boss.work(
        QUEUES.translateBody,
        { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2, priority: true },
        (jobs) => handleTranslateBody(ctx, jobs as Job<TranslateBodyJob>[]),
      )
      // Title jobs are small and arrive in bursts (every article × every reading language), so
      // take several per poll; each poll only fetches once per interval.
      await boss.work(
        QUEUES.translateTitle,
        { batchSize: 5, localConcurrency: 4, pollingIntervalSeconds: 2 },
        (jobs) => handleTranslateTitle(ctx, jobs as Job<TranslateTitleJob>[]),
      )
    }
    if (has('claim')) {
      await boss.work(
        QUEUES.siteClaimVerify,
        { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 2 },
        (jobs) => handleSiteClaimVerify(ctx, jobs as Job<SiteClaimVerifyJob>[]),
      )
    }
    if (has('assets')) {
      await boss.work(
        QUEUES.siteAssets,
        { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds: 5 },
        (jobs) => handleSiteAssets(ctx, jobs as Job<SiteAssetsJob>[]),
      )
    }

    stops.push(async () => {
      await boss.stop({ graceful: true, timeout: 30_000 })
      await db.close()
    })
  }

  if (has('relay')) {
    const relay = await startRelayServer({
      secrets: [config.RELAY_SECRET ?? '', config.RELAY_SECRET_PREVIOUS ?? ''],
      port: config.RELAY_PORT,
      timeoutMs: config.FETCH_TIMEOUT_MS,
      allowPrivateHosts: process.env.WORKER_ALLOW_PRIVATE_HOSTS === '1',
    })
    log.info('relay listening', { port: relay.port })
    stops.push(relay.stop)
  }

  const heartbeat = setInterval(
    () => log.debug('heartbeat', { roles: config.roles }),
    config.HEARTBEAT_SEC * 1000,
  )
  stops.push(async () => clearInterval(heartbeat))

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    log.info('shutting down', { signal })
    for (const stop of stops.reverse()) {
      try {
        await stop()
      } catch (err) {
        log.error('stop failed', { err: String(err) })
      }
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  log.error('worker failed to start', { err: err instanceof Error ? err.stack : String(err) })
  process.exit(1)
})
