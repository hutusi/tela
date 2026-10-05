/**
 * The two halves of background work, both portable: `tick` claims what is due and sends it to
 * the queues; `runJob` does one item under its claim. On Cloudflare a cron calls the first and a
 * queue consumer the second, both through the Worker's own Singapore-pinned fetch handler. The
 * exit path calls them from a timer (`runPortable`).
 */
import {
  bumpSeq,
  type Claimed,
  claimDue,
  deadLetter,
  failLease,
  fence,
  heartbeat,
  type Lease,
  type LeaseKind,
  startLease,
} from '@tela/data'
import type { Jobs } from '@tela/platform'
import { MAX_ARTICLE_TRANSLATION_TOKENS } from '@tela/shared'
import type { AdminHeartbeats } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { type JobMessage, type JobQueues, KINDS, type KindSpec, type WorkContext } from './kinds'

export type JobsContext = WorkContext & { jobs: Jobs<JobQueues> }

export type TickReport = Partial<Record<LeaseKind, number>>

function ownerFor(kind: LeaseKind, now: number): string {
  return `${kind}:${now.toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

type Batch = Parameters<JobsContext['db']['batch']>[0]

/** How long after finishing an item the next one on the same host is sent: politeness's gap. */
export const SAME_HOST_GAP_SECONDS = 2

/**
 * Send what a claim took. An item claimed with every attempt spent is one whose last holder died
 * without reporting (a reported failure is dead-lettered by runJob itself): it is retired, not
 * sent again. Returns how many were sent.
 */
async function dispatch(
  ctx: JobsContext,
  kind: LeaseKind,
  spec: KindSpec,
  owner: string,
  claimed: Claimed[],
  now: number,
  delaySeconds?: number,
): Promise<number> {
  for (const c of claimed.filter((c) => c.attempts >= spec.backoff.maxAttempts)) {
    const lease: Lease = { kind, key: c.key, owner }
    const error = `the last attempt died or overran its lease (${c.attempts} started, none finished)`
    await ctx.db.batch([
      fence(ctx.db, lease, now),
      // The exhausted statements mark synced rows (a claim or a translation failed).
      bumpSeq(ctx.db),
      ...deadLetter(ctx.db, lease, c.attempts, error, now),
      ...spec.exhausted(ctx.db, c.key, now),
    ] as unknown as Batch)
  }
  const send = claimed.filter((c) => c.attempts < spec.backoff.maxAttempts)
  if (send.length > 0) {
    await ctx.jobs.sendBatch(
      spec.queue,
      send.map((c) => ({
        body: { kind, key: c.key, owner },
        ...(delaySeconds ? { delaySeconds } : {}),
      })),
    )
  }
  return send.length
}

export type RunningConfig = NonNullable<AdminHeartbeats['config']>

/**
 * The switches this deployment runs with, as the tick reports them. tela-api learns the
 * background budget from here rather than from a var of its own, which could drift from the one
 * tela-jobs spends by (the budget moved into this Worker's config for that reason).
 */
export function runningConfig(ctx: WorkContext): RunningConfig {
  return {
    backgroundBudget: ctx.backgroundBudget ?? 0,
    maxArticleTokens: ctx.maxArticleTokens ?? MAX_ARTICLE_TRANSLATION_TOKENS,
    translator: ctx.translator !== undefined,
    relay: ctx.region?.relayAvailable === true,
    websub: ctx.websub === true,
    assets: ctx.assets !== undefined,
  }
}

/**
 * Claim every kind's due work and send it on; record that the tick ran, what it sent per kind,
 * and the config it ran with.
 */
export async function tick(ctx: JobsContext): Promise<TickReport> {
  const report: TickReport = {}
  for (const [kind, spec] of Object.entries(KINDS) as [LeaseKind, KindSpec][]) {
    if (spec.enabled && !spec.enabled(ctx)) continue
    const now = ctx.clock.now()
    const owner = ownerFor(kind, now)
    const claimed = await claimDue(ctx.db, {
      kind,
      owner,
      now,
      ttlMs: spec.ttlMs,
      limit: spec.limit,
      due: spec.due(now, ctx),
    })
    report[kind] = await dispatch(ctx, kind, spec, owner, claimed, now)
  }
  await heartbeat(ctx.db, 'tick', ctx.clock.now(), { ...report, config: runningConfig(ctx) })
  return report
}

/**
 * Claim the next due item of this kind on the host just finished, and send it a moment later.
 * A tick takes one item per host, so without this a summary feed's 30 new posts would take half
 * an hour to extract. The finished item's lease is gone, so this claim is what keeps the host to
 * one request at a time, and a tick in between finds the host busy.
 */
async function continueOnHost(ctx: JobsContext, kind: LeaseKind, spec: KindSpec, host: string) {
  const now = ctx.clock.now()
  const owner = ownerFor(kind, now)
  const claimed = await claimDue(ctx.db, {
    kind,
    owner,
    now,
    ttlMs: spec.ttlMs,
    limit: 1,
    due: sql`select * from (${spec.due(now, ctx)}) where host = ${host}`,
  })
  await dispatch(ctx, kind, spec, owner, claimed, now, SAME_HOST_GAP_SECONDS)
}

export type RunOutcome =
  | { status: 'done'; result: unknown }
  | { status: 'retrying'; attempts: number; error: string }
  | { status: 'dead'; attempts: number; error: string }
  /** The claim had already been superseded: nothing to do. */
  | { status: 'lost' }
  | { status: 'unknown-kind' }

/** Do one claimed item. Never throws: a failure becomes backoff, then a dead letter. */
export async function runJob(ctx: JobsContext, message: JobMessage): Promise<RunOutcome> {
  const spec = KINDS[message.kind]
  if (!spec) return { status: 'unknown-kind' }
  const claim: Lease = { kind: message.kind, key: message.key, owner: message.owner }
  // Take the claim over, renew it and count the attempt before any work. Queues deliver at least
  // once, and a second delivery of this message finds the claim already taken over and is
  // dropped here, as is a message that waited in its queue past the lease: neither spends a model
  // call. The lease counts from when the work starts, and an attempt that dies without reporting
  // has still been counted, so it cannot retry for ever. The run's owner is random, not derived
  // from the message: it names this execution, and two deliveries of one message are two
  // executions that nothing else may confuse.
  const runOwner = `${message.owner}>${Math.random().toString(36).slice(2, 10)}`
  const started = await startLease(ctx.db, claim, runOwner, ctx.clock.now(), spec.ttlMs)
  if (started === null) return { status: 'lost' }
  const lease = started.lease
  let error: string
  try {
    const result = await spec.run(ctx, lease)
    if (result.status === 'lost') return { status: 'lost' }
    if (result.status !== 'retry') {
      // Only after a success: a host that just failed is left to the backoff. Best effort: the
      // work is done and released, and the next tick finds whatever this misses.
      if (started.host !== null) {
        await continueOnHost(ctx, message.kind, spec, started.host).catch(() => undefined)
      }
      return { status: 'done', result }
    }
    error = result.error ?? 'retry'
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
  const now = ctx.clock.now()
  const failed = await failLease(ctx.db, lease, now, spec.backoff, error)
  if (!failed) return { status: 'lost' }
  if (!failed.exhausted) return { status: 'retrying', attempts: failed.attempts, error }
  await ctx.db.batch([
    bumpSeq(ctx.db),
    ...deadLetter(ctx.db, lease, failed.attempts, error, now),
    ...spec.exhausted(ctx.db, lease.key, now),
  ] as unknown as Batch)
  return { status: 'dead', attempts: failed.attempts, error }
}
