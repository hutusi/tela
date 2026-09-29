/**
 * A fresh, migrated database for tests: libSQL in memory, held to D1's rules, with the generated
 * migrations applied file by file the way `wrangler d1 migrations apply` does.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { libsqlDb } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import type { TelaDb } from './db'
import * as schema from './schema'

export { blockKey, seedBlockTranslations, writingMeanwhile } from './writes-meanwhile'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

/** The generated migrations, in journal order, each split into its statements. */
export function migrationStatements(): { tag: string; statements: string[] }[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: { tag: string }[]
  }
  return journal.entries.map(({ tag }) => ({
    tag,
    statements: readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean),
  }))
}

export async function createTestDb(): Promise<{
  db: TelaDb
  client: ReturnType<typeof libsqlDb>['client']
}> {
  const { db, client } = libsqlDb({ url: ':memory:', schema })
  // D1 enforces foreign keys on every connection; plain SQLite leaves them off.
  await client.execute('pragma foreign_keys = on')
  for (const migration of migrationStatements()) await client.batch(migration.statements)
  return { db, client }
}

/** A member as better-auth would have created one, for tests that need a user row. */
export async function addTestUser(db: TelaDb, id: string, email = `${id}@x.test`): Promise<void> {
  await db.run(sql`
    insert into user (id, name, email, email_verified, created_at, updated_at)
    values (${id}, ${id}, ${email}, 1, 0, 0)
  `)
}
