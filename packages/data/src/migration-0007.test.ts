/**
 * Migration 0007 links the two languages of every member who chose the same one twice (ADR 0040):
 * a reading language equal to the interface's becomes null, which follows the interface. One that
 * differs was chosen apart and stays, and so does one beside an interface the server never heard
 * of, since that member's interface is only a cookie. The rows it changes carry the new seq, so
 * every device pulls them; the rest keep theirs.
 */
import { expect, test } from 'bun:test'
import { libsqlDb } from '@tela/platform/portable'
import * as schema from './schema'
import { migrationStatements } from './testing'

test('migration 0007 links a reading language equal to the interface, and only that', async () => {
  const { client } = libsqlDb({ url: ':memory:', schema })
  await client.execute('pragma foreign_keys = on')
  const migrations = migrationStatements()
  const at = migrations.findIndex((m) => m.tag.startsWith('0007_'))
  expect(at).toBeGreaterThan(0)
  for (const m of migrations.slice(0, at)) await client.batch(m.statements)

  const members = [
    ['same', 'zh-Hans', 'zh-Hans'],
    ['apart', 'en', 'zh-Hans'],
    ['cookie', null, 'fr'],
    ['unset', null, null],
  ] as const
  await client.batch([
    `insert into counters (k, v) values ('seq', 40)`,
    ...members.flatMap(([id, ui, reading]) => [
      {
        sql: `insert into user (id, name, email, email_verified, created_at, updated_at)
          values (?, ?, ?, 1, 0, 0)`,
        args: [id, id, `${id}@example.com`],
      },
      {
        sql: `insert into profiles (user_id, handle, ui_locale, reading_lang, created_at, updated_at, seq)
          values (?, ?, ?, ?, 0, 0, 7)`,
        args: [id, `m_${id}`, ui, reading],
      },
    ]),
  ])
  const migration = migrations[at]
  if (!migration) throw new Error('no 0007')
  await client.batch(migration.statements)

  const rows = await client.execute(
    'select user_id, ui_locale, reading_lang, reading_lang_at, ui_locale_at, seq from profiles order by user_id',
  )
  expect(
    rows.rows.map((r) => ({
      id: r.user_id,
      ui: r.ui_locale,
      reading: r.reading_lang,
      clocks: [Number(r.ui_locale_at), Number(r.reading_lang_at)],
      seq: Number(r.seq),
    })),
  ).toEqual([
    { id: 'apart', ui: 'en', reading: 'zh-Hans', clocks: [0, 0], seq: 7 },
    { id: 'cookie', ui: null, reading: 'fr', clocks: [0, 0], seq: 7 },
    { id: 'same', ui: 'zh-Hans', reading: null, clocks: [0, 0], seq: 41 },
    { id: 'unset', ui: null, reading: null, clocks: [0, 0], seq: 7 },
  ])
  const counter = await client.execute(`select v from counters where k = 'seq'`)
  expect(Number(counter.rows[0]?.v)).toBe(41)
})

test('migration 0007 leaves a database with nothing to link without a seq', async () => {
  // A fresh database's first batch takes seq 1; a bump here would start every count at 2.
  const { client } = libsqlDb({ url: ':memory:', schema })
  for (const m of migrationStatements()) await client.batch(m.statements)
  const counter = await client.execute(`select count(*) as n from counters`)
  expect(Number(counter.rows[0]?.n)).toBe(0)
})
