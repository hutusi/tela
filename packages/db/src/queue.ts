import { type SQL, sql } from 'drizzle-orm'
import type { DbExecutor } from './client'

export type JobSendOptions = {
  singletonKey?: string
  priority?: number
  /** Seconds to wait before the job becomes available. */
  startAfterSeconds?: number
}

/** Every column pg-boss v12's insertJobs writes, in its order. Kept in one place on purpose. */
const JOB_COLUMNS = sql.raw(`
  id, name, data, priority, start_after, singleton_key,
  expire_seconds, deletion_seconds, keep_until,
  retry_limit, retry_delay, retry_backoff, retry_delay_max,
  policy, dead_letter, heartbeat_seconds,
  blocked, blocking, pending_dependencies
`)

/** Per-row values; everything else on a job comes from its queue's defaults. */
type JobValues = {
  data: SQL
  priority: SQL
  startAfterSeconds: SQL
  singletonKey: SQL
}

/**
 * The one insert plan. `from` adds a row source to the queue lookup, so a single job and a
 * whole select share these columns and cannot drift apart.
 */
function insertJobs(
  table: (name: string) => SQL,
  queue: string,
  values: JobValues,
  from: SQL,
): SQL {
  return sql`
    insert into ${table('job')} (${JOB_COLUMNS})
    select
      gen_random_uuid(), q.name, ${values.data}, ${values.priority},
      now() + make_interval(secs => ${values.startAfterSeconds}), ${values.singletonKey},
      q.expire_seconds, q.deletion_seconds,
      now() + make_interval(secs => ${values.startAfterSeconds})
        + q.retention_seconds * interval '1s',
      q.retry_limit, q.retry_delay, coalesce(q.retry_backoff, false), q.retry_delay_max,
      q.policy, q.dead_letter, q.heartbeat_seconds,
      false, false, 0
    from ${table('queue')} q
    ${from}
    where q.name = ${queue}
    on conflict do nothing
    returning id
  `
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
 *
 * Accepts a transaction handle as well as a Db, so a job can be inserted in the same
 * transaction as the row it belongs to (ADR 0004): if the status write rolls back, so does
 * the job, and a job never exists for a status that was never written.
 */
export function createJobSender(db: DbExecutor, schema = 'pgboss') {
  const table = (name: string) => sql.raw(`"${schema}"."${name}"`)
  const queueExists = async (queue: string) => {
    const [row] = await db.execute<{ name: string }>(
      sql`select name from ${table('queue')} where name = ${queue}`,
    )
    return row !== undefined
  }
  return {
    async send(
      queue: string,
      data: Record<string, unknown>,
      options: JobSendOptions = {},
    ): Promise<string | null> {
      const startAfter = Math.max(0, options.startAfterSeconds ?? 0)
      const rows = await db.execute<{ id: string }>(
        insertJobs(
          table,
          queue,
          {
            data: sql`${JSON.stringify(data)}::jsonb`,
            priority: sql`${options.priority ?? 0}`,
            startAfterSeconds: sql`${startAfter}`,
            singletonKey: sql`${options.singletonKey ?? null}`,
          },
          sql``,
        ),
      )
      if (rows.length === 0) {
        if (!(await queueExists(queue))) throw new Error(`pg-boss queue "${queue}" does not exist`)
        return null
      }
      return rows[0]?.id ?? null
    },

    /**
     * Enqueue one job per row of `source`, in a single statement.
     *
     * `source` must be a select yielding `data` (jsonb), `singleton_key` (text or null) and
     * `priority` (int). It is for bulk work — recovery commands, backfills — where a job per
     * round trip would mean thousands of them, and where the rows are chosen by a query rather
     * than held in memory. Selecting and inserting in one statement also means the source's own
     * WHERE clause is evaluated against the same snapshot as the insert.
     *
     * Returns the number of jobs created. Rows a singleton policy rejects are skipped silently,
     * exactly as `send` returns null for them.
     */
    async sendFrom(queue: string, source: SQL): Promise<number> {
      const rows = await db.execute<{ id: string }>(
        insertJobs(
          table,
          queue,
          {
            data: sql`src.data`,
            priority: sql`coalesce(src.priority, 0)`,
            startAfterSeconds: sql`0`,
            singletonKey: sql`src.singleton_key`,
          },
          sql`cross join (${source}) as src`,
        ),
      )
      if (rows.length === 0 && !(await queueExists(queue))) {
        throw new Error(`pg-boss queue "${queue}" does not exist`)
      }
      return rows.length
    },
  }
}

export type JobSender = ReturnType<typeof createJobSender>
