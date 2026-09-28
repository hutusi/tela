/**
 * The sync sequence (ADR 0021). A batch that changes a row readers sync starts with `bumpSeq`,
 * and stamps the rows it writes with `currentSeq`. SQLite has one writer, so seq order is commit
 * order with no gaps, and a reader's cursor is the last seq it has seen.
 */
import { sql } from 'drizzle-orm'
import type { TelaDb } from './db'

/** The first statement of any batch that writes synced rows. */
export function bumpSeq(db: TelaDb) {
  return db.run(
    sql`insert into counters (k, v) values ('seq', 1) on conflict (k) do update set v = v + 1`,
  )
}

/** The value the current batch stamps on the rows it writes; use it as a column value. */
export const currentSeq = sql<number>`(select v from counters where k = 'seq')`

/** The newest seq committed, for a reader starting from scratch. */
export async function headSeq(db: TelaDb): Promise<number> {
  const row = await db.get<{ v: number } | undefined>(sql`select v from counters where k = 'seq'`)
  return row?.v ?? 0
}
