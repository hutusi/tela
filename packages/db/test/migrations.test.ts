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
let t: TestDb
let scratch: string
const opened: Array<{ name: string; db: Db }> = []

/** A new empty database in the test cluster, with the Supabase stand-in, for one test. */
async function freshDatabase(name: string): Promise<Db> {
  await t.db.execute(sql.raw(`drop database if exists ${name}`))
  await t.db.execute(sql.raw(`create database ${name}`))
  const url = new URL(t.url)
  url.pathname = `/${name}`
  const db = createDb(url.toString(), { max: 1 })
  await db.execute(sql.raw(SUPABASE_STANDIN))
  opened.push({ name, db })
  return db
}

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
}, 120_000)

afterAll(async () => {
  for (const { name, db } of opened) {
    await db.close()
    await t?.db.execute(sql.raw(`drop database if exists ${name}`))
  }
  await t?.stop()
  await rm(scratch, { recursive: true, force: true })
})

describe('0009 site_claims unique per user', () => {
  test('deduplicates existing claims, keeping the verified one or else the newest', async () => {
    const fresh = await freshDatabase('tela_migrations_claims')
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

describe('0014 provenance columns', () => {
  test('makes every active feed due for a full fetch so its served origin gets recorded', async () => {
    const fresh = await freshDatabase('tela_migrations_provenance')
    await migrate(fresh, { migrationsFolder: await folderUpTo(13) })
    const [site] = await fresh.execute<{ id: number }>(
      sql`insert into sites (home_url) values ('https://legacy.example') returning id`,
    )
    await fresh.execute(sql`
      insert into feeds (site_id, feed_url, etag, last_modified, last_body_hash, next_fetch_at, status) values
        (${site?.id}, 'https://legacy.example/feed', '"e1"', 'Mon, 01 Sep 2026 00:00:00 GMT', 'abc', now() + interval '1 day', 'active'),
        (${site?.id}, 'https://legacy.example/dead', '"e2"', null, 'def', now() + interval '1 day', 'dead')
    `)

    await migrate(fresh, { migrationsFolder: MIGRATIONS_DIR })

    const rows = await fresh.execute<{
      feed_url: string
      etag: string | null
      last_body_hash: string | null
      served_origin: string | null
      due: boolean
    }>(
      sql`select feed_url, etag, last_body_hash, served_origin, next_fetch_at <= now() as due
          from feeds order by feed_url`,
    )
    expect([...rows]).toEqual([
      {
        feed_url: 'https://legacy.example/dead',
        etag: '"e2"',
        last_body_hash: 'def',
        served_origin: null,
        due: false,
      },
      {
        feed_url: 'https://legacy.example/feed',
        etag: null,
        last_body_hash: null,
        served_origin: null,
        due: true,
      },
    ])
  })
})

describe('0015 translation requests', () => {
  test('retires translations in flight from before attempts existed', async () => {
    const fresh = await freshDatabase('tela_migrations_attempts')
    await migrate(fresh, { migrationsFolder: await folderUpTo(14) })
    const [site] = await fresh.execute<{ id: number }>(
      sql`insert into sites (home_url) values ('https://legacy.example') returning id`,
    )
    const [feed] = await fresh.execute<{ id: number }>(
      sql`insert into feeds (site_id, feed_url) values (${site?.id}, 'https://legacy.example/feed') returning id`,
    )
    const ids = await fresh.execute<{ id: string }>(
      sql`insert into articles (feed_id, dedup_key, title)
          values (${feed?.id}, 'a', 'A'), (${feed?.id}, 'b', 'B'), (${feed?.id}, 'c', 'C') returning id`,
    )
    const [a, b, c] = [...ids].map((r) => r.id)
    // No request rows exist yet: these jobs carry no attempt and could bypass every guard.
    await fresh.execute(sql`
      insert into article_translations (article_id, target_lang, status, html) values
        (${a}, 'zh-Hans', 'requested', null),
        (${b}, 'zh-Hans', 'running', '<p>x</p>'),
        (${c}, 'zh-Hans', 'done', '<p>y</p>')
    `)

    await migrate(fresh, { migrationsFolder: MIGRATIONS_DIR })

    const rows = await fresh.execute<{ status: string; html: string | null }>(
      sql`select status, html from article_translations order by article_id`,
    )
    expect([...rows].map((r) => [r.status, r.html])).toEqual([
      ['failed', null],
      ['failed', null],
      ['done', '<p>y</p>'],
    ])
  })
})
