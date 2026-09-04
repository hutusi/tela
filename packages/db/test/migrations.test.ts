import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb, type Db } from '../src/client'
import { startTestDb, type TestDb } from '../src/testing'
import { MIGRATIONS_DIR, SUPABASE_STANDIN } from '../src/testing/local-postgres'

/**
 * Migrations normally only ever run against an empty database in tests, which hides anything
 * that depends on existing rows. This harness applies the journal up to a given migration into a
 * fresh database, lets a test seed rows, then applies the rest.
 */
const DB_NAME = 'tela_migrations_check'
let t: TestDb
let fresh: Db
let scratch: string

type Journal = { entries: Array<{ idx: number; tag: string }> }

async function folderUpTo(idx: number): Promise<string> {
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>
  const dir = await mkdtemp(join(scratch, 'migrations-'))
  await mkdir(join(dir, 'meta'))
  const entries = journal.entries.filter((e) => e.idx <= idx)
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const e of entries) {
    await copyFile(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
  }
  return dir
}

beforeAll(async () => {
  t = await startTestDb()
  scratch = await mkdtemp(join(tmpdir(), 'tela-migrations-'))
  await t.db.execute(sql.raw(`drop database if exists ${DB_NAME}`))
  await t.db.execute(sql.raw(`create database ${DB_NAME}`))
  const url = new URL(t.url)
  url.pathname = `/${DB_NAME}`
  fresh = createDb(url.toString(), { max: 1 })
  await fresh.execute(sql.raw(SUPABASE_STANDIN))
}, 120_000)

afterAll(async () => {
  await fresh?.close()
  await t?.db.execute(sql.raw(`drop database if exists ${DB_NAME}`))
  await t?.stop()
  await rm(scratch, { recursive: true, force: true })
})

describe('0009 site_claims unique per user', () => {
  test('deduplicates existing claims, keeping the verified one or else the newest', async () => {
    await migrate(fresh, { migrationsFolder: await folderUpTo(8) })
    const userA = '11111111-1111-4111-8111-111111111111'
    const userB = '22222222-2222-4222-8222-222222222222'
    await fresh.execute(
      sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
    )
    const [site] = await fresh.execute<{ id: number }>(
      sql`insert into sites (home_url) values ('https://dup.example') returning id`,
    )
    const siteId = site?.id as number
    // Before the unique index, the old race could leave several claims per (site, user).
    await fresh.execute(sql`
      insert into site_claims (site_id, user_id, method, token, status) values
        (${siteId}, ${userA}, 'meta', 'a-verified-older', 'verified'),
        (${siteId}, ${userA}, 'meta', 'a-pending-newer', 'pending'),
        (${siteId}, ${userB}, 'meta', 'b-pending-older', 'pending'),
        (${siteId}, ${userB}, 'meta', 'b-pending-newer', 'pending')
    `)

    await migrate(fresh, { migrationsFolder: MIGRATIONS_DIR })

    const rows = await fresh.execute<{ user_id: string; token: string; status: string }>(
      sql`select user_id, token, status from site_claims where site_id = ${siteId} order by user_id`,
    )
    expect([...rows]).toEqual([
      { user_id: userA, token: 'a-verified-older', status: 'verified' },
      { user_id: userB, token: 'b-pending-newer', status: 'pending' },
    ])
    const [index] = await fresh.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'site_claims_site_user_key'`,
    )
    expect(index?.indexdef).toContain('UNIQUE')
  })
})
