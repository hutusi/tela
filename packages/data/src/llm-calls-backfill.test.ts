/**
 * Migration 0006 gives the call log a blog (ADR 0039) and fills it in for the calls already
 * logged: a body through its content key, a title only where the call named its one post. A title
 * call that carried several posts names none, and stays unattributed.
 */
import { expect, test } from 'bun:test'
import { libsqlDb } from '@tela/platform/portable'
import * as schema from './schema'
import { migrationStatements } from './testing'

test('migration 0006 attributes the calls it can to their feed, and no others', async () => {
  const { client } = libsqlDb({ url: ':memory:', schema })
  await client.execute('pragma foreign_keys = on')
  const migrations = migrationStatements()
  const at = migrations.findIndex((m) => m.tag.startsWith('0006_'))
  expect(at).toBeGreaterThan(0)
  for (const m of migrations.slice(0, at)) await client.batch(m.statements)

  await client.batch([
    `insert into sites (id, home_url, created_at, updated_at) values (1, 'https://a.example', 0, 0)`,
    `insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at)
      values (1, 1, 'https://a.example/feed', 'a.example', 0, 0, 0),
        (2, 1, 'https://a.example/other', 'a.example', 0, 0, 0)`,
    // Two posts share a body; the first article with it answers for the body's calls.
    `insert into articles (id, feed_id, dedup_key, fetched_at, sort_at, content_key)
      values (1, 2, 'a', 0, 0, 'ck'), (2, 1, 'b', 0, 0, 'ck'), (3, 1, 'c', 0, 0, 'other')`,
    `insert into llm_calls (id, job, content_key, article_id, model, input_tokens, output_tokens,
        latency_ms, created_at)
      values (1, 'translate.body', 'ck', null, 'm', 1, 1, 1, 0),
        (2, 'translate.title', null, 3, 'm', 1, 1, 1, 0),
        (3, 'translate.title', null, null, 'm', 1, 1, 1, 0),
        (4, 'translate.body', 'gone', null, 'm', 1, 1, 1, 0)`,
  ])
  const migration = migrations[at]
  if (!migration) throw new Error('no 0006')
  await client.batch(migration.statements)
  const rows = await client.execute('select id, feed_id from llm_calls order by id')
  expect(
    rows.rows.map((r) => [Number(r.id), r.feed_id === null ? null : Number(r.feed_id)]),
  ).toEqual([
    [1, 2],
    [2, 1],
    [3, null],
    [4, null],
  ])
})
