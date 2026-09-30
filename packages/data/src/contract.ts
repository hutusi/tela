/**
 * The behaviour Tela relies on from its database, written once and run twice: under `bun test`
 * on libSQL (the portable path) and under the Workers test pool on real D1. A difference between
 * the two is a bug in the portable adapter, which is exactly what this suite exists to catch.
 */
import { sql } from 'drizzle-orm'
import { exportDatabase, verifyExport } from './backup'
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
  mergeFeed,
  updateArticles,
} from './queries/ingest'
import { compactReadStates } from './queries/reader'
import { readPull } from './queries/sync'
import { failDueTitles, settleBodyUsage, upsertArticleTitle, utcDay } from './queries/translation'
import { feeds, sites } from './schema'
import { bumpSeq, currentSeq, headSeq } from './seq'
import { blockKey, seedBlockTranslations, writingMeanwhile } from './writes-meanwhile'

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

/** Blobs in a map the test can read parts back from; the Workers pool has no portable store. */
function memoryStore() {
  const store = new Map<string, string>()
  const blobs = {
    async get(key: string) {
      const text = store.get(key)
      return text === undefined
        ? null
        : {
            key,
            size: text.length,
            contentType: null,
            text: async () => text,
            arrayBuffer: async () => new ArrayBuffer(0),
          }
    },
    async head() {
      return null
    },
    async put(key: string, body: string | Uint8Array | ArrayBuffer) {
      store.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body))
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list() {
      return { keys: [...store.keys()], cursor: null }
    },
  }
  return { blobs, store }
}

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

    it('refuses a member following themselves, or someone who does not exist (ADR 0031)', async () => {
      const db = await makeDb()
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values
          ('u1', 'u', 'u@x.y', 0, 0, 0), ('u2', 'v', 'v@x.y', 0, 0, 0)`,
      )
      const follow = (follower: string, followee: string) =>
        caught(() =>
          db.run(
            sql`insert into follows (follower_id, followee_id, created_at, updated_at)
              values (${follower}, ${followee}, 1, 1)`,
          ),
        )
      expect((await follow('u1', 'u1')) === null).toBe(false)
      expect((await follow('u1', 'nobody')) === null).toBe(false)
      expect(await follow('u1', 'u2')).toBe(null)
      // One way: u2 following back is a second row, not a conflict.
      expect(await follow('u2', 'u1')).toBe(null)
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

  describe('merging a feed into another (ADR 0028)', () => {
    it('moves its readers, its own posts and their read state in one batch', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['blog.example', 'mirror.example'])
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 1, 0, 0)`,
      )
      // Feed 1 is the blog's; feed 2, its mirror, shares post a and alone has post b.
      await db.run(sql`
        insert into articles (id, feed_id, dedup_key, url, fetched_at, sort_at) values
          (1, 1, 'a', 'https://blog.example/a', 1, 1),
          (2, 2, 'mirror-a', 'https://blog.example/a', 1, 1),
          (3, 2, 'mirror-b', 'https://blog.example/b', 2, 2)
      `)
      await db.run(sql`
        insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at) values
          ('u1', 1, 1, 0, 0), ('u1', 2, 3, 0, 0)
      `)
      await db.run(
        sql`insert into user_article_states (user_id, article_id, read_at) values ('u1', 2, 5)`,
      )
      await db.batch([
        bumpSeq(db),
        ...mergeFeed(db, { alias: 2, target: 1, move: [3], carry: [[2, 1]] }, T0),
      ] as never)

      expect(
        await first(db, sql`select status, merged_into as "mergedInto" from feeds where id = 2`),
      ).toEqual({ status: 'paused', mergedInto: 1 })
      expect(
        await db.all(sql`
          select feed_id as "feedId", watermark_id as "watermarkId", deleted_at is not null as gone
          from subscriptions order by feed_id`),
      ).toEqual([
        { feedId: 1, watermarkId: 3, gone: 0 },
        { feedId: 2, watermarkId: 3, gone: 1 },
      ])
      expect(await db.all(sql`select id, feed_id as "feedId" from articles order by id`)).toEqual([
        { id: 1, feedId: 1 },
        { id: 2, feedId: 2 },
        { id: 3, feedId: 1 },
      ])
      expect(
        await first(
          db,
          sql`select read_at as "readAt" from user_article_states where article_id = 1`,
        ),
      ).toEqual({ readAt: 5 })
    })

    it("carries a moved post's title, translation and read state to the target's readers", async () => {
      const db = await makeDb()
      await seedFeeds(db, ['blog.example', 'mirror.example'])
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 1, 0, 0)`,
      )
      await db.run(sql`
        insert into articles (id, feed_id, dedup_key, url, fetched_at, sort_at, content_key, title_hash)
        values (3, 2, 'mirror-b', 'https://blog.example/b', 2, 2, 'key-b', 'th-b')
      `)
      await db.batch([
        bumpSeq(db),
        db.run(sql`
          insert into article_titles (article_id, lang, feed_id, title, status, source_hash,
            updated_at, seq)
          values (3, 'zh-Hans', 2, '译题', 'done', 'th-b', 0, ${currentSeq})
        `),
        db.run(sql`
          insert into body_translations (content_key, lang, state, updated_at, seq)
          values ('key-b', 'zh-Hans', 'done', 0, ${currentSeq})
        `),
        db.run(sql`
          insert into user_article_states (user_id, article_id, read_at, seq)
          values ('u1', 3, 5, ${currentSeq})
        `),
      ] as never)
      await db.batch([
        bumpSeq(db),
        ...mergeFeed(db, { alias: 2, target: 1, move: [3], carry: [] }, T0),
      ] as never)
      const head = await headSeq(db)
      // A pull finds titles by feed and everything by seq: all three must say so.
      expect(await first(db, sql`select feed_id as "feedId", seq from article_titles`)).toEqual({
        feedId: 1,
        seq: head,
      })
      expect(await first(db, sql`select seq from body_translations`)).toEqual({ seq: head })
      expect(await first(db, sql`select seq from user_article_states`)).toEqual({ seq: head })

      // A title job that read the post before the merge writes the post's feed, not its own key.
      await db.batch([
        bumpSeq(db),
        upsertArticleTitle(
          db,
          {
            articleId: 3,
            lang: 'en',
            title: 'Title',
            excerpt: null,
            status: 'done',
            sourceHash: 'th-b',
            model: 'm',
          },
          T0,
        ),
      ] as never)
      expect(
        await db.all(sql`select lang, feed_id as "feedId" from article_titles order by lang`),
      ).toEqual([
        { lang: 'en', feedId: 1 },
        { lang: 'zh-Hans', feedId: 1 },
      ])

      // So does giving up on them: a row still filed under the alias is refiled as it fails.
      await db.run(sql`update articles set title = 'B', title_hash = 'th-c' where id = 3`)
      await db.run(sql`update article_titles set feed_id = 2 where lang = 'zh-Hans'`)
      await db.batch([bumpSeq(db), failDueTitles(db, 1, T0)] as never)
      expect(
        await db.all(sql`
          select lang, feed_id as "feedId", status from article_titles order by lang`),
      ).toEqual([
        { lang: 'en', feedId: 1, status: 'failed' },
        { lang: 'zh-Hans', feedId: 1, status: 'failed' },
      ])
    })
  })

  describe('compacting read state (ADR 0009)', () => {
    it('drops only read states under the watermark that never held a like', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      await db.run(sql`
        insert into user (id, name, email, email_verified, created_at, updated_at) values
          ('u1', 'u', 'u1@x.y', 1, 0, 0), ('u2', 'v', 'u2@x.y', 1, 0, 0)
      `)
      await db.run(sql`
        insert into articles (id, feed_id, dedup_key, fetched_at, sort_at) values
          (1, 1, 'a', 1, 1), (2, 1, 'b', 1, 1), (3, 1, 'c', 1, 1), (4, 1, 'd', 1, 1)
      `)
      await db.run(sql`
        insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at)
        values ('u1', 1, 3, 0, 0)
      `)
      // u1: 1 read, 2 liked, 3 liked and then unliked, 4 above the watermark. u2 follows nothing.
      await db.run(sql`
        insert into user_article_states (user_id, article_id, read_at, liked_at, liked_updated_at)
        values ('u1', 1, 5, null, null), ('u1', 2, 5, 6, 6), ('u1', 3, 5, null, 7),
          ('u1', 4, 5, null, null), ('u2', 1, 5, null, null)
      `)
      const [dropped] = await db.batch([compactReadStates(db)])
      expect(dropped).toEqual([{ article_id: 1 }])
      expect(
        await db.all(sql`
          select user_id as "userId", article_id as "articleId" from user_article_states
          order by user_id, article_id`),
      ).toEqual([
        { userId: 'u1', articleId: 2 },
        { userId: 'u1', articleId: 3 },
        { userId: 'u1', articleId: 4 },
        { userId: 'u2', articleId: 1 },
      ])
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
      expect(await startLease(db, lease('1', 'a'), 'a>1', T0, MIN)).toEqual({
        lease: lease('1', 'a>1'),
        attempts: 1,
        host: 'h1',
      })
      expect(await failLease(db, lease('1', 'a>1'), T0 + 1, backoff, 'HTTP 503')).toEqual({
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
      expect(await startLease(db, lease('1', 'b'), 'b>1', T0 + MIN + 2, MIN)).toEqual({
        lease: lease('1', 'b>1'),
        attempts: 2,
        host: 'h1',
      })
      expect(await failLease(db, lease('1', 'b>1'), T0 + MIN + 3, backoff, 'HTTP 503')).toEqual({
        attempts: 2,
        exhausted: true,
      })
      await db.batch([...deadLetter(db, lease('1', 'b>1'), 2, 'HTTP 503', T0 + MIN + 4)])
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
      expect(await startLease(db, lease('1', 'a'), 'a>1', T0, MIN)).toEqual({
        lease: lease('1', 'a>1'),
        attempts: 1,
        host: 'h1',
      })
      const again = await claim('b', T0 + 2 * MIN)
      expect(again.map((c) => [c.key, c.attempts])).toEqual([
        ['1', 1],
        ['2', 0],
      ])
      // A start on a claim that was lost counts nothing.
      expect(await startLease(db, lease('1', 'a'), 'a>2', T0 + 2 * MIN, MIN)).toBe(null)
    })

    it('starts a claim once: the run takes it over, so a second delivery of its message finds nothing', async () => {
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
      expect(await startLease(db, lease('1', 'a'), 'a>1', T0, MIN)).toEqual({
        lease: lease('1', 'a>1'),
        attempts: 1,
        host: 'h1',
      })
      // The queue delivers the same message again while the first run holds the lease.
      expect(await startLease(db, lease('1', 'a'), 'a>2', T0 + 1, MIN)).toBe(null)
      expect(await db.all(sql`select owner, attempts from leases`)).toEqual([
        { owner: 'a>1', attempts: 1 },
      ])
      // Only the run writes now: the claim's owner is refused by the fence, the run's is not.
      const stale = await caught(() =>
        db.batch([
          fence(db, lease('1', 'a'), T0 + 2),
          db.run(sql`update feeds set title = 'by the claim' where id = 1`),
        ]),
      )
      expect(isFenceRefusal(stale)).toBe(true)
      await db.batch([
        fence(db, lease('1', 'a>1'), T0 + 2),
        db.run(sql`update feeds set title = 'by the run' where id = 1`),
        release(db, lease('1', 'a>1')),
      ])
      const row = await first<{ title: string }>(db, sql`select title from feeds where id = 1`)
      expect(row?.title).toBe('by the run')
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
      await startLease(db, lease('1', 'a'), 'a>1', T0, MIN)
      await failLease(db, lease('1', 'a>1'), T0 + 1, backoff, 'boom')
      await claimDue(db, {
        kind: 'feed.fetch',
        owner: 'b',
        now: T0 + 2 * MIN,
        ttlMs: MIN,
        limit: 1,
        due: dueFeeds(T0),
      })
      await startLease(db, lease('1', 'b'), 'b>1', T0 + 2 * MIN, MIN)
      await db.batch([
        fence(db, lease('1', 'b>1'), T0 + 2 * MIN + 1),
        release(db, lease('1', 'b>1')),
      ])
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

  describe('the usage ledger', () => {
    it('settles a body translation once: the reservation back, the spend charged, and the ledger never below zero', async () => {
      const db = await makeDb()
      const day = '2026-09-26'
      await db.batch([
        db.run(
          sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 1, 0, 0)`,
        ),
        db.run(
          sql`insert into usage_daily (subject, day, reserved, used) values ('u1', ${day}, 25000, 100)`,
        ),
        db.run(sql`
          insert into body_translations (content_key, lang, state, requested_by, reserved_tokens,
            reserved_day, used_tokens, updated_at)
          values ('c1', 'en', 'running', 'u1', 20000, ${day}, 700, 0),
            ('c2', 'en', 'requested', null, 5000, null, 300, 0),
            ('c3', 'en', 'done', 'u1', 20000, ${day}, 900, 0)
        `),
      ])
      // As every ending does it: the settle, then the flip out of requested/running.
      const conclude = (key: string) =>
        db.batch([
          settleBodyUsage(db, key, 'en', T0),
          db.run(sql`
            update body_translations set state = 'failed', reserved_tokens = 0
            where content_key = ${key} and lang = 'en' and state in ('requested', 'running')
          `),
        ])
      await conclude('c1')
      // Concluded already: a second settle matches nothing, and neither does a finished row.
      await conclude('c1')
      await conclude('c3')
      // No member, and no ledger row yet: charged to '*' on today, with nothing reserved.
      await conclude('c2')
      expect(
        await db.all(sql`select subject, day, reserved, used from usage_daily order by subject`),
      ).toEqual([
        { subject: '*', day: utcDay(T0), reserved: 0, used: 300 },
        { subject: 'u1', day, reserved: 5000, used: 800 },
      ])
    })
  })

  describe('the nightly export', () => {
    it('reads every table a page at a time and verifies against its manifest', async () => {
      const db = await makeDb()
      await db.batch([
        bumpSeq(db),
        db.run(sql`insert into sites (id, home_url, created_at, updated_at, seq)
          values (1, 'https://b.example', 0, 0, ${currentSeq})`),
        db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
          values (1, 1, 'https://b.example/feed', 'b.example', 0, 0, 0, ${currentSeq})`),
        db.run(sql`
          insert into articles (feed_id, dedup_key, title, fetched_at, sort_at, seq)
          select 1, 'k' || value, 'Post ' || value, 0, value, ${currentSeq} from json_each(${JSON.stringify(
            Array.from({ length: 1234 }, (_, i) => i),
          )}) where true
        `),
      ])
      const { blobs } = memoryStore()
      const manifest = await exportDatabase(db, blobs, { date: '2026-09-28', now: () => T0 })
      expect(manifest.tables.find((t) => t.name === 'articles')?.rows).toBe(1234)
      expect((await verifyExport(blobs, '2026-09-28')).ok).toBe(true)
    })

    it('reads each row once while rows are added and removed behind it', async () => {
      // More rows added than removed, then the reverse: paged by OFFSET, the first reads the row
      // at the page boundary twice and the second never reads it.
      for (const writes of [
        { added: 2, removed: 1 },
        { added: 1, removed: 2 },
      ]) {
        const db = await makeDb()
        await seedBlockTranslations(db, 1500)
        // Two keys that JavaScript's UTF-16 order puts the other way round from SQLite's UTF-8
        // bytes (U+FFFD before U+1F600): the check has to read the export in the database's order.
        const [bmp, astral] = [0xfffd, 0x1f600].map((c) => `h${String.fromCodePoint(c)}`)
        await db.run(sql`
          insert into block_translations
            (source_hash, target_lang, source_lang, tagged_text, model, norm_version, created_at)
          values (${bmp}, 'en', 'und', 'x', 'mock', 1, 0), (${astral}, 'en', 'und', 'x', 'mock', 1, 0)
        `)
        // Tombstones have no primary key, so they page by rowid: more than a page of them.
        const tombstones = Array.from({ length: 1001 }, (_, i) => i + 1)
        await db.run(sql`
          insert into tombstones (seq, user_id, feed_id, entity, key)
          select value, null, 1, 'article', cast(value as text)
          from json_each(${JSON.stringify(tombstones)})
        `)
        const before = await db.all<Record<string, unknown>>(
          sql`select source_hash, target_lang, source_lang from block_translations`,
        )
        const { blobs, store } = memoryStore()
        const meanwhile = writingMeanwhile(db, writes)
        const manifest = await exportDatabase(meanwhile.db, blobs, {
          date: '2026-09-28',
          now: () => T0,
        })
        const exported = (name: string) =>
          (manifest.tables.find((t) => t.name === name)?.parts ?? []).flatMap((part) =>
            (store.get(part.key) ?? '')
              .split('\n')
              .filter((line) => line !== '')
              .map((line) => JSON.parse(line) as Record<string, unknown>),
          )
        const once = new Set<string>()
        const twice = exported('block_translations')
          .map(blockKey)
          .filter((key) => {
            if (once.has(key)) return true
            once.add(key)
            return false
          })
        expect(twice).toEqual([])
        const throughout = before.map(blockKey).filter((key) => !meanwhile.removed.has(key))
        expect(throughout.filter((key) => !once.has(key))).toEqual([])
        expect(exported('tombstones')).toEqual(
          tombstones.map((seq) => ({
            seq,
            user_id: null,
            feed_id: 1,
            entity: 'article',
            key: String(seq),
          })),
        )
        expect(await verifyExport(blobs, '2026-09-28')).toEqual({ ok: true, problems: [] })
      }
    })
  })
}
