/**
 * The two halves of background work, both portable: `tick` claims what is due and sends it to
 * the queues; `runJob` does one item under its claim. On Cloudflare a cron calls the first and a
 * queue consumer the second, both through the Worker's own Singapore-pinned fetch handler. The
 * exit path calls them from a timer (`runPortable`).
 */
import {
  claimDue,
  deadLetter,
  failLease,
  fence,
  type Lease,
  type LeaseKind,
  startLease,
} from '@tela/data'
import type { Jobs } from '@tela/platform'
import { sql } from 'drizzle-orm'
import { type JobMessage, type JobQueues, KINDS, type KindSpec, type WorkContext } from './kinds'

export type JobsContext = WorkContext & { jobs: Jobs<JobQueues> }

export type TickReport = Partial<Record<LeaseKind, number>>

function ownerFor(kind: LeaseKind, now: number): string {
  return `${kind}:${now.toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

type Batch = Parameters<JobsContext['db']['batch']>[0]

/** Claim every kind's due work and send it on; record that the tick ran. */
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
    // An item re-claimed with every attempt spent is one whose last holder died without
    // reporting (a reported failure is dead-lettered by runJob itself): retire it, don't resend.
    const spent = claimed.filter((c) => c.attempts >= spec.backoff.maxAttempts)
    for (const c of spent) {
      const lease: Lease = { kind, key: c.key, owner }
      const error = `the last attempt died or overran its lease (${c.attempts} started, none finished)`
      await ctx.db.batch([
        fence(ctx.db, lease, now),
        ...deadLetter(ctx.db, lease, c.attempts, error, now),
        ...spec.exhausted(ctx.db, c.key, now),
      ] as unknown as Batch)
    }
    const send = claimed.filter((c) => c.attempts < spec.backoff.maxAttempts)
    if (send.length > 0) {
      await ctx.jobs.sendBatch(
        spec.queue,
        send.map((c) => ({ body: { kind, key: c.key, owner } })),
      )
    }
    report[kind] = send.length
  }
  await ctx.db.run(sql`
    insert into ops_heartbeats (name, at, info) values ('tick', ${ctx.clock.now()}, ${JSON.stringify(report)})
    on conflict (name) do update set at = excluded.at, info = excluded.info
  `)
  return report
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
  const lease: Lease = { kind: message.kind, key: message.key, owner: message.owner }
  // Renew the claim and count the attempt before any work. A message that waited in its queue
  // past the lease is dropped here, before it spends a model call the fence would then throw
  // away; the lease counts from when the work starts; and an attempt that dies without reporting
  // has still been counted, so it cannot retry for ever.
  if ((await startLease(ctx.db, lease, ctx.clock.now(), spec.ttlMs)) === null) {
    return { status: 'lost' }
  }
  let error: string
  try {
    const result = await spec.run(ctx, lease)
    if (result.status === 'lost') return { status: 'lost' }
    if (result.status !== 'retry') return { status: 'done', result }
    error = result.error ?? 'retry'
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
  const now = ctx.clock.now()
  const failed = await failLease(ctx.db, lease, now, spec.backoff, error)
  if (!failed) return { status: 'lost' }
  if (!failed.exhausted) return { status: 'retrying', attempts: failed.attempts, error }
  await ctx.db.batch([
    ...deadLetter(ctx.db, lease, failed.attempts, error, now),
    ...spec.exhausted(ctx.db, lease.key, now),
  ] as unknown as Batch)
  return { status: 'dead', attempts: failed.attempts, error }
}
