import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../client'
import { prepareDatabase, startLocalCluster } from './local-postgres'

export { prepareDatabase, startLocalCluster } from './local-postgres'

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
    // Test files run one after another against this one database. Give each file what a
    // throwaway cluster gives it: empty tables and no queue schema (files that boot pg-boss
    // create it themselves).
    await resetDatabase(db)
    await db.execute(sql`drop schema if exists pgboss cascade`)
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

/** Truncate every application table between tests (keeps migrations and pgboss). */
export async function resetDatabase(db: Db) {
  await db.execute(
    sql.raw(`truncate table
      recommendations, user_article_states, subscriptions, site_claims, llm_usage, rate_limits,
      article_translations, translations, article_contents, articles, feeds, sites, profiles, auth.users
      restart identity cascade`),
  )
}
