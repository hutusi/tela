import { type SQL, sql } from 'drizzle-orm'
import { integer, type SQLiteColumn } from 'drizzle-orm/sqlite-core'

/** Epoch milliseconds (ADR 0021: timestamps are INTEGER, never text). */
export const ms = () => integer()

/** The sync sequence stamp every synced row carries (ADR 0021). */
export const seq = () => integer().notNull().default(0)

/** SQLite booleans are 0/1 integers. */
export const flag = () => integer({ mode: 'boolean' }).notNull().default(false)

/** `column IN ('a', 'b')` for a CHECK constraint over one of the shared `as const` value lists. */
export function oneOf(column: SQLiteColumn, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ')
  return sql`${column} in (${sql.raw(list)})`
}

/** A JSON column must hold valid JSON; SQLite would otherwise store any text. */
export function validJson(column: SQLiteColumn): SQL {
  return sql`json_valid(${column})`
}
