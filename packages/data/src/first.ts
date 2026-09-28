import type { SQL } from 'drizzle-orm'
import type { TelaDb } from './db'

/**
 * The first row of a query, or undefined. Use this, never `db.get()`, for a row that may not
 * exist: drizzle 0.45's libSQL driver throws on an empty result where its D1 driver returns
 * undefined, so the portable path and production would disagree.
 */
export async function first<T>(db: TelaDb, query: SQL): Promise<T | undefined> {
  return (await db.all<T>(query))[0]
}
