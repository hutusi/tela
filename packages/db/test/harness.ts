import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../src/client'
import { prepareDatabase, startLocalCluster } from '../src/testing/local-postgres'

export type TestDb = {
  db: Db
  url: string
  stop: () => Promise<void>
}

/**
 * A migrated database for tests: TEST_DATABASE_URL if set (CI service container, Supabase
 * local), otherwise a throwaway cluster started with the local initdb.
 */
export async function startTestDb(): Promise<TestDb> {
  const external = process.env.TEST_DATABASE_URL
  if (external) {
    const db = createDb(external, { max: 3 })
    await prepareDatabase(db)
    return { db, url: external, stop: () => db.close() }
  }
  const cluster = await startLocalCluster()
  const db = createDb(cluster.url, { max: 3 })
  await prepareDatabase(db)
  return {
    db,
    url: cluster.url,
    stop: async () => {
      await db.close()
      await cluster.stop()
    },
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Run `fn` as the given Supabase role and user, inside one transaction (RLS applies). */
export async function asUser<T>(
  db: Db,
  role: 'anon' | 'authenticated',
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${role}`))
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId ?? ''}, true)`)
    return fn(tx)
  })
}
