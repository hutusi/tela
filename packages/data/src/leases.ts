/**
 * The one lease primitive for all background work (ADR 0021).
 *
 * Work is found from state: the caller passes a query for what is due, returning `key`, `host`
 * (null when politeness does not apply) and `ord` (claim order). A lease row exists while an item
 * is held or backing off; success deletes it. Every function takes `now` so a test's clock, not
 * the wall, decides expiry.
 */
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from './db'
import type { LeaseKind } from './schema/values'

export type Lease = { kind: LeaseKind; key: string; owner: string }

/** `attempts` counts starts that did not succeed, including ones that died without reporting. */
export type Claimed = { key: string; host: string | null; owner: string; attempts: number }

/**
 * Claim up to `limit` due items for `owner`, in `ord` order, one per host, skipping items that are
 * leased or backing off and hosts that hold a live lease of any kind. Returns what was claimed.
 */
export async function claimDue(
  db: TelaDb,
  options: {
    kind: LeaseKind
    owner: string
    now: number
    ttlMs: number
    limit: number
    /** `select <key> as key, <host> as host, <order> as ord from … where <due>`; keys compare as text. */
    due: SQL
  },
): Promise<Claimed[]> {
  const { kind, owner, now, ttlMs, limit, due } = options
  // One upsert. The WHERE on the SELECT is what SQLite needs to parse the ON CONFLICT clause as
  // part of the INSERT rather than as a join constraint.
  return db.all<Claimed>(sql`
    insert into leases (kind, key, owner, until, attempts, not_before, host)
    select ${kind}, d.key, ${owner}, ${now + ttlMs}, 0, 0, d.host
    from (
      select k as key, host, ord,
        row_number() over (partition by coalesce(host, k) order by ord) as per_host
      from (
        -- Keys compare as text. A bound JS number arrives as REAL on some drivers, and
        -- cast(1.0 as text) is '1.0', which would never match the lease key '1'.
        select case when typeof(key) = 'real' and key = cast(key as integer)
                    then cast(cast(key as integer) as text) else cast(key as text) end as k,
               host, ord
        from (${due})
      )
    ) as d
    where d.per_host = 1
      and d.key not in (
        select key from leases where kind = ${kind} and (until >= ${now} or not_before > ${now})
      )
      and (d.host is null or d.host not in (
        select host from leases where host is not null and until >= ${now}
      ))
    order by d.ord
    limit ${limit}
    on conflict (kind, key) do update set
      owner = excluded.owner, until = excluded.until, host = excluded.host
    where leases.until < ${now} and leases.not_before <= ${now}
    returning key, host, owner, attempts
  `)
}

/**
 * Begin work under a claim: renew it and count the attempt. Counting here rather than on failure
 * is what catches a holder that dies without reporting (over its CPU or memory limit, evicted,
 * past its wall clock): its lease only expires, and an attempt counted at failure would never be
 * counted, so the item would be retried every TTL for ever. A message that waited in its queue
 * past the lease never starts, so queue lag costs no attempt. Returns the attempt number and the
 * host the lease holds, or null when the claim was already lost.
 */
export async function startLease(
  db: TelaDb,
  lease: Lease,
  now: number,
  ttlMs: number,
): Promise<{ attempts: number; host: string | null } | null> {
  const rows = await db.all<{ attempts: number; host: string | null }>(sql`
    update leases set until = ${now + ttlMs}, attempts = attempts + 1
    where kind = ${lease.kind} and key = ${lease.key} and owner = ${lease.owner}
      and until >= ${now}
    returning attempts, host
  `)
  return rows[0] ?? null
}

/** Hold a lease longer. Returns false when it was lost (expired, or taken by another owner). */
export async function extendLease(db: TelaDb, lease: Lease, now: number, ttlMs: number) {
  const rows = await db.all<{ key: string }>(sql`
    update leases set until = ${now + ttlMs}
    where kind = ${lease.kind} and key = ${lease.key} and owner = ${lease.owner}
      and until >= ${now}
    returning key
  `)
  return rows.length === 1
}

/**
 * The first statement of a fenced batch: it inserts NULL into a NOT NULL column unless `lease` is
 * still live, which aborts the whole batch. Every write decided in JavaScript under a lease
 * commits this way, so a holder that lost its lease cannot overwrite the new holder's work.
 */
export function fence(db: TelaDb, lease: Lease, now: number) {
  return db.run(sql`
    insert into lease_fence (x) select null where not exists (
      select 1 from leases
      where kind = ${lease.kind} and key = ${lease.key} and owner = ${lease.owner}
        and until >= ${now}
    )
  `)
}

/** The last statement of a successful fenced batch: the work is done, the lease goes. */
export function release(db: TelaDb, lease: Lease) {
  return db.run(sql`
    delete from leases where kind = ${lease.kind} and key = ${lease.key} and owner = ${lease.owner}
  `)
}

/** True when an error is the fence refusing a batch whose lease was lost. */
export function isFenceRefusal(err: unknown): boolean {
  const text = `${String(err)} ${String((err as { cause?: unknown })?.cause ?? '')}`
  return /NOT NULL constraint failed: lease_fence\.x/i.test(text)
}

export type Backoff = { baseMs: number; maxMs: number; maxAttempts: number }

/**
 * Give an item back after a failed attempt (counted by `startLease`): it is not claimed again
 * before `now + base·2^(attempts-1)` (capped). Returns the attempt count, or null when the lease
 * was already lost. At `maxAttempts` the caller dead-letters the item and marks its domain row so
 * it stops being due.
 */
export async function failLease(
  db: TelaDb,
  lease: Lease,
  now: number,
  backoff: Backoff,
  error: string,
): Promise<{ attempts: number; exhausted: boolean } | null> {
  const rows = await db.all<{ attempts: number }>(sql`
    update leases set
      until = 0,
      not_before = ${now} + min(${backoff.maxMs}, ${backoff.baseMs} * (1 << max(0, min(attempts - 1, 30)))),
      last_error = ${error.slice(0, 500)}
    where kind = ${lease.kind} and key = ${lease.key} and owner = ${lease.owner}
    returning attempts
  `)
  const attempts = rows[0]?.attempts
  if (attempts === undefined) return null
  return { attempts, exhausted: attempts >= backoff.maxAttempts }
}

/** Statements that retire an exhausted item: a dead letter, and its lease row gone. */
export function deadLetter(db: TelaDb, lease: Lease, attempts: number, error: string, now: number) {
  return [
    db.run(sql`
      insert into dead_letters (kind, key, attempts, error, at)
      values (${lease.kind}, ${lease.key}, ${attempts}, ${error.slice(0, 500)}, ${now})
    `),
    db.run(sql`delete from leases where kind = ${lease.kind} and key = ${lease.key}`),
  ] as const
}
