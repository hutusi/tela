/**
 * tela-jobs on Cloudflare. Placement pins this Worker's fetch handler beside the D1 primary in
 * Singapore; cron and queue handlers run wherever Cloudflare puts them (Paris and Los Angeles in
 * the spikes), so they only dispatch to that handler over the SELF binding (ADR 0020). The
 * handler has no public route: it is reachable through service bindings alone.
 */

import { WorkerEntrypoint } from 'cloudflare:workers'
import type {
  Request as CfRequest,
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from '@cloudflare/workers-types'
import { backUp, pruneBackups } from '@tela/data'
import * as schema from '@tela/data/schema'
// Subpaths, so this bundle takes only what it runs.
import { createHttpClient } from '@tela/ingest/http'
import { createIngest, type Ingest as IngestApi } from '@tela/ingest/pipeline'
import { createRelayClient } from '@tela/ingest/relay'
import { configFromEnv, createTranslator, isAccidentalMock, type Translator } from '@tela/llm'
import { memoryJobs, resendMail, systemClock } from '@tela/platform'
import { d1Db, queueJobs, r2Blobs } from '@tela/platform/cloudflare'
import { sql } from 'drizzle-orm'
import { daily } from './daily'
import type { Env } from './env'
import type { JobMessage, JobQueues } from './kinds'
import { digest, health, pingDeadman } from './ops'
import { settle } from './portable'
import { type JobsContext, runJob, tick } from './runner'

const INTERNAL = 'https://tela-jobs.internal'
/** Must match the crons in wrangler.jsonc. */
const DAILY_CRON = '17 3 * * *'
const DIGEST_CRON = '0 8 * * 1'
/** Exports kept (ADR 0027); D1's Time Travel covers the last 30 days point in time as well. */
const BACKUP_KEEP_DAYS = 30
/** How often the dead-man's switch hears from the tick. Its grace period allows a few misses. */
const DEADMAN_EVERY_MINUTES = 5

/**
 * The translator, or none. A missing key falls back to the mock, and the mock's placeholder output
 * would be cached for everyone, so an accidental mock disables translation instead (AGENTS.md).
 */
function translatorFrom(env: Env): Translator | undefined {
  const vars = env as unknown as Record<string, string | undefined>
  const config = configFromEnv(vars)
  if (isAccidentalMock(config, vars)) return undefined
  return createTranslator(config)
}

function context(env: Env): JobsContext {
  const relay =
    env.RELAY_URL && env.RELAY_SECRET
      ? createRelayClient({ relayUrl: env.RELAY_URL, secret: env.RELAY_SECRET })
      : undefined
  const controlUrl = env.RELAY_CONTROL_URL ?? 'https://www.cloudflare.com/cdn-cgi/trace'
  return {
    db: d1Db(env.DB, schema),
    blobs: r2Blobs(env.BLOBS),
    ...(env.ASSETS ? { assets: r2Blobs(env.ASSETS) } : {}),
    publicUrl: env.PUBLIC_URL ?? 'https://tela.ainaive.com',
    ...(env.GRAVATAR_URL ? { gravatarUrl: env.GRAVATAR_URL } : {}),
    jobs: queueJobs<JobQueues>({
      fetch: env.FETCH_QUEUE,
      extract: env.EXTRACT_QUEUE,
      translate: env.TRANSLATE_QUEUE,
      misc: env.MISC_QUEUE,
    }),
    clock: systemClock,
    http: createHttpClient({
      userAgent: env.WORKER_USER_AGENT ?? 'Tela/0.1 (+https://tela.ainaive.com; feed reader)',
      timeoutMs: Number(env.FETCH_TIMEOUT_MS ?? 20_000),
      // Politeness is the lease table's job now: one live lease per host, across every kind.
      politenessMs: 0,
      // The local e2e stack's fixture server is on 127.0.0.1. Nothing deployed sets ENV.
      ...(env.ENV === 'test' ? { allowPrivateHosts: true } : {}),
      ...(relay ? { relay } : {}),
    }),
    websub: env.WEBSUB_ENABLED === '1',
    // What reaches hosts outside the HTTP client (a WebSub hub) checks this instead.
    ...(env.ENV === 'test' ? { allowPrivateHosts: true } : {}),
    ...(() => {
      const translator = translatorFrom(env)
      return translator ? { translator } : {}
    })(),
    backgroundBudget: Number(env.LLM_DAILY_BUDGET_TOKENS ?? 0),
    maxArticleTokens: Number(env.LLM_MAX_ARTICLE_TOKENS ?? 40_000),
    ...(relay
      ? {
          region: {
            relayAvailable: true,
            controlOk: async () => {
              try {
                return (await fetch(controlUrl, { signal: AbortSignal.timeout(5000) })).ok
              } catch {
                return false
              }
            },
          },
        }
      : {}),
  }
}

/**
 * What tela-api asks of this Worker over its `JOBS` service binding: the work that fetches on a
 * member's behalf (discovery, adding a feed, starting a claim), so tela-api never bundles the
 * parsers or the DNS-pinned client (ADR 0024). Runs pinned beside D1 like the fetch handler.
 */
export class Ingest extends WorkerEntrypoint<Env> implements IngestApi {
  private ingest(): IngestApi {
    const ctx = context(this.env)
    return createIngest({ db: ctx.db, http: ctx.http, now: () => Date.now() })
  }
  discover(input: Parameters<IngestApi['discover']>[0]) {
    return this.ingest().discover(input)
  }
  addFeed(input: Parameters<IngestApi['addFeed']>[0]) {
    return this.ingest().addFeed(input)
  }
  startClaim(input: Parameters<IngestApi['startClaim']>[0]) {
    return this.ingest().startClaim(input)
  }
  readOpml(input: Parameters<IngestApi['readOpml']>[0]) {
    return this.ingest().readOpml(input)
  }
  /**
   * Test mode only: run the sweeps now, and everything they lead to, until nothing is due. Local
   * dev fires no crons, and the local queues' batch timeout would make every e2e step wait.
   */
  async cycle(options: { refetch?: boolean } = {}) {
    if (this.env.ENV !== 'test') throw new Error('cycle() is for the e2e stack only')
    const ctx = { ...context(this.env), jobs: memoryJobs<JobQueues>() }
    // A spec that changed a fixture feed needs it fetched again now, not at its next interval.
    if (options.refetch) {
      await ctx.db.run(sql`update feeds set next_fetch_at = 0 where status = 'active'`)
    }
    return settle(ctx)
  }
}

export default {
  async fetch(request: CfRequest, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/jobs/tick') {
      const ctx = context(env)
      const report = await tick(ctx)
      const now = Date.now()
      if (Math.floor(now / 60_000) % DEADMAN_EVERY_MINUTES !== 0) return Response.json({ report })
      const h = await health(ctx.db, ctx.blobs, now)
      await pingDeadman(env.DEADMAN_URL, h)
      return Response.json({ report, health: h })
    }
    if (request.method === 'POST' && url.pathname === '/jobs/daily') {
      const ctx = context(env)
      const now = Date.now()
      const report = await daily(ctx.db, now)
      const date = new Date(now).toISOString().slice(0, 10)
      // A failed export leaves latest.json as it was; the health check flags it once stale.
      const backup = await backUp(ctx.db, ctx.blobs, { date, now: () => Date.now() }).catch(
        (err: unknown) => ({ error: String(err) }),
      )
      const pruned = await pruneBackups(ctx.blobs, date, BACKUP_KEEP_DAYS)
      return Response.json({ report, backup, pruned })
    }
    if (request.method === 'POST' && url.pathname === '/jobs/digest') {
      const ctx = context(env)
      const mail = await digest(ctx.db, ctx.blobs, Date.now())
      if (env.DIGEST_TO && env.RESEND_API_KEY) {
        await resendMail({
          apiKey: env.RESEND_API_KEY,
          from: env.MAIL_FROM ?? 'Tela <noreply@ainaive.com>',
        }).send({
          to: env.DIGEST_TO,
          ...mail,
        })
      }
      return Response.json({ sent: Boolean(env.DIGEST_TO && env.RESEND_API_KEY), ...mail })
    }
    if (request.method === 'POST' && url.pathname === '/jobs/run') {
      const message = (await request.json()) as JobMessage
      return Response.json(await runJob(context(env), message))
    }
    return new Response('not found', { status: 404 })
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const path =
      controller.cron === DAILY_CRON
        ? '/jobs/daily'
        : controller.cron === DIGEST_CRON
          ? '/jobs/digest'
          : '/jobs/tick'
    ctx.waitUntil(env.SELF.fetch(`${INTERNAL}${path}`, { method: 'POST' }).then(() => undefined))
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    // Each job runs as its own pinned invocation. Always ack: retries are driven by lease state,
    // and throwing here would redeliver the whole batch.
    await Promise.allSettled(
      batch.messages.map(async (message) => {
        try {
          await env.SELF.fetch(`${INTERNAL}/jobs/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(message.body),
          })
        } finally {
          message.ack()
        }
      }),
    )
  },
}
