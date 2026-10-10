/**
 * Migration 0010 adds `site_claims.overruled_at` and carries over the operator's no from before
 * it (ADR 0045): a claim rejected or removed then, and not undone, verifies again only by the tag
 * or `rel="me"`. Without it a removal made before the deploy stayed bypassable by the very link it
 * ruled on (Codex's review). A dismissal decides nothing, and an undone removal is no removal.
 */
import { expect, test } from 'bun:test'
import { libsqlDb } from '@tela/platform/portable'
import * as schema from './schema'
import { migrationStatements } from './testing'

test('migration 0010 carries over each rejection or removal still in force', async () => {
  const { client } = libsqlDb({ url: ':memory:', schema })
  await client.execute('pragma foreign_keys = on')
  const migrations = migrationStatements()
  const at = migrations.findIndex((m) => m.tag.startsWith('0010_'))
  expect(at).toBeGreaterThan(0)
  for (const m of migrations.slice(0, at)) await client.batch(m.statements)

  const claims = ['rejected', 'removed', 'undone', 'both', 'dismissed', 'untouched']
  await client.batch([
    `insert into user (id, name, email, email_verified, created_at, updated_at)
      values ('u', 'u', 'u@example.com', 1, 0, 0)`,
    ...claims.map((_, i) => ({
      sql: `insert into sites (id, home_url, listing, created_at, updated_at, seq)
        values (?, ?, 'listed', 0, 0, 1)`,
      args: [i + 1, `https://${i + 1}.test`],
    })),
    ...claims.map((_, i) => ({
      sql: `insert into site_claims (id, site_id, user_id, method, token, status, created_at, seq)
        values (?, ?, 'u', 'link', 't', 'failed', 0, 1)`,
      args: [i + 1, i + 1],
    })),
    `insert into admin_actions (group_id, action, target_kind, target_key, at) values
      ('g1', 'claim.reject', 'claim', '1', 100),
      ('g2', 'claim.remove', 'claim', '2', 200),
      ('g3', 'claim.remove', 'claim', '3', 300),
      ('g5', 'claim.remove', 'claim', '4', 400),
      ('g6', 'claim.reject', 'claim', '4', 450),
      ('g7', 'claim.dismiss', 'claim', '5', 500),
      ('g8', 'site.list', 'site', '6', 600)`,
    `insert into admin_actions (group_id, action, target_kind, target_key, detail, at) values
      ('g4', 'undo', 'claim', '3', '{"group":"g3","undid":"claim.remove"}', 350)`,
  ])
  const migration = migrations[at]
  if (!migration) throw new Error('no 0010')
  await client.batch(migration.statements)

  const rows = await client.execute('select id, overruled_at from site_claims order by id')
  expect(rows.rows.map((r) => (r.overruled_at === null ? null : Number(r.overruled_at)))).toEqual([
    100, // rejected
    200, // removed
    null, // removed, then the removal undone
    450, // removed, then rejected: the latest no
    null, // dismissed from the queue: no decision
    null, // nothing on the claim
  ])
})
