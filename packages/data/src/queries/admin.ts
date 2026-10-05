/**
 * The admin console's audit log (ADR 0039). Every change an operator makes is one batch: the audit
 * row first, an `insert … select` that reads the value it replaces in that batch's snapshot, then
 * the change itself, under the same condition. So the log never claims a change that did not
 * happen, and `from` is exactly what was there.
 */
import type { AdminActionName, AdminAuditAction, AdminHistoryEntry } from '@tela/shared/admin'
import { is, SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'

export type AuditTarget = {
  group: string
  /** Null for the CLI, which acts with the operator's token rather than as a member. */
  actor: string | null
  action: AdminAuditAction
  targetKind: string
  /** The target's key, or an expression over `source` that reads it. */
  targetKey: string | SQL
  at: number
}

/** A fresh group id: one per request, shared by every target a bulk action touches. */
export function newGroupId(): string {
  return crypto.randomUUID()
}

/**
 * The audit row for a change, read in the change's own batch. `from` is a JSON expression
 * evaluated over `source` (`json_object('listing', listing)`, never a bare column), `to` the value
 * written, and `source` the `from … where …` that matches the target exactly when the change
 * applies; `to` may be a JSON expression too, for a value the change computes in SQL. With no
 * `source` the row is written unconditionally (`from` must then not name a column). `json_set`, not `json_patch`, assembles the detail: a merge patch drops every key whose
 * value is null, and a null in `from` (an unclaimed site's owner) is a value an undo restores.
 */
export function audit(
  db: TelaDb,
  target: AuditTarget,
  change: { from?: SQL; to?: unknown; extra?: Record<string, unknown> },
  source?: SQL,
) {
  const extra = JSON.stringify(change.extra ?? {})
  const to =
    change.to === undefined
      ? sql`null`
      : is(change.to, SQL)
        ? sql`json(${change.to})`
        : sql`json(${JSON.stringify(change.to)})`
  const from = change.from ? sql`json(${change.from})` : sql`null`
  return db.run(sql`
    insert into admin_actions (group_id, actor_id, action, target_kind, target_key, detail, at)
    select ${target.group}, ${target.actor}, ${target.action}, ${target.targetKind},
      ${target.targetKey}, json_set(json(${extra}), '$.from', ${from}, '$.to', ${to}), ${target.at}
    ${source ?? sql``}
  `)
}

/**
 * The first statement of an undo's batch: it aborts the whole batch, as a lost lease's fence does,
 * when `changed` holds (a target moved on since the action) or the group was undone already.
 * `isFenceRefusal` recognises the abort.
 */
export function undoGuard(db: TelaDb, group: string, changed: SQL) {
  return db.run(sql`
    insert into lease_fence (x) select null
    where (${changed}) or exists (
      select 1 from admin_actions
      where action = 'undo' and json_extract(detail, '$.group') = ${group}
    )
  `)
}

export type AuditRow = {
  id: number
  group_id: string
  actor_id: string | null
  action: AdminAuditAction
  target_kind: string
  target_key: string
  detail: string
  at: number
}

/** A group's rows, in the order they were written. */
export async function groupRows(db: TelaDb, group: string): Promise<AuditRow[]> {
  return db.all<AuditRow>(sql`
    select id, group_id, actor_id, action, target_kind, target_key, detail, at
    from admin_actions where group_id = ${group} order by id
  `)
}

type HistoryRaw = AuditRow & { handle: string | null; display_name: string | null }

function toEntry(row: HistoryRaw): AdminHistoryEntry {
  let detail: { from?: unknown; to?: unknown; undid?: AdminActionName } = {}
  try {
    detail = JSON.parse(row.detail) as typeof detail
  } catch {}
  return {
    at: row.at,
    actor:
      row.actor_id && row.handle
        ? { id: row.actor_id, handle: row.handle, name: row.display_name }
        : null,
    action: row.action,
    targetKind: row.target_kind,
    targetKey: row.target_key,
    ...(detail.undid ? { undid: detail.undid } : {}),
    ...(detail.from !== undefined && detail.from !== null ? { from: detail.from } : {}),
    ...(detail.to !== undefined && detail.to !== null ? { to: detail.to } : {}),
  }
}

const HISTORY_COLUMNS = sql`a.id, a.group_id, a.actor_id, a.action, a.target_kind, a.target_key,
  a.detail, a.at, p.handle, p.display_name`

/** What operators did to one target, newest first. */
export async function historyOf(
  db: TelaDb,
  targetKind: string,
  targetKey: string,
  limit = 50,
): Promise<AdminHistoryEntry[]> {
  const rows = await db.all<HistoryRaw>(sql`
    select ${HISTORY_COLUMNS} from admin_actions a
    left join profiles p on p.user_id = a.actor_id
    where a.target_kind = ${targetKind} and a.target_key = ${targetKey}
    order by a.at desc, a.id desc limit ${limit}
  `)
  return rows.map(toEntry)
}

/** The latest operator actions anywhere, newest first. */
export async function recentActivity(db: TelaDb, limit = 12): Promise<AdminHistoryEntry[]> {
  const rows = await db.all<HistoryRaw>(sql`
    select ${HISTORY_COLUMNS} from admin_actions a
    left join profiles p on p.user_id = a.actor_id
    order by a.at desc, a.id desc limit ${limit}
  `)
  return rows.map(toEntry)
}
