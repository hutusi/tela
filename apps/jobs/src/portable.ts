/**
 * The exit path off Cloudflare (ADR 0021): the same tick and jobs on a timer, with an in-process
 * queue. The test suite drives it, so it stays working.
 */
import type { memoryJobs } from '@tela/platform/portable'
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
