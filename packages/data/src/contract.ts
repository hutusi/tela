/**
 * The behaviour Tela relies on from its database, written once and run twice: under `bun test`
 * on libSQL (the portable path) and under the Workers test pool on real D1. A difference between
 * the two is a bug in the portable adapter, which is exactly what this suite exists to catch.
 */
import { sql } from 'drizzle-orm'
import type { TelaDb } from './db'
import {
  claimDue,
  deadLetter,
  extendLease,
  failLease,
  fence,
  isFenceRefusal,
  type Lease,
  release,
} from './leases'
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
        sql`insert into user (id, name, email, emailVerified, createdAt, updatedAt) values ('u1', 'u', 'u@x.y', 0, '', '')`,
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
      expect(late).toEqual([{ key: '1', host: 'h1', owner: 'b' }])
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
      const row = await db.get<{ title: string }>(sql`select title from feeds where id = 1`)
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
      const row = await db.get<{ title: string | null }>(sql`select title from feeds where id = 1`)
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
      expect(retry.map((c) => c.owner)).toEqual(['b'])
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
      await failLease(db, lease('1', 'a'), T0 + 1, backoff, 'boom')
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0 + 2 * MIN,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      await db.batch([fence(db, lease('1', 'b'), T0 + 2 * MIN + 1), release(db, lease('1', 'b'))])
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'c',
        now: T0 + 3 * MIN,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      const row = await db.get<{ attempts: number }>(sql`select attempts from leases`)
      expect(row?.attempts).toBe(0)
    })
  })
}
