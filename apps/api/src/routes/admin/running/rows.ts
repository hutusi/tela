/**
 * The Overview's queues and the System ledger: which rows wait on an operator, and dead letters as
 * the contract's rows. Claims, feeds and sites come from the library's own row builders
 * (`../library/rows`), so a queue and its ledger agree on a row and on what it offers.
 */
import { isRedueKind, type TelaDb } from '@tela/data'
import type { AdminActionName, AdminDeadRow } from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { type Names, targetOf } from './names'

type Row = Record<string, unknown>

const num = (v: unknown): number => Number(v ?? 0)
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** A feed that is failing or timing out, while it is still being fetched. */
export const FEED_FAILING = sql`f.status = 'active' and (f.error_count > 0 or f.timeout_streak >= 3)`

/** A blog Discover could list: nobody has claimed it, and the doors keep it private. */
export const DISCOVER_CANDIDATE = sql`s.listing = 'private' and s.claimed_by is null`

export const DEAD_UNRESOLVED = sql`d.resolved_at is null`

/** Dead letters, `where` given (over `d`). */
export function deadRows(db: TelaDb, where: SQL, order: SQL, limit: number) {
  return db.all(sql`
    select d.id, d.kind, d.key, d.attempts, d.error, d.at, d.resolved_at, d.resolution
    from dead_letters d
    where ${where}
    order by ${order}
    limit ${limit}
  `)
}

/** What can be done to a dead letter: retried while unresolved and of a kind REDUE knows. */
export function deadActions(kind: string, resolved: boolean): AdminActionName[] {
  if (resolved) return []
  return isRedueKind(kind) ? ['dead.retry', 'dead.dismiss'] : ['dead.dismiss']
}

export function toDeadRow(row: Row, names: Names): AdminDeadRow {
  const kind = String(row.kind)
  const key = String(row.key)
  const resolvedAt = numOrNull(row.resolved_at)
  const resolution = row.resolution === 'retried' || row.resolution === 'dismissed'
  return {
    id: `dead:${num(row.id)}`,
    actions: deadActions(kind, resolvedAt !== null),
    type: 'dead',
    deadId: num(row.id),
    kind,
    key,
    attempts: num(row.attempts),
    error: strOrNull(row.error),
    at: num(row.at),
    resolvedAt,
    resolution: resolution ? (row.resolution as 'retried' | 'dismissed') : null,
    target: targetOf(names, kind, key),
  }
}
