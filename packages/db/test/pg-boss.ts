import type { Db as PgBossDb } from 'pg-boss'
import type { Db } from '../src/client'

/** pg-boss adapter over the postgres.js client, on reserved connections (pg-boss issues BEGIN). */
export function pgBossDatabase(db: Db): PgBossDb {
  return {
    async executeSql(text, values) {
      const conn = await db.raw.reserve()
      try {
        const rows = await conn.unsafe(text, (values ?? []) as never[])
        return { rows: [...rows] }
      } finally {
        conn.release()
      }
    },
  }
}
