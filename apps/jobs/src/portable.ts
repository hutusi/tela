/**
 * The exit path off Cloudflare (ADR 0021): the same tick and jobs on a timer, with an in-process
 * queue. The test suite drives it, so it stays working.
 */
import { first } from '@tela/data'
import type { memoryJobs } from '@tela/platform'
import { sql } from 'drizzle-orm'
import type { JobQueues } from './kinds'
import { QUEUES } from './kinds'
import { type JobsContext, type RunOutcome, runJob, type TickReport, tick } from './runner'

export type PortableContext = JobsContext & { jobs: ReturnType<typeof memoryJobs<JobQueues>> }

/**
 * Run every queued message, including work those messages lead to, until the queues are empty.
 * A message's `delaySeconds` is not waited out here, so the same-host gap is gone: whatever runs
 * this against real hosts gives its HTTP client a `politenessMs` of its own.
 */
export async function drain(ctx: PortableContext): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = []
  for (;;) {
    const batch = QUEUES.flatMap((q) => ctx.jobs.take(q))
    if (batch.length === 0) return outcomes
    for (const message of batch) outcomes.push(await runJob(ctx, message))
  }
}

/** One cycle: claim what is due, then do it. */
export async function cycle(
  ctx: PortableContext,
): Promise<{ tick: TickReport; outcomes: RunOutcome[] }> {
  const report = await tick(ctx)
  return { tick: report, outcomes: await drain(ctx) }
}

/** The exit path's scheduler: a cycle every `intervalMs`, one at a time. Returns a stop function. */
export function runPortable(ctx: PortableContext, intervalMs = 60_000): () => void {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await cycle(ctx)
    } finally {
      running = false
    }
  }, intervalMs)
  return () => clearInterval(timer)
}

/**
 * Cycle until nothing is due and nothing is running: what a feed fetch makes due (extraction,
 * titles) runs in the same call, and so does work a lease elsewhere was holding up — a fetch a
 * queue consumer is doing keeps its host's other feeds waiting, since one host has one live lease.
 * For tests; `limit` stops a kind that keeps finding work, `waitMs` a lease that is never let go.
 *
 * Only a cycle that did something counts toward `limit`. Waiting on a lease held elsewhere is
 * bounded by `waitMs` alone, on the wall clock the waits are slept on: counted as cycles, twenty
 * polls 250 ms apart gave up after five seconds, while a host's feeds were still being fetched
 * one after another through the local queue (each hop waits out its batch), and the e2e saw the
 * last of four curated feeds arrive after the cycle meant to fetch it had returned.
 */
export async function settle(
  ctx: PortableContext,
  options: { limit?: number; waitMs?: number; pollMs?: number } = {},
): Promise<TickReport[]> {
  const { limit = 20, waitMs = 25_000, pollMs = 250 } = options
  const deadline = Date.now() + waitMs
  const reports: TickReport[] = []
  let working = 0
  while (working < limit) {
    const { tick: report, outcomes } = await cycle(ctx)
    reports.push(report)
    if (outcomes.length > 0 || Object.values(report).some((n) => n)) {
      working++
      continue
    }
    const live = await first<{ n: number }>(
      ctx.db,
      sql`select count(*) as n from leases where until > ${ctx.clock.now()}`,
    )
    if (!live?.n || Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return reports
}
