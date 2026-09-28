/**
 * tela-jobs on Cloudflare. Placement pins this Worker's fetch handler beside the D1 primary in
 * Singapore; cron and queue handlers run wherever Cloudflare puts them (Paris and Los Angeles in
 * the spikes), so they only dispatch to that handler over the SELF binding (ADR 0020). The
 * handler has no public route: it is reachable through service bindings alone.
 */
import type {
  Request as CfRequest,
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from '@cloudflare/workers-types'
import * as schema from '@tela/data/schema'
// Subpaths only: the package root still re-exports the Postgres-era fetch code (until cutover).
import { createHttpClient } from '@tela/ingest/http'
import { createRelayClient } from '@tela/ingest/relay'
import { systemClock } from '@tela/platform'
import { d1Db, queueJobs, r2Blobs } from '@tela/platform/cloudflare'
import { daily } from './daily'
import type { Env } from './env'
import type { JobMessage, JobQueues } from './kinds'
import { type JobsContext, runJob, tick } from './runner'

const INTERNAL = 'https://tela-jobs.internal'
/** Must match the second cron in wrangler.jsonc. */
const DAILY_CRON = '17 3 * * *'

function context(env: Env): JobsContext {
  const relay =
    env.RELAY_URL && env.RELAY_SECRET
      ? createRelayClient({ relayUrl: env.RELAY_URL, secret: env.RELAY_SECRET })
      : undefined
  const controlUrl = env.RELAY_CONTROL_URL ?? 'https://www.cloudflare.com/cdn-cgi/trace'
  return {
    db: d1Db(env.DB, schema),
    blobs: r2Blobs(env.BLOBS),
    assets: r2Blobs(env.ASSETS),
    publicUrl: env.PUBLIC_URL ?? 'https://tela.ainaive.com',
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
      ...(relay ? { relay } : {}),
    }),
    websub: env.WEBSUB_ENABLED === '1',
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

export default {
  async fetch(request: CfRequest, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/jobs/tick') {
      return Response.json(await tick(context(env)))
    }
    if (request.method === 'POST' && url.pathname === '/jobs/daily') {
      return Response.json(await daily(context(env).db, Date.now()))
    }
    if (request.method === 'POST' && url.pathname === '/jobs/run') {
      const message = (await request.json()) as JobMessage
      return Response.json(await runJob(context(env), message))
    }
    return new Response('not found', { status: 404 })
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const path = controller.cron === DAILY_CRON ? '/jobs/daily' : '/jobs/tick'
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
