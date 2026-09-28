/**
 * The behaviour Tela relies on from its database, written once and run twice: under `bun test`
 * on libSQL (the portable path) and under the Workers test pool on real D1. A difference between
 * the two is a bug in the portable adapter, which is exactly what this suite exists to catch.
 */
import { sql } from 'drizzle-orm'
import type { TelaDb } from './db'
import { first } from './first'
import {
  claimDue,
  deadLetter,
  extendLease,
  failLease,
  fence,
  isFenceRefusal,
  type Lease,
  release,
  startLease,
} from './leases'
import {
  existingArticles,
  fillSiteMetadata,
  insertArticles,
  insertVersions,
  updateArticles,
} from './queries/ingest'
import { readPull } from './queries/sync'
import { feeds, sites } from './schema'
import { bumpSeq, currentSeq, headSeq } from './seq'

type Matchers = {
  toEqual(expected: unknown): void
  toBe(expected: unknown): void
  toHaveLength(length: number): void
  not: { toBe(expected: unknown): void }
}

export type TestApi = {
  describe(name: string, fn: () => void): void
  it(name: string, fn: () => Promise<void>): void
  expect(actual: unknown): Matchers
}

const T0 = Date.UTC(2026, 8, 27, 12)
const MIN = 60_000

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
    return null
  } catch (err) {
    return err
  }
}

/** One site with `n` due feeds; feeds 1 and 2 share a host so politeness has something to do. */
async function seedFeeds(db: TelaDb, hosts: string[]) {
  await db.insert(sites).values({ homeUrl: 'https://example.com', createdAt: T0, updatedAt: T0 })
  await db.insert(feeds).values(
    hosts.map((host, i) => ({
      siteId: 1,
      feedUrl: `https://${host}/feed-${i + 1}.xml`,
      host,
      nextFetchAt: T0 - (hosts.length - i) * MIN,
      createdAt: T0,
      updatedAt: T0,
    })),
  )
}

const dueFeeds = (now: number) =>
  sql`select id as key, host, next_fetch_at as ord from feeds where status = 'active' and next_fetch_at <= ${now}`

const lease = (key: string, owner: string): Lease => ({ kind: 'feed.fetch', key, owner })

export function dataContract(t: TestApi, makeDb: () => Promise<TelaDb>): void {
  const { describe, it, expect } = t

  describe('the schema', () => {
    it('enforces foreign keys, as D1 does', async () => {
      const db = await makeDb()
      const err = await caught(() =>
        db.run(
          sql`insert into articles (feed_id, dedup_key, fetched_at, sort_at) values (99, 'x', 1, 1)`,
        ),
      )
      expect(err === null).toBe(false)
    })

    it('enforces CHECK constraints on value lists and handles', async () => {
      const db = await makeDb()
      const badListing = await caught(() =>
        db.run(
          sql`insert into sites (home_url, listing, created_at, updated_at) values ('https://a.b', 'public', 1, 1)`,
        ),
      )
      expect(badListing === null).toBe(false)
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 0, 0, 0)`,
      )
      const badHandle = await caught(() =>
        db.run(
          sql`insert into profiles (user_id, handle, created_at, updated_at) values ('u1', 'Bad-Handle', 1, 1)`,
        ),
      )
      expect(badHandle === null).toBe(false)
      await db.run(
        sql`insert into profiles (user_id, handle, created_at, updated_at) values ('u1', 'good_handle_1', 1, 1)`,
      )
    })
  })

  describe("D1's statement limits", () => {
    // libSQL allows 500 terms; the portable guard holds it to D1's 5, and this runs on both.
    const chain = (n: number) =>
      sql.raw(Array.from({ length: n }, (_, i) => `select ${i} as k`).join(' union all '))

    it('refuses a compound SELECT over five terms, and takes many rows through VALUES', async () => {
      const db = await makeDb()
      expect(await db.all(chain(5))).toHaveLength(5)
      expect((await caught(() => db.all(chain(6)))) === null).toBe(false)
      const rows = sql.raw(Array.from({ length: 50 }, (_, i) => `(${i})`).join(', '))
      expect(await db.all(sql`select * from (values ${rows})`)).toHaveLength(50)
    })
  })

  describe('the sync sequence', () => {
    it('stamps every row a batch writes with one seq, and moves forward per batch', async () => {
      const db = await makeDb()
      await db.batch([
        bumpSeq(db),
        db
          .insert(sites)
          .values({ homeUrl: 'https://a.example', createdAt: T0, updatedAt: T0, seq: currentSeq }),
        db
          .insert(sites)
          .values({ homeUrl: 'https://b.example', createdAt: T0, updatedAt: T0, seq: currentSeq }),
      ])
      await db.batch([
        bumpSeq(db),
        db
          .insert(sites)
          .values({ homeUrl: 'https://c.example', createdAt: T0, updatedAt: T0, seq: currentSeq }),
      ])
      const rows = await db.all<{ home_url: string; seq: number }>(
        sql`select home_url, seq from sites order by id`,
      )
      expect(rows.map((r) => r.seq)).toEqual([1, 1, 2])
      expect(await headSeq(db)).toBe(2)
    })

    it('does not advance when the batch fails', async () => {
      const db = await makeDb()
      await db.batch([bumpSeq(db)])
      const err = await caught(() =>
        db.batch([
          bumpSeq(db),
          db.run(sql`insert into sites (home_url, created_at, updated_at) values (null, 1, 1)`),
        ]),
      )
      expect(err === null).toBe(false)
      expect(await headSeq(db)).toBe(1)
    })
  })

  describe('sync pull pages', () => {
    const member = 'm1'
    async function setup(db: TelaDb) {
      await seedFeeds(db, ['h1'])
      await db.batch([
        bumpSeq(db),
        db.run(
          sql`insert into user (id, name, email, email_verified, created_at, updated_at) values (${member}, 'm', 'm@x.y', 1, 0, 0)`,
        ),
        db.run(
          sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, seq) values (${member}, 1, 0, 0, ${currentSeq})`,
        ),
      ])
      return headSeq(db)
    }
    let n = 0
    /** One batch writing `count` articles, so they share one seq. */
    async function articlesInOneBatch(db: TelaDb, count: number) {
      const rows = Array.from({ length: count }, () => ++n)
      await db.batch([
        bumpSeq(db),
        db.run(sql`
          insert into articles (id, feed_id, dedup_key, fetched_at, sort_at, seq)
          select value, 1, 'k' || value, ${T0}, ${T0}, ${currentSeq}
          from json_each(${JSON.stringify(rows)}) where true
        `),
      ])
    }
    const page = (db: TelaDb, cursor: number, limit: number) =>
      readPull(db, { userId: member, cursor, horizon: T0 - 1, limit })
    const ids = (read: Awaited<ReturnType<typeof page>>) =>
      read.rows.articles.map((a) => Number(a.id)).sort((x, y) => x - y)

    it('pages a delta in seq order, each page ending where the next begins', async () => {
      const db = await makeDb()
      n = 0
      const start = await setup(db)
      for (let i = 0; i < 5; i++) await articlesInOneBatch(db, 1)
      const first1 = await page(db, start, 2)
      expect(ids(first1)).toEqual([1, 2])
      expect(first1.pageEnd === null).toBe(false)
      const second = await page(db, first1.pageEnd as number, 2)
      expect(ids(second)).toEqual([3, 4])
      const last = await page(db, second.pageEnd as number, 2)
      expect(ids(last)).toEqual([5])
      expect(last.pageEnd).toBe(null)
    })

    it('never splits the rows one batch wrote across pages', async () => {
      const db = await makeDb()
      n = 0
      const start = await setup(db)
      await articlesInOneBatch(db, 2)
      await articlesInOneBatch(db, 2)
      const first1 = await page(db, start, 3)
      expect(ids(first1)).toEqual([1, 2])
      expect(ids(await page(db, first1.pageEnd as number, 3))).toEqual([3, 4])
    })

    it('sends a batch larger than a page whole rather than stalling', async () => {
      const db = await makeDb()
      n = 0
      const start = await setup(db)
      await articlesInOneBatch(db, 3)
      const read = await page(db, start, 2)
      expect(ids(read)).toEqual([1, 2, 3])
      expect(read.pageEnd).toBe(null)
    })
  })

  describe('ingest statements', () => {
    it('insert, version, update-from and read back through json_each, in one batch', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      const article = (n: number) => ({
        dedupKey: `g:${n}`,
        url: `https://h1/p/${n}`,
        urlHost: 'h1',
        title: `Post ${n}`,
        author: null,
        publishedAt: T0 - n * MIN,
        sourceLang: 'en',
        excerpt: `Excerpt ${n}`,
        contentKey: `key-${n}`,
        wordCount: 100,
        readingMinutes: 1,
        extractState: 'none' as const,
        titleHash: `th-${n}`,
      })
      const version = (n: number, v: number) => ({
        dedupKey: `g:${n}`,
        version: v,
        provenance: 'feed' as const,
        contentKey: `key-${n}-v${v}`,
        rawKey: null,
        bodyChars: 500 + v,
        excerpt: `Excerpt ${n} v${v}`,
        wordCount: 100,
        readingMinutes: 1,
        lang: 'en',
        sourceUrl: null,
      })
      const results = await db.batch([
        bumpSeq(db),
        insertArticles(db, 1, [article(1), article(2)], T0),
        insertVersions(db, 1, [version(1, 1), version(2, 1)], T0),
        fillSiteMetadata(db, 1, { title: 'Blog', description: null, declaredLang: 'en' }, T0),
      ])
      const inserted = results[1] as unknown as { id: number; dedup_key: string }[]
      expect(inserted.map((r) => r.dedup_key).sort()).toEqual(['g:1', 'g:2'])
      await db.batch([
        bumpSeq(db),
        insertVersions(db, 1, [version(1, 2)], T0),
        updateArticles(db, [
          {
            id: inserted.find((r) => r.dedup_key === 'g:1')?.id ?? 0,
            url: 'https://h1/p/1',
            urlHost: 'h1',
            title: 'Post 1, edited',
            author: null,
            publishedAt: null,
            sourceLang: 'en',
            excerpt: 'Excerpt 1 v2',
            currentVersion: 2,
            contentKey: 'key-1-v2',
            wordCount: 120,
            readingMinutes: 1,
            extractState: 'none',
            titleHash: 'th-1b',
          },
        ]),
      ])
      const existing = await existingArticles(db, 1, ['g:1', 'g:2', 'g:3'])
      expect([...existing.keys()].sort()).toEqual(['g:1', 'g:2'])
      const one = existing.get('g:1')
      expect(one?.currentVersion).toBe(2)
      expect(one?.contentKey).toBe('key-1-v2')
      expect(one?.versions.map((v) => v.version).sort()).toEqual([1, 2])
      const row = await first<{ title: string; sort_at: number; seq: number }>(
        db,
        sql`select title, sort_at, seq from articles where dedup_key = 'g:1'`,
      )
      // sort_at falls back to fetched_at once the edit drops the date.
      expect(row).toEqual({ title: 'Post 1, edited', sort_at: T0, seq: 2 })
      const site = await first<{ title: string; primary_lang: string }>(
        db,
        sql`select title, primary_lang from sites where id = 1`,
      )
      expect(site).toEqual({ title: 'Blog', primary_lang: 'en' })
    })
  })

  describe('leases', () => {
    it('claims due items in order, one per host, up to the limit', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['same.host', 'same.host', 'other.host', 'third.host'])
      const got = await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 2,
        due: dueFeeds(T0),
      })
      expect(got.map((c) => c.key)).toEqual(['1', '3'])
      const more = await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0,
        ttlMs: MIN,
        limit: 10,
        due: dueFeeds(T0),
      })
      // Feed 2 waits: its host is busy with feed 1. Feeds 1 and 3 are held by `a`.
      expect(more.map((c) => c.key)).toEqual(['4'])
    })

    it('lets another owner take an expired lease, and only then', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      const early = await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0 + MIN - 1,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      expect(early).toHaveLength(0)
      const late = await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0 + MIN + 1,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      expect(late).toEqual([{ key: '1', host: 'h1', owner: 'b', attempts: 0 }])
    })

    it('keeps a host busy across kinds, so extraction waits behind a fetch of the same site', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      const extract = await claimDue(db, {
        kind: 'article.extract',
        owner: 'b',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: sql`select 'article-7' as key, 'h1' as host, 0 as ord`,
      })
      expect(extract).toHaveLength(0)
    })

    it('keys a claim the same whether the due query yields an integer or a bound number', async () => {
      const db = await makeDb()
      const got = await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: sql`select ${7} as key, null as host, 0 as ord`,
      })
      expect(got.map((c) => c.key)).toEqual(['7'])
      expect(await extendLease(db, lease('7', 'a'), T0 + 1, MIN)).toBe(true)
    })

    it('extends only for its owner, and only while the lease is live', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      expect(await extendLease(db, lease('1', 'a'), T0 + 10, MIN)).toBe(true)
      expect(await extendLease(db, lease('1', 'b'), T0 + 10, MIN)).toBe(false)
      expect(await extendLease(db, lease('1', 'a'), T0 + 10 + MIN + 1, MIN)).toBe(false)
    })

    it('commits a fenced batch while the lease is held', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      await db.batch([
        fence(db, lease('1', 'a'), T0 + 5),
        db.run(sql`update feeds set title = 'fetched by a' where id = 1`),
        release(db, lease('1', 'a')),
      ])
      const row = await first<{ title: string }>(db, sql`select title from feeds where id = 1`)
      expect(row?.title).toBe('fetched by a')
      expect(await db.all(sql`select * from leases`)).toHaveLength(0)
    })

    it('aborts the whole fenced batch once the lease is lost, so a stale holder writes nothing', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      // `a` stalls past its lease; `b` takes the feed over.
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0 + 2 * MIN,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      const err = await caught(() =>
        db.batch([
          fence(db, lease('1', 'a'), T0 + 2 * MIN + 1),
          db.run(sql`update feeds set title = 'stale write' where id = 1`),
          release(db, lease('1', 'a')),
        ]),
      )
      expect(isFenceRefusal(err)).toBe(true)
      const row = await first<{ title: string | null }>(
        db,
        sql`select title from feeds where id = 1`,
      )
      expect(row?.title ?? null).toBe(null)
      const held = await db.all<{ owner: string }>(sql`select owner from leases`)
      expect(held.map((h) => h.owner)).toEqual(['b'])
    })

    it('backs off after a failure, keeps the attempt count, and reports exhaustion', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      const backoff = { baseMs: MIN, maxMs: 60 * MIN, maxAttempts: 2 }
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      expect(await startLease(db, lease('1', 'a'), T0, MIN)).toEqual({ attempts: 1, host: 'h1' })
      expect(await failLease(db, lease('1', 'a'), T0 + 1, backoff, 'HTTP 503')).toEqual({
        attempts: 1,
        exhausted: false,
      })
      const tooSoon = await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0 + MIN - 1,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      expect(tooSoon).toHaveLength(0)
      const retry = await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0 + MIN + 2,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      expect(retry.map((c) => [c.owner, c.attempts])).toEqual([['b', 1]])
      expect(await startLease(db, lease('1', 'b'), T0 + MIN + 2, MIN)).toEqual({
        attempts: 2,
        host: 'h1',
      })
      expect(await failLease(db, lease('1', 'b'), T0 + MIN + 3, backoff, 'HTTP 503')).toEqual({
        attempts: 2,
        exhausted: true,
      })
      await db.batch([...deadLetter(db, lease('1', 'b'), 2, 'HTTP 503', T0 + MIN + 4)])
      const dead = await db.all<{ kind: string; key: string; attempts: number }>(
        sql`select kind, key, attempts from dead_letters`,
      )
      expect(dead).toEqual([{ kind: 'feed.fetch', key: '1', attempts: 2 }])
      expect(await db.all(sql`select * from leases`)).toHaveLength(0)
    })

    it('counts an attempt when work starts, so a holder that dies without reporting uses one up', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1', 'h2'])
      const claim = (owner: string, now: number) =>
        claimDue(db, { kind: 'feed.fetch', owner, now, ttlMs: MIN, limit: 2, due: dueFeeds(now) })
      await claim('a', T0)
      // Feed 1 starts and its holder dies; feed 2's message waited in its queue and never started.
      expect(await startLease(db, lease('1', 'a'), T0, MIN)).toEqual({ attempts: 1, host: 'h1' })
      const again = await claim('b', T0 + 2 * MIN)
      expect(again.map((c) => [c.key, c.attempts])).toEqual([
        ['1', 1],
        ['2', 0],
      ])
      // A start on a claim that was lost counts nothing.
      expect(await startLease(db, lease('1', 'a'), T0 + 2 * MIN, MIN)).toBe(null)
    })

    it('forgets the attempt count once the work succeeds', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      const backoff = { baseMs: MIN, maxMs: 60 * MIN, maxAttempts: 5 }
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'a',
        now: T0,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      await startLease(db, lease('1', 'a'), T0, MIN)
      await failLease(db, lease('1', 'a'), T0 + 1, backoff, 'boom')
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0 + 2 * MIN,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      await startLease(db, lease('1', 'b'), T0 + 2 * MIN, MIN)
      await db.batch([fence(db, lease('1', 'b'), T0 + 2 * MIN + 1), release(db, lease('1', 'b'))])
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'c',
        now: T0 + 3 * MIN,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      const row = await first<{ attempts: number }>(db, sql`select attempts from leases`)
      expect(row?.attempts).toBe(0)
    })
  })
}
