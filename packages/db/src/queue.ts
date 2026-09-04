import { sql } from 'drizzle-orm'
import type { Db } from './client'

export type JobSendOptions = {
  singletonKey?: string
  priority?: number
  /** Seconds to wait before the job becomes available. */
  startAfterSeconds?: number
}

/**
 * Enqueue pg-boss jobs from any process that has a Drizzle client, including the web app on
 * Cloudflare, without importing pg-boss (whose `pg` dependency does not bundle for Workers).
 *
 * The INSERT mirrors pg-boss v12's insertJobs plan: queue-level defaults come from
 * `pgboss.queue`, the partitioned `pgboss.job` table routes the row, and `ON CONFLICT DO
 * NOTHING` enforces singleton policies (a duplicate returns null). The round-trip test in
 * packages/db/test/queue.test.ts runs a real pg-boss instance against these rows, so a
 * pg-boss upgrade that changes the schema fails there first.
 *
 * Queues are created by the worker's ensureQueues(); sending to a missing queue throws.
 */
export function createJobSender(db: Db, schema = 'pgboss') {
  const table = (name: string) => sql.raw(`"${schema}"."${name}"`)
  return {
    async send(
      queue: string,
      data: Record<string, unknown>,
      options: JobSendOptions = {},
    ): Promise<string | null> {
      const priority = options.priority ?? 0
      const startAfter = Math.max(0, options.startAfterSeconds ?? 0)
      const singletonKey = options.singletonKey ?? null
      const rows = await db.execute<{ id: string }>(sql`
        insert into ${table('job')} (
          id, name, data, priority, start_after, singleton_key,
          expire_seconds, deletion_seconds, keep_until,
          retry_limit, retry_delay, retry_backoff, retry_delay_max,
          policy, dead_letter, heartbeat_seconds,
          blocked, blocking, pending_dependencies
        )
        select
          gen_random_uuid(), q.name, ${JSON.stringify(data)}::jsonb, ${priority},
          now() + make_interval(secs => ${startAfter}), ${singletonKey},
          q.expire_seconds, q.deletion_seconds,
          now() + make_interval(secs => ${startAfter}) + q.retention_seconds * interval '1s',
          q.retry_limit, q.retry_delay, coalesce(q.retry_backoff, false), q.retry_delay_max,
          q.policy, q.dead_letter, q.heartbeat_seconds,
          false, false, 0
        from ${table('queue')} q
        where q.name = ${queue}
        on conflict do nothing
        returning id
      `)
      if (rows.length === 0) {
        const [exists] = await db.execute<{ name: string }>(
          sql`select name from ${table('queue')} where name = ${queue}`,
        )
        if (!exists) throw new Error(`pg-boss queue "${queue}" does not exist`)
        return null
      }
      return rows[0]?.id ?? null
    },
  }
}

export type JobSender = ReturnType<typeof createJobSender>
