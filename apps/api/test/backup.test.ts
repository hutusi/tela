/**
 * The nightly export and the exit path it exists for (ADR 0027): a database written through the
 * real API is exported, verified, restored into a fresh libSQL database, and served again. A
 * member who signs in on the restored stack finds what they had.
 */
import { describe, expect, test } from 'bun:test'
import {
  backUp,
  backupTables,
  bumpSeq,
  currentSeq,
  exportDatabase,
  latestBackup,
  pruneBackups,
  restoreDatabase,
  type TelaDb,
  verifyExport,
} from '@tela/data'
import { createTestDb } from '@tela/data/testing'
import { memoryBlobs } from '@tela/platform/portable'
import { CLIENT_HEADER, MIN_CLIENT, type PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { createTestApi, signedIn } from './helpers'

const client = { [CLIENT_HEADER]: String(MIN_CLIENT) }

/** A member with a feed, posts, a like and a highlight, all written the way the app writes them. */
async function seeded() {
  const api = await createTestApi()
  const { db } = api
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, title, created_at, updated_at, seq)
      values (1, 'https://garden.example', 'Garden Notes', 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (1, 1, 'https://garden.example/feed', 'garden.example', 0, 0, 0, ${currentSeq})`),
  ] as never)
  const now = api.clock.now()
  for (let id = 1; id <= 7; id++) {
    await db.batch([
      bumpSeq(db),
      db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, content_key, seq)
        values (${id}, 1, ${`k${id}`}, ${`Post ${id}`}, ${now}, ${now}, ${'a'.repeat(32)}, ${currentSeq})`),
    ] as never)
  }
  const { cookie } = await signedIn(api, 'reader@x.test')
  const push = await api.request('/api/v1/mutations', {
    cookie,
    headers: client,
    body: {
      mutations: [
        { mid: 'backup-sub-001', at: now, type: 'subscribe', feedId: 1 },
        { mid: 'backup-like-01', at: now, type: 'setLiked', articleId: 3, liked: true },
        {
          mid: 'backup-hl-001',
          at: now,
          type: 'putHighlight',
          id: 'backup-highlight-1',
          articleId: 5,
          contentKey: 'a'.repeat(32),
          side: 'original',
          lang: null,
          leafId: 'leaf000001',
          start: 0,
          end: 4,
          quote: 'Post',
          prefix: '',
          suffix: ' 5 is "quoted", with\nlines',
          note: 'kept through a restore',
        },
      ],
    },
  })
  expect(push.status).toBe(200)
  return api
}

const everything = async (db: TelaDb, table: string) =>
  db.all<Record<string, unknown>>(sql`select * from ${sql.identifier(table)} order by 1, 2`)

describe('the nightly export', () => {
  test('holds every table worth keeping, parents before children, and no credentials', () => {
    const names = backupTables().map((t) => t.name)
    for (const skipped of ['session', 'verification', 'leases', 'rate_limit']) {
      expect(names).not.toContain(skipped)
    }
    const at = (name: string) => names.indexOf(name)
    expect(at('user')).toBeLessThan(at('profiles'))
    expect(at('sites')).toBeLessThan(at('feeds'))
    expect(at('feeds')).toBeLessThan(at('articles'))
    expect(at('articles')).toBeLessThan(at('highlights'))
    expect(names).toContain('counters')
  })

  test('is verified against its own manifest, and a damaged part is caught', async () => {
    const api = await seeded()
    const blobs = memoryBlobs()
    const latest = await backUp(api.db, blobs, { date: '2026-09-28', now: () => api.clock.now() })
    expect(latest).toMatchObject({ date: '2026-09-28', verified: true, problems: [] })
    expect(await latestBackup(blobs)).toEqual(latest)

    const manifest = await exportDatabase(api.db, blobs, { date: '2026-09-29', now: () => 0 })
    const articles = manifest.tables.find((t) => t.name === 'articles')
    expect(articles?.rows).toBe(7)
    const part = articles?.parts[0]?.key ?? ''
    await blobs.put(
      part,
      `${(await (await blobs.get(part))?.text())?.split('\n').slice(1).join('\n')}`,
    )
    const damaged = await verifyExport(blobs, '2026-09-29')
    expect(damaged.ok).toBe(false)
    expect(damaged.problems.join(' ')).toContain('articles')
  })

  test('restores into a fresh database, which serves the member what they had', async () => {
    const api = await seeded()
    const blobs = memoryBlobs()
    await backUp(api.db, blobs, { date: '2026-09-28', now: () => api.clock.now() })

    const { db: fresh } = await createTestDb()
    const restored = await restoreDatabase(fresh, blobs, '2026-09-28')
    expect(restored.rows).toBeGreaterThan(10)
    for (const { name } of backupTables()) {
      expect(await everything(fresh, name), name).toEqual(await everything(api.db, name))
    }

    // The exit path: the same app on the restored data. Sessions were not kept, so sign in again.
    const again = await createTestApi({}, { db: fresh })
    const { cookie } = await signedIn(again, 'reader@x.test')
    const pull = (await (
      await again.request('/api/v1/sync?cursor=0', { cookie, headers: client })
    ).json()) as PullResponse
    expect(pull.rows.subscriptions.map((s) => s.feedId)).toEqual([1])
    expect(pull.rows.articles).toHaveLength(7)
    expect(pull.rows.states).toMatchObject([{ articleId: 3 }])
    expect(pull.rows.highlights).toMatchObject([
      {
        id: 'backup-highlight-1',
        note: 'kept through a restore',
        suffix: ' 5 is "quoted", with\nlines',
      },
    ])
    // The sequence came back too, so a device's cursor still means what it meant.
    const seq = await fresh.all<{ v: number }>(sql`select v from counters where k = 'seq'`)
    expect(pull.cursor).toBeGreaterThanOrEqual(Number(seq[0]?.v ?? 0) - 1)
  })

  test('old exports are pruned, the recent ones kept', async () => {
    const blobs = memoryBlobs()
    for (const date of ['2026-08-01', '2026-08-29', '2026-09-27']) {
      await blobs.put(`backup/${date}/manifest.json`, '{}')
      await blobs.put(`backup/${date}/articles.0.jsonl`, '')
    }
    await blobs.put('backup/latest.json', '{}')
    expect(await pruneBackups(blobs, '2026-09-28', 30)).toBe(2)
    const left = await blobs.list({ prefix: 'backup/' })
    expect(left.keys.sort()).toEqual([
      'backup/2026-08-29/articles.0.jsonl',
      'backup/2026-08-29/manifest.json',
      'backup/2026-09-27/articles.0.jsonl',
      'backup/2026-09-27/manifest.json',
      'backup/latest.json',
    ])
  })
})
