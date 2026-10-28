/**
 * Migration 0016 (ADR 0067) rebuilds `reports` to widen its target CHECK to `app`, and gives
 * `apps` the columns a member's own app needs, marking every app the operator registered before it
 * as reviewed, by whoever last created or approved it in the console. A rebuild is where a
 * migration loses rows or constraints without a word: drizzle-kit's version failed on D1 (migration
 * 0009), and a rebuild of `apps` would have cascaded into every connection. So this applies the
 * real files to a database holding production's shapes, and checks what each statement promised.
 */
import { expect, test } from 'bun:test'
import { libsqlDb } from '@tela/platform/portable'
import * as schema from './schema'
import { migrationStatements } from './testing'

/** A report of each kind there was before 0016, in each state, with and without the optional parts. */
const REPORTS = [
  [
    1,
    'r1',
    'profile',
    'u-spam',
    'spam',
    'Course ads in the bio.',
    'https://telaread.com/@spam',
    'open',
    100,
    null,
    null,
  ],
  [2, 'r2', 'blogroll', '17', 'abuse', null, null, 'resolved', 200, 250, 'op'],
  [3, null, 'site', '42', 'copyright', 'x'.repeat(1000), null, 'dismissed', 300, 350, null],
  [
    4,
    'r1',
    'recommendation',
    'u-spam:9',
    'other',
    null,
    'https://telaread.com/@spam',
    'open',
    400,
    null,
    null,
  ],
] as const

const COLUMNS =
  'id, reporter_id, target_kind, target_key, reason, details, url, state, created_at, resolved_at, resolved_by'

test('migration 0016 keeps every report and constraint, and carries reviews over from the ledger', async () => {
  const { client } = libsqlDb({ url: ':memory:', schema })
  await client.execute('pragma foreign_keys = on')
  const migrations = migrationStatements()
  const at = migrations.findIndex((m) => m.tag.startsWith('0016_'))
  expect(at).toBeGreaterThan(0)
  for (const m of migrations.slice(0, at)) await client.batch(m.statements)

  const user = (id: string) => ({
    sql: `insert into user (id, name, email, email_verified, created_at, updated_at)
      values (?, ?, ?, 1, 0, 0)`,
    args: [id, id, `${id}@example.com`],
  })
  await client.batch([
    ...['r1', 'r2', 'op', 'op2', 'm1', 'm2', 'dev'].map(user),
    ...REPORTS.map((row) => ({
      sql: `insert into reports (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [...row],
    })),
    // 1: created by one operator and approved by another, the later decision named;
    // 2: a draft only created, reviewed when it was registered;
    // 3: cut off, with nothing in the ledger (the CLI's era), reviewed by nobody named.
    `insert into apps (id, client_id, name, developer, contact_email, redirect_uris, max_scope,
        status, owner_user_id, created_at, updated_at, approved_at, suspended_at) values
      (1, 'tela_app_one', 'Fieldnotes', 'Fieldnotes Labs', 'a@x.test', '["http://127.0.0.1/cb"]',
        'write', 'approved', null, 1000, 1000, 1500, null),
      (2, 'tela_app_two', 'Ledgerline', 'Ledgerline Ltd', 'b@x.test', '["com.example:/cb"]',
        'read', 'draft', 'dev', 2000, 2000, null, null),
      (3, 'tela_app_three', 'Quarry', 'Quarry', 'c@x.test', '["http://[::1]/cb"]',
        'read', 'suspended', null, 3000, 3000, 3100, 3200)`,
    `insert into admin_actions (group_id, actor_id, action, target_kind, target_key, at) values
      ('g1', 'op', 'app.create', 'app', '1', 1000),
      ('g2', 'op2', 'app.approve', 'app', '1', 1500),
      ('g3', 'op2', 'app.edit', 'app', '1', 1600),
      ('g4', 'op', 'app.create', 'app', '2', 2000),
      ('g5', 'op', 'site.hide', 'site', '3', 3000)`,
    `insert into app_grants (id, app_id, user_id, scope, created_at, updated_at, ended_at, end_reason) values
      (1, 1, 'm1', 'write', 1, 1, null, null),
      (2, 1, 'm2', 'read', 1, 1, 5, 'disconnected'),
      (3, 2, 'dev', 'read', 1, 1, null, null),
      (4, 3, 'm1', 'read', 1, 1, null, null)`,
    `insert into app_tokens (id, grant_id, scope, access_hash, access_expires_at, refresh_hash, created_at) values
      (1, 1, 'write', 'a1', 9, 'r1', 1),
      (2, 3, 'read', 'a2', 9, 'r2', 1),
      (3, 4, 'read', 'a3', 9, 'r3', 1)`,
    `insert into app_refresh_spent (hash, token_id, replaced_at) values ('old', 1, 1)`,
    `insert into app_codes (hash, app_id, user_id, scope, created_at, expires_at) values
      ('c1', 1, 'm1', 'write', 1, 9)`,
  ])
  const count = async (table: string) =>
    Number((await client.execute(`select count(*) as n from ${table}`)).rows[0]?.n)
  const before = {
    grants: await count('app_grants'),
    tokens: await count('app_tokens'),
    spent: await count('app_refresh_spent'),
    codes: await count('app_codes'),
  }
  const reportsBefore = (await client.execute(`select ${COLUMNS} from reports order by id`)).rows

  const migration = migrations[at]
  if (!migration) throw new Error('no 0016')
  await client.batch(migration.statements)

  // Every report, every column, as it was.
  const reportsAfter = (await client.execute(`select ${COLUMNS} from reports order by id`)).rows
  expect(reportsAfter.map((r) => ({ ...r }))).toEqual(reportsBefore.map((r) => ({ ...r })))
  expect(reportsAfter).toHaveLength(REPORTS.length)

  // The rebuilt table names its own columns, never the temporary table it was built as.
  const ddl = String(
    (
      await client.execute(
        `select sql from sqlite_master where type = 'table' and name = 'reports'`,
      )
    ).rows[0]?.sql,
  )
  expect(ddl).not.toContain('__new_')

  // All four CHECKs still refuse, and the target widened to `app` and nothing else.
  const insert = (over: Record<string, unknown>) => {
    const row = {
      reporter_id: 'r1',
      target_kind: 'app',
      target_key: 'tela_app_one',
      reason: 'spam',
      details: null,
      state: 'open',
      created_at: 500,
      ...over,
    }
    const names = Object.keys(row)
    return client.execute({
      sql: `insert into reports (${names.join(', ')}) values (${names.map(() => '?').join(', ')})`,
      args: Object.values(row) as (string | number | null)[],
    })
  }
  await expect(insert({ target_kind: 'blog' })).rejects.toThrow(/reports_target_kind_check/)
  await expect(insert({ reason: 'boring' })).rejects.toThrow(/reports_reason_check/)
  await expect(insert({ state: 'pending' })).rejects.toThrow(/reports_state_check/)
  await expect(insert({ details: 'x'.repeat(1001) })).rejects.toThrow(/reports_details_check/)
  await insert({})
  await insert({ details: 'y'.repeat(1000), target_kind: 'profile', target_key: 'u-spam' })
  expect(await count('reports')).toBe(REPORTS.length + 2)
  // The reporter's foreign key survived the rebuild too.
  await expect(insert({ reporter_id: 'nobody' })).rejects.toThrow(/FOREIGN KEY/)

  // The three indexes the rebuild dropped with the old table, made again, and the apps' new one.
  const indexes = (
    await client.execute(
      `select name, tbl_name from sqlite_master where type = 'index' and name not like 'sqlite_%'
        and tbl_name in ('reports', 'apps') order by name`,
    )
  ).rows.map((r) => `${r.tbl_name}.${r.name}`)
  expect(indexes).toEqual(
    expect.arrayContaining([
      'reports.reports_reporter_idx',
      'reports.reports_state_created_idx',
      'reports.reports_target_idx',
      'apps.apps_developer_idx',
    ]),
  )
  expect(indexes.filter((name) => name.startsWith('reports.'))).toHaveLength(3)

  // Every app the operator registered is reviewed, by the last to create or approve it.
  const apps = (
    await client.execute(
      `select id, status, developer_id, reviewed_at, reviewed_by, review_requested_at, review_note,
        review_wants_email, terms_at from apps order by id`,
    )
  ).rows.map((r): Record<string, unknown> => ({ ...r }))
  const fresh = { developer_id: null, review_requested_at: null, review_note: null, terms_at: null }
  expect(apps).toEqual([
    {
      id: 1,
      status: 'approved',
      reviewed_at: 1500,
      reviewed_by: 'op2',
      review_wants_email: 0,
      ...fresh,
    },
    {
      id: 2,
      status: 'draft',
      reviewed_at: 2000,
      reviewed_by: 'op',
      review_wants_email: 0,
      ...fresh,
    },
    {
      id: 3,
      status: 'suspended',
      reviewed_at: 3100,
      reviewed_by: null,
      review_wants_email: 0,
      ...fresh,
    },
  ])

  // Nothing under an app went with it: `apps` gained columns and was never rebuilt.
  expect({
    grants: await count('app_grants'),
    tokens: await count('app_tokens'),
    spent: await count('app_refresh_spent'),
    codes: await count('app_codes'),
  }).toEqual(before)
  expect(await count('apps')).toBe(3)
  // And the foreign keys the deferral covered all hold.
  expect((await client.execute('pragma foreign_key_check')).rows).toEqual([])
})
