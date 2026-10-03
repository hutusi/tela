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
  claimInvite,
  createMemberCode,
  currentSeq,
  exportDatabase,
  holdJoin,
  latestBackup,
  pruneBackups,
  readManifest,
  restoreDatabase,
  settleInvite,
  type TelaDb,
  verifyExport,
} from '@tela/data'
import { createTestDb, seedBlockTranslations, writingMeanwhile } from '@tela/data/testing'
import { memoryBlobs } from '@tela/platform/portable'
import type { PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { createTestApi, signedIn } from './helpers'

/**
 * A member with a feed, posts, a like, a highlight and invite codes, all written the way the app
 * writes them.
 */
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
  const reader = await signedIn(api, 'reader@x.test')
  const push = await api.request('/api/v1/mutations', {
    as: reader,
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
  // The reader's invitations (ADR 0034): one a friend joined with, one held, one unused.
  for (const code of ['AAAABBBBCCCC', 'DDDDEEEEFFFF', 'GGGGHHHHJJJJ']) {
    expect(await createMemberCode(db, { userId: reader.userId, code, now })).toMatchObject({
      ok: true,
    })
  }
  expect(await holdJoin(db, { code: 'AAAABBBBCCCC', email: 'friend@x.test', now })).toBe('held')
  expect(await holdJoin(db, { code: 'DDDDEEEEFFFF', email: 'later@x.test', now })).toBe('held')
  expect(await claimInvite(db, { email: 'friend@x.test', now })).toMatchObject({
    code: 'AAAABBBBCCCC',
  })
  await db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
    values ('friend', '', 'friend@x.test', 1, ${now}, ${now})`)
  expect(await settleInvite(db, { email: 'friend@x.test', userId: 'friend', now })).toHaveLength(1)
  return api
}

const everything = async (db: TelaDb, table: string) =>
  db.all<Record<string, unknown>>(sql`select * from ${sql.identifier(table)} order by 1, 2`)

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

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
    expect(at('user')).toBeLessThan(at('follows'))
    expect(at('user')).toBeLessThan(at('invite_codes'))
    expect(at('invite_codes')).toBeLessThan(at('invite_redemptions'))
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

  test('a row read twice fails the check, even when the manifest counted it twice', async () => {
    const api = await seeded()
    const blobs = memoryBlobs()
    const manifest = await exportDatabase(api.db, blobs, { date: '2026-09-28', now: () => 0 })
    const articles = manifest.tables.find((t) => t.name === 'articles')!
    const part = articles.parts[0]!
    const lines = (await (await blobs.get(part.key))!.text()).split('\n').filter((l) => l !== '')
    const text = `${[...lines, lines.at(-1)].join('\n')}\n`
    await blobs.put(part.key, text)
    part.rows += 1
    part.sha256 = await sha256(text)
    articles.rows += 1
    await blobs.put('backup/2026-09-28/manifest.json', JSON.stringify(manifest))

    const checked = await verifyExport(blobs, '2026-09-28')
    expect(checked.ok).toBe(false)
    expect(checked.problems).toEqual([`${part.key} line 8 is out of key order: [7]`])
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
    const reader = await signedIn(again, 'reader@x.test')
    const pull = (await (
      await again.request('/api/v1/sync?cursor=0', { as: reader })
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

  test('restores an export taken while translations were added and removed', async () => {
    const api = await seeded()
    await seedBlockTranslations(api.db, 1200)
    const blobs = memoryBlobs()
    const meanwhile = writingMeanwhile(api.db, { added: 2, removed: 1 })
    const latest = await backUp(meanwhile.db, blobs, { date: '2026-09-28', now: () => 0 })
    expect(latest).toMatchObject({ verified: true, problems: [] })

    const { db: fresh } = await createTestDb()
    await restoreDatabase(fresh, blobs, '2026-09-28')
    const manifest = await readManifest(blobs, '2026-09-28')
    for (const table of manifest?.tables ?? []) {
      const count = await fresh.all<{ n: number }>(
        sql`select count(*) as n from ${sql.identifier(table.name)}`,
      )
      expect(count[0]?.n, table.name).toBe(table.rows)
    }
  })

  test('restores only into an empty database', async () => {
    const api = await seeded()
    const blobs = memoryBlobs()
    await backUp(api.db, blobs, { date: '2026-09-28', now: () => api.clock.now() })
    const { db: fresh } = await createTestDb()
    await restoreDatabase(fresh, blobs, '2026-09-28')
    await expect(restoreDatabase(fresh, blobs, '2026-09-28')).rejects.toThrow(
      'restore needs an empty database',
    )
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
