/**
 * What every library action is made of (ADR 0039). One target is one batch: the sync sequence
 * first (every table here is one readers sync, bar a claim's review stamp and a blogroll's Hide),
 * the audit row read under the change's own condition, the change with `RETURNING`, then whatever
 * must follow it, and a last select that tells a target that is gone from one the action does not
 * apply to.
 */
import { audit, bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { BLOGROLL_ID, COMMUNITY_LISTING_MIN_READERS } from '@tela/shared'
import type { AdminActionName, AdminPerson } from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { type ActContext, type Inverse, returned, runBatch } from '../framework'

/**
 * What the doors say a site's listing is when no Feature or Hide has a say (ADRs 0018, 0041):
 * listed once someone claimed it, enough readers follow it, or an operator's review listed it
 * (List, Feature, curation), private otherwise. `site.restore` returns a featured or hidden site
 * here, so a blog featured or listed from the review queue stays in Discover when unfeatured.
 * `private` is never an operator's choice: on an unclaimed site the next subscribe would list it
 * again, so the veto that sticks is `rejected`.
 */
export const DOORS_SAY = sql`(case when claimed_by is not null
  or reader_count >= ${COMMUNITY_LISTING_MIN_READERS} or review = 'listed'
  then 'listed' else 'private' end)`

/** A row's id from a request's id (`'12'`), or null: positive, safe, and written plainly. */
export const idOf = (id: string): number | null => {
  const n = Number(id)
  return Number.isSafeInteger(n) && n > 0 && String(n) === id ? n : null
}

/** The site's id from a request's id, or null. */
export const siteIdOf = idOf

/** A blogroll's id from a request's id, or null: the shape its member's device mints. */
export const blogrollIdOf = (id: string): string | null => (BLOGROLL_ID.test(id) ? id : null)

/**
 * The tables library actions write: what the audit log calls a row of each, how a request or an
 * audit row's key names one (null for a key that names none), and whether a change stamps
 * `updated_at`. A blogroll's `updated_at` is its member's clock for its name and description, the
 * later one winning (ADR 0050): an operator's stamp there would make the member's next rename,
 * made on a device that had not seen it, lose.
 */
export const TABLES = {
  sites: { kind: 'site', keyOf: idOf, updatedAt: true },
  feeds: { kind: 'feed', keyOf: idOf, updatedAt: true },
  site_claims: { kind: 'claim', keyOf: idOf, updatedAt: false },
  blogrolls: { kind: 'blogroll', keyOf: blogrollIdOf, updatedAt: false },
} as const
export type Table = keyof typeof TABLES

/** A row's key in `table`: a number, or a blogroll's text id. */
export type KeyOf<T extends Table> = NonNullable<ReturnType<(typeof TABLES)[T]['keyOf']>>
export type RowKey = KeyOf<Table>

/**
 * True, in a statement after the change in the same batch, when the change applied: it stamped
 * the row with this batch's seq, which no other batch has. So what must follow a change (a lease
 * to break, topics to replace) runs exactly when the change did, without a second condition that
 * could read the row after the change and disagree.
 */
export const stamped = (table: Table, id: RowKey) =>
  sql`exists (select 1 from ${sql.raw(table)} where id = ${id} and seq = ${currentSeq})`

/**
 * Break an item's lease (ADR 0039): a job already running finds its fence refused at commit and
 * writes nothing over the operator's choice, and one claimed but not started never starts.
 */
export const breakLease = (db: TelaDb, kind: string, id: number, when: SQL) =>
  db.run(sql`delete from leases where kind = ${kind} and key = ${String(id)} and ${when}`)

export type Change = {
  action: AdminActionName
  table: Table
  id: RowKey
  /** The row's state the action applies to, over the table's own columns. */
  applies: SQL
  /** `set` assignments, without `seq` and `updated_at`, which are added; none to only stamp. */
  set?: SQL
  /** A JSON expression over the row: what an undo restores, or what the history shows. */
  from: SQL
  /** The value written, or a JSON expression over the row for one computed in SQL. */
  to: unknown
  /** Statements that must follow the change, conditioned on `stamped(table, id)`. */
  after?: (db: TelaDb) => BatchItem<'sqlite'>[]
  /**
   * False for a column no device holds (a claim's review stamp, a blogroll's Hide): no seq, and
   * nothing follows.
   */
  synced?: boolean
}

/**
 * Apply one change to one target in one batch, audited. `done` when it changed the row;
 * `not_found` when the row does not exist; `not_applicable` when it does, but not in a state the
 * action applies to.
 */
export async function applyChange(ctx: ActContext, change: Change) {
  const { db } = ctx.deps
  const { table, id } = change
  const synced = change.synced ?? true
  const name = sql.raw(table)
  const assignments = [
    ...(change.set ? [change.set] : []),
    ...(TABLES[table].updatedAt ? [sql`updated_at = ${ctx.now}`] : []),
    ...(synced ? [sql`seq = ${currentSeq}`] : []),
  ]
  const items: BatchItem<'sqlite'>[] = [
    ...(synced ? [bumpSeq(db)] : []),
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: change.action,
        targetKind: TABLES[table].kind,
        targetKey: String(id),
        at: ctx.now,
      },
      { from: change.from, to: change.to },
      sql`from ${name} where id = ${id} and ${change.applies}`,
    ),
    db.all(sql`
      update ${name} set ${sql.join(assignments, sql`, `)}
      where id = ${id} and ${change.applies}
      returning id
    `),
    ...(synced && change.after ? change.after(db) : []),
    db.all(sql`select id from ${name} where id = ${id}`),
  ]
  const results = await runBatch(db, items)
  const updated = results[synced ? 2 : 1]
  if (returned(updated).length > 0) return 'done' as const
  return returned(results.at(-1)).length > 0 ? ('not_applicable' as const) : ('not_found' as const)
}

/** How an inverse names a column and the key `from` and `to` keep it under. */
export type Columns = Record<string, string>

/**
 * The inverse of a change that set plain columns: while the row still holds every `match` key of
 * `to` (all of them by default), put each key of `from` back. `match` leaves out a column that
 * moves on its own (a feed's timeout streak), which is restored but not compared. `set` adds
 * what a restore also writes, and `after` what follows it (a lease to break), like `Change`'s;
 * `committed` what follows once the undo's batch has committed.
 */
export function restoreColumns<T extends Table>(options: {
  table: T
  columns: Columns
  match?: string[]
  set?: (now: number) => SQL
  after?: (db: TelaDb, id: KeyOf<T>) => BatchItem<'sqlite'>[]
  /** What follows a restore once its batch has committed: work too large for one batch. */
  committed?: (db: TelaDb, id: KeyOf<T>, from: Record<string, unknown>) => Promise<void>
  synced?: boolean
}): Inverse {
  const { table, columns } = options
  const synced = options.synced ?? true
  return (db, change, now) => {
    const id = TABLES[table].keyOf(change.targetKey) as KeyOf<T> | null
    // A key no row of the table could have: nothing holds what the action set, so nothing is put
    // back and the undo is refused.
    if (id === null) return { changed: sql`true`, restore: [], synced }
    const from = (change.from ?? {}) as Record<string, unknown>
    const to = (change.to ?? {}) as Record<string, unknown>
    const keys = options.match ?? Object.keys(columns)
    const holds = sql.join(
      keys.map((key) => sql`${sql.raw(columns[key] ?? key)} is ${to[key] ?? null}`),
      sql` and `,
    )
    const name = sql.raw(table)
    const assignments = [
      ...Object.entries(columns)
        .filter(([key]) => key in from)
        .map(([key, column]) => sql`${sql.raw(column)} = ${from[key] ?? null}`),
      ...(options.set ? [options.set(now)] : []),
      ...(TABLES[table].updatedAt ? [sql`updated_at = ${now}`] : []),
      ...(synced ? [sql`seq = ${currentSeq}`] : []),
    ]
    return {
      changed: sql`not exists (select 1 from ${name} where id = ${id} and ${holds})`,
      restore: [
        db.run(sql`
          update ${name} set ${sql.join(assignments, sql`, `)}
          where id = ${id} and ${holds}
        `),
        ...(synced && options.after ? options.after(db, id) : []),
      ],
      synced,
      ...(options.committed
        ? { committed: () => options.committed?.(db, id, from) ?? Promise.resolve() }
        : {}),
    }
  }
}

/** `like` pattern for a search: case-insensitive for ASCII, `%` and `_` taken literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** `expr like pattern`, with the escape the pattern was built for. */
export const like = (expr: SQL, pattern: string) => sql`${expr} like ${pattern} escape '\\'`

/** A member as the console names them, from three columns a query selected. */
export function personOf(
  id: string | null | undefined,
  handle: string | null | undefined,
  name: string | null | undefined,
): AdminPerson | null {
  return id && handle ? { id, handle, name: name ?? null } : null
}
