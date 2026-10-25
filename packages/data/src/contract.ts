/**
 * The behaviour Tela relies on from its database, written once and run twice: under `bun test`
 * on libSQL (the portable path) and under the Workers test pool on real D1. A difference between
 * the two is a bug in the portable adapter, which is exactly what this suite exists to catch.
 */
import { MAX_FOLDERS, PIPELINE_VERSION } from '@tela/shared'
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
  adoptExtractedVersion,
  adoptReprocessedVersion,
  dueReprocessing,
  existingArticles,
  fillSiteMetadata,
  insertArticles,
  insertVersions,
  mergeFeed,
  pointed,
  replayIfRejected,
  stampPipeline,
  updateArticles,
} from './queries/ingest'
import {
  claimByCode,
  claimInvite,
  createMemberCode,
  createOperatorCode,
  drawMemberCode,
  holdJoin,
  holdsInvite,
  inviteAddress,
  listMemberCodes,
  listOperatorCodes,
  liveCode,
  pruneInvites,
  revokeCode,
  revokeOperatorCode,
  settleInvite,
} from './queries/invites'
import { avatarOf, dueGravatarChecks } from './queries/people'
import { compactReadStates, fileImportedFeeds, writeImportFiling } from './queries/reader'
import {
  readSettings,
  restoreSetting,
  setSetting,
  settingChangedSince,
  settingSql,
} from './queries/settings'
import {
  DISCOVER_REVIEW,
  ensureFeed,
  importFeedUrls,
  publicReaderCount,
  recountReaders,
} from './queries/sites'
import { readPull, readTitles } from './queries/sync'
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
      // Added by migration 0007 with the column, not by rebuilding the table (ADR 0041).
      const badReview = await caught(() =>
        db.run(
          sql`insert into sites (home_url, review, created_at, updated_at) values ('https://a.b', 'maybe', 1, 1)`,
        ),
      )
      expect(badReview === null).toBe(false)
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

    it('keeps the checks and foreign keys of site_claims, which migration 0009 rebuilt (ADR 0045)', async () => {
      const db = await makeDb()
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 0, 0, 0)`,
      )
      await db.insert(sites).values({ homeUrl: 'https://a.b', createdAt: T0, updatedAt: T0 })
      const claimBy = (method: string, siteId = 1, userId = 'u1') =>
        db.run(sql`
          insert into site_claims (site_id, user_id, method, token, created_at)
          values (${siteId}, ${userId}, ${method}, 't', 1)
        `)
      await claimBy('github')
      await db.run(sql`update site_claims set method = 'link'`)
      expect(await caught(() => claimBy('email', 1, 'u1'))).not.toBe(null)
      expect(await caught(() => claimBy('meta', 99))).not.toBe(null)
      expect(await caught(() => db.run(sql`update site_claims set status = 'done'`))).not.toBe(null)
      // A second claim by the same member on the same site: the unique index came back too.
      expect(await caught(() => claimBy('meta'))).not.toBe(null)
    })

    it("gives a member's picture: their upload, else a Gravatar they show and have, else none (ADR 0033)", async () => {
      const db = await makeDb()
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 0, 0, 0)`,
      )
      await db.run(
        sql`insert into profiles (user_id, handle, created_at, updated_at) values ('u1', 'pic', 1, 1)`,
      )
      const set = (assignments: string) =>
        db.run(sql.raw(`update profiles set ${assignments} where user_id = 'u1'`))
      const picture = async () =>
        (
          (await db.all(
            sql`select ${avatarOf('p')} as avatar from profiles p where p.user_id = 'u1'`,
          )) as { avatar: string | null }[]
        )[0]?.avatar
      // On by default, but nobody has asked Gravatar yet: no address, so no request.
      expect(await picture()).toBe(null)
      await set('gravatar_found = 1')
      expect(await picture()).toBe('/avatar/u1?v=0')
      await set('gravatar_found = 0')
      expect(await picture()).toBe(null)
      // Turned off, a Gravatar that exists is not shown.
      await set('gravatar_found = 1, gravatar = 0, gravatar_at = 5')
      expect(await picture()).toBe(null)
      // An upload comes first, whatever the switch says.
      await set(`avatar_key = 'avatars/u1/0123456789abcdef.webp', avatar_version = 3`)
      expect(await picture()).toBe('/avatar/u1?v=3')
      await set('avatar_key = null, gravatar = 1, gravatar_at = 6, avatar_version = 4')
      expect(await picture()).toBe('/avatar/u1?v=4')
    })

    it('asks about a Gravatar that is shown, when never asked or when the answer has run out', async () => {
      const db = await makeDb()
      const now = 100 * 24 * 60 * 60 * 1000
      const day = 24 * 60 * 60 * 1000
      const people: [string, string][] = [
        ['never', 'gravatar_checked_at = null'],
        ['found-fresh', `gravatar_found = 1, gravatar_checked_at = ${now - 29 * day}`],
        ['found-stale', `gravatar_found = 1, gravatar_checked_at = ${now - 31 * day}`],
        ['missing-fresh', `gravatar_found = 0, gravatar_checked_at = ${now - 6 * day}`],
        ['missing-stale', `gravatar_found = 0, gravatar_checked_at = ${now - 8 * day}`],
        ['turned-off', 'gravatar = 0, gravatar_at = 5, gravatar_checked_at = null'],
      ]
      for (const [id, assignments] of people) {
        await db.run(
          sql`insert into user (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${`${id}@x.y`}, 0, 0, 0)`,
        )
        await db.run(
          sql`insert into profiles (user_id, handle, created_at, updated_at) values (${id}, ${id.replace('-', '_')}, 1, 1)`,
        )
        await db.run(sql.raw(`update profiles set ${assignments} where user_id = '${id}'`))
      }
      const due = (await db.all(sql`select key from (${dueGravatarChecks(now)}) order by key`)) as {
        key: string
      }[]
      expect(due.map((r) => r.key)).toEqual(['found-stale', 'missing-stale', 'never'])
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

    it('sends only the titles of the language asked, paged by them, unpaged too (ADR 0052)', async () => {
      const db = await makeDb()
      n = 0
      await setup(db)
      await articlesInOneBatch(db, 3)
      const afterArticles = await headSeq(db)
      const title = (article: number, lang: string) =>
        db.run(sql`insert into article_titles (article_id, lang, feed_id, title, status,
            source_hash, updated_at, seq)
          values (${article}, ${lang}, 1, ${`${lang} ${article}`}, 'done', 'h', 0, ${currentSeq})`)
      await db.batch([bumpSeq(db), title(1, 'en'), title(1, 'fr')] as never)
      await db.batch([bumpSeq(db), title(2, 'fr'), title(3, 'fr'), title(2, 'en')] as never)
      await db.batch([bumpSeq(db), title(3, 'en')] as never)
      const inLang = (cursor: number, limit: number, titlesLang?: string) =>
        readPull(db, { userId: member, cursor, horizon: T0 - 1, limit, titlesLang })
      const titles = (read: Awaited<ReturnType<typeof page>>) =>
        read.rows.titles.map((t) => `${t.articleId}:${t.lang}`).sort()

      expect(titles(await inLang(0, 1, 'fr'))).toEqual(['1:fr', '2:fr', '3:fr'])
      expect(titles(await inLang(0, 1))).toEqual(['1:en', '1:fr', '2:en', '2:fr', '3:en', '3:fr'])
      // One row a page: the first French title, then the two one batch wrote, which no page can
      // split, so they come unpaged, and still only in French.
      const first1 = await inLang(afterArticles, 1, 'fr')
      expect(titles(first1)).toEqual(['1:fr'])
      expect(first1.pageEnd).toBe(afterArticles + 1)
      const second = await inLang(first1.pageEnd as number, 1, 'fr')
      expect(titles(second)).toEqual(['2:fr', '3:fr'])
      expect(second.pageEnd).toBe(null)
      expect(second.head).toBe(afterArticles + 3)
    })

    it('reads the titles of named posts in one language, of those the member holds (ADR 0052)', async () => {
      const db = await makeDb()
      n = 0
      await setup(db)
      await articlesInOneBatch(db, 2)
      // Feed 2 is not followed: post 3 is not the member's, post 4 is, liked.
      await db.batch([
        bumpSeq(db),
        db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
            updated_at, seq)
          values (2, 1, 'https://h2/feed.xml', 'h2', 0, 0, 0, ${currentSeq})`),
        db.run(sql`insert into articles (id, feed_id, dedup_key, fetched_at, sort_at, seq)
          values (3, 2, 'k3', ${T0}, ${T0}, ${currentSeq}), (4, 2, 'k4', ${T0}, ${T0}, ${currentSeq})`),
        db.run(sql`insert into user_article_states (user_id, article_id, liked_at, liked_updated_at,
            seq)
          values (${member}, 4, ${T0}, ${T0}, ${currentSeq})`),
        db.run(sql`insert into article_titles (article_id, lang, feed_id, title, status,
            source_hash, updated_at, seq)
          select a.id, l.value, a.feed_id, l.value || ' ' || a.id, 'done', 'h', 0, ${currentSeq}
          from articles a, json_each('["en","fr"]') l where true`),
      ] as never)
      const keys = async (lang: string, ids: number[]) =>
        (await readTitles(db, { userId: member, lang, ids }))
          .map((t) => `${t.articleId}:${t.lang}`)
          .sort()

      expect(await keys('fr', [1, 2, 3, 4, 5])).toEqual(['1:fr', '2:fr', '4:fr'])
      expect(await keys('fr', [])).toEqual([])
      // A thousand ids are one bound parameter.
      const many = Array.from({ length: 1000 }, (_, i) => i + 1)
      expect(await keys('en', many)).toEqual(['1:en', '2:en', '4:en'])
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
            expectVersion: 1,
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

  describe('reprocessing stored bodies (ADR 0055)', () => {
    it('a current version made by an older pipeline is due until stamped or replaced', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      await db.batch([
        bumpSeq(db),
        insertArticles(
          db,
          1,
          [
            {
              dedupKey: 'g:1',
              url: 'https://h1/p/1',
              urlHost: 'h1',
              title: 'Post 1',
              author: null,
              publishedAt: T0,
              sourceLang: 'en',
              excerpt: 'Excerpt',
              contentKey: 'key-1',
              wordCount: 100,
              readingMinutes: 1,
              extractState: 'done',
              titleHash: 'th-1',
            },
          ],
          T0,
        ),
        insertVersions(
          db,
          1,
          [
            {
              dedupKey: 'g:1',
              version: 1,
              provenance: 'feed',
              contentKey: 'key-1',
              rawKey: 'r/1.html',
              bodyChars: 500,
              excerpt: 'Excerpt',
              wordCount: 100,
              readingMinutes: 1,
              lang: 'en',
              sourceUrl: null,
            },
          ],
          T0,
        ),
      ])
      const id =
        (await first<{ id: number }>(db, sql`select id from articles where dedup_key = 'g:1'`))
          ?.id ?? 0
      await db.run(sql`update articles set current_version = 1 where id = ${id}`)
      const due = async () =>
        claimDue(db, {
          kind: 'article.reprocess',
          owner: `o${Math.random()}`,
          now: T0,
          ttlMs: MIN,
          limit: 10,
          due: dueReprocessing(),
        }).then(async (rows) => {
          await db.run(sql`delete from leases`)
          return rows.map((r) => r.key)
        })
      // Inserted under this pipeline: not due.
      expect(await due()).toEqual([])
      await db.run(sql`update article_versions set pipeline_version = 0 where article_id = ${id}`)
      expect(await due()).toEqual([String(id)])
      await db.batch([bumpSeq(db), stampPipeline(db, id, 1)])
      expect(await due()).toEqual([])

      // Made again and different: a new current version, the extraction state as it was.
      await db.run(sql`update article_versions set pipeline_version = 0 where article_id = ${id}`)
      const made = {
        version: 2,
        provenance: 'feed' as const,
        contentKey: 'key-1-again',
        bodyChars: 520,
        excerpt: 'Excerpt again',
        wordCount: 110,
        readingMinutes: 1,
        lang: 'en',
      }
      await db.batch([
        bumpSeq(db),
        ...adoptReprocessedVersion(
          db,
          { id, currentVersion: 1 },
          { ...made, rawKey: 'r/1.html', sourceUrl: null },
          made,
          'th-2',
          T0,
        ),
      ])
      expect(await due()).toEqual([])
      const row = await first<Record<string, unknown>>(
        db,
        sql`select a.current_version, a.content_key, a.extract_state, a.title_hash,
              v.pipeline_version, v.raw_key
            from articles a join article_versions v on v.article_id = a.id and v.version = 2
            where a.id = ${id}`,
      )
      expect(row).toEqual({
        current_version: 2,
        content_key: 'key-1-again',
        extract_state: 'done',
        title_hash: 'th-2',
        pipeline_version: PIPELINE_VERSION,
        raw_key: 'r/1.html',
      })
    })
  })

  describe('two writers on one article', () => {
    it('the second to commit from the same current version moves nothing', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      const v = (key: string, version = 2) => ({
        version,
        provenance: 'readability' as const,
        contentKey: key,
        bodyChars: 900,
        excerpt: key,
        wordCount: 150,
        readingMinutes: 1,
        lang: 'en',
      })
      await db.batch([
        bumpSeq(db),
        insertArticles(
          db,
          1,
          [
            {
              dedupKey: 'g:1',
              url: 'https://h1/p/1',
              urlHost: 'h1',
              title: 'Post 1',
              author: null,
              publishedAt: T0,
              sourceLang: 'en',
              excerpt: 'Excerpt',
              contentKey: 'key-1',
              wordCount: 100,
              readingMinutes: 1,
              extractState: 'due',
              titleHash: 'th-1',
            },
          ],
          T0,
        ),
        insertVersions(
          db,
          1,
          [
            {
              ...v('key-1', 1),
              provenance: 'feed',
              dedupKey: 'g:1',
              rawKey: null,
              sourceUrl: null,
            },
          ],
          T0,
        ),
      ])
      const id =
        (await first<{ id: number }>(db, sql`select id from articles where dedup_key = 'g:1'`))
          ?.id ?? 0
      const state = () =>
        first<{
          current_version: number
          content_key: string
          extract_state: string
          row_key: string
        }>(
          db,
          sql`select a.current_version, a.content_key, a.extract_state, v.content_key as row_key
              from articles a join article_versions v on v.article_id = a.id and v.version = a.current_version
              where a.id = ${id}`,
        )
      // Both read version 1 and both take version 2. The reprocess commits first.
      const first1 = await db.batch([
        bumpSeq(db),
        ...adoptReprocessedVersion(
          db,
          { id, currentVersion: 1 },
          { ...v('reprocessed'), rawKey: null, sourceUrl: null },
          v('reprocessed'),
          'th-r',
          T0,
        ),
      ])
      expect(pointed(first1 as unknown[], 2)).toBe(true)
      const second = await db.batch([
        bumpSeq(db),
        ...adoptExtractedVersion(
          db,
          { id, feedId: 1, currentVersion: 1 },
          { ...v('extracted'), rawKey: null, sourceUrl: null },
          v('extracted'),
          'th-e',
          T0,
        ),
      ])
      expect(pointed(second as unknown[], 2)).toBe(false)
      expect(await state()).toEqual({
        current_version: 2,
        content_key: 'reprocessed',
        extract_state: 'due',
        row_key: 'reprocessed',
      })
      // A feed's change decided from version 1 moves nothing either, version 3 or not, and its
      // feed forgets what would let the next fetch skip the item.
      await db.run(
        sql`update feeds set etag = 'e1', last_body_hash = 'b1', next_fetch_at = ${T0 + MIN} where id = 1`,
      )
      const fed = (expectVersion: number) => ({
        id,
        expectVersion,
        url: 'https://h1/p/1',
        urlHost: 'h1',
        title: 'Post 1',
        author: null,
        publishedAt: T0,
        sourceLang: 'en',
        excerpt: 'fed',
        currentVersion: 3,
        contentKey: 'fed',
        wordCount: 150,
        readingMinutes: 1,
        extractState: 'none' as const,
        titleHash: 'th-f',
      })
      const validators = () =>
        first<Record<string, unknown>>(
          db,
          sql`select etag, last_body_hash, next_fetch_at from feeds where id = 1`,
        )
      await db.batch([
        bumpSeq(db),
        insertVersions(
          db,
          1,
          [{ ...v('fed', 3), provenance: 'feed', dedupKey: 'g:1', rawKey: null, sourceUrl: null }],
          T0,
        ),
        updateArticles(db, [fed(1)]),
        replayIfRejected(db, 1, [fed(1)], T0),
      ])
      expect((await state())?.content_key).toBe('reprocessed')
      expect(await validators()).toEqual({ etag: null, last_body_hash: null, next_fetch_at: T0 })
      // One that chose the very row the reprocess put the article on (the same body, made from
      // the item) lands in full: the feed's edits, and its page wanted again where it had failed.
      await db.run(
        sql`update feeds set etag = 'e1', last_body_hash = 'b1', next_fetch_at = ${T0 + MIN} where id = 1`,
      )
      await db.run(sql`update articles set extract_state = 'failed' where id = ${id}`)
      const same = {
        ...fed(1),
        url: 'https://h1/p/1-fixed',
        title: 'Post 1, edited',
        excerpt: 'reprocessed',
        currentVersion: 2,
        contentKey: 'reprocessed',
        extractState: 'due' as const,
      }
      await db.batch([bumpSeq(db), updateArticles(db, [same]), replayIfRejected(db, 1, [same], T0)])
      expect(
        await first(
          db,
          sql`select url, title, title_hash, current_version, extract_state from articles
              where id = ${id}`,
        ),
      ).toEqual({
        url: 'https://h1/p/1-fixed',
        title: 'Post 1, edited',
        title_hash: 'th-f',
        current_version: 2,
        extract_state: 'due',
      })
      expect(await validators()).toEqual({
        etag: 'e1',
        last_body_hash: 'b1',
        next_fetch_at: T0 + MIN,
      })
      await db.run(sql`update articles set extract_state = 'due' where id = ${id}`)
      // Decided from what is there now, it moves, and the feed keeps what it saved.
      await db.run(
        sql`update feeds set etag = 'e2', last_body_hash = 'b2', next_fetch_at = ${T0 + MIN} where id = 1`,
      )
      await db.batch([
        bumpSeq(db),
        updateArticles(db, [fed(2)]),
        replayIfRejected(db, 1, [fed(2)], T0),
      ])
      expect(await state()).toEqual({
        current_version: 3,
        content_key: 'fed',
        extract_state: 'none',
        row_key: 'fed',
      })
      expect(await validators()).toEqual({
        etag: 'e2',
        last_body_hash: 'b2',
        next_fetch_at: T0 + MIN,
      })
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

    it('keeps a blog in its folder under the address it merged into (ADR 0048)', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['blog.example', 'mirror.example'])
      await db.run(sql`
        insert into user (id, name, email, email_verified, created_at, updated_at) values
          ('u1', 'u', 'u@x.y', 1, 0, 0), ('u2', 'v', 'v@x.y', 1, 0, 0)
      `)
      await db.run(sql`
        insert into folders (id, user_id, name, created_at, updated_at) values
          ('folder-u1', 'u1', 'Cities', 0, 0), ('folder-u2a', 'u2', 'A', 0, 0),
          ('folder-u2b', 'u2', 'B', 0, 0)
      `)
      // u1 filed only the mirror; u2 filed both, the blog itself elsewhere.
      await db.run(sql`
        insert into feed_folders (user_id, feed_id, folder_id, updated_at) values
          ('u1', 2, 'folder-u1', 5), ('u2', 1, 'folder-u2a', 5), ('u2', 2, 'folder-u2b', 6)
      `)
      await db.batch([
        bumpSeq(db),
        ...mergeFeed(db, { alias: 2, target: 1, move: [], carry: [] }, T0),
      ] as never)
      expect(
        await db.all(sql`
          select user_id as "userId", folder_id as "folderId", updated_at as "updatedAt",
            seq > 0 as stamped
          from feed_folders where feed_id = 1 order by user_id`),
      ).toEqual([
        { userId: 'u1', folderId: 'folder-u1', updatedAt: 5, stamped: 1 },
        { userId: 'u2', folderId: 'folder-u2a', updatedAt: 5, stamped: 0 },
      ])
    })

    it('keeps a blog in its blogrolls under the address it merged into, with its note (ADR 0050)', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['blog.example', 'mirror.example'])
      await db.run(sql`
        insert into user (id, name, email, email_verified, created_at, updated_at) values
          ('u1', 'u', 'u@x.y', 1, 0, 0), ('u2', 'v', 'v@x.y', 1, 0, 0)
      `)
      await db.run(sql`
        insert into blogrolls (id, user_id, name, created_at, updated_at, deleted_at) values
          ('RollAliasOnly', 'u1', 'Alias only', 0, 0, null),
          ('RollBothLive0', 'u2', 'Both live', 0, 0, null),
          ('RollRevived00', 'u2', 'Target out', 0, 0, null),
          ('RollDeleted00', 'u1', 'Deleted', 0, 0, 1),
          ('RollAliasOut0', 'u1', 'Alias out', 0, 0, null)
      `)
      // Feed 1 is the blog's; feed 2, its mirror, merges into it.
      await db.run(sql`
        insert into blogroll_blogs (blogroll_id, feed_id, user_id, note, note_at, added_at,
          updated_at, removed_at) values
          ('RollAliasOnly', 2, 'u1', 'Read this', 5, 3, 4, null),
          ('RollBothLive0', 1, 'u2', 'Mine', 2, 1, 2, null),
          ('RollBothLive0', 2, 'u2', 'Theirs', 6, 5, 6, null),
          ('RollRevived00', 1, 'u2', 'Old', 2, 1, 9, 9),
          ('RollRevived00', 2, 'u2', 'New', 6, 7, 8, null),
          ('RollDeleted00', 2, 'u1', null, 0, 1, 1, null),
          ('RollAliasOut0', 2, 'u1', 'Gone', 1, 1, 3, 3)
      `)
      await db.batch([
        bumpSeq(db),
        ...mergeFeed(db, { alias: 2, target: 1, move: [], carry: [] }, T0),
      ] as never)
      expect(
        await db.all(sql`
          select blogroll_id as "blogrollId", feed_id as "feedId", user_id as "userId", note,
            note_at as "noteAt", added_at as "addedAt", updated_at as "updatedAt",
            removed_at as "removedAt", seq > 0 as stamped
          from blogroll_blogs order by blogroll_id, feed_id`),
      ).toEqual([
        // Carried with its place and note; the alias's row taken out.
        {
          blogrollId: 'RollAliasOnly',
          feedId: 1,
          userId: 'u1',
          note: 'Read this',
          noteAt: 5,
          addedAt: 3,
          updatedAt: 4,
          removedAt: null,
          stamped: 1,
        },
        {
          blogrollId: 'RollAliasOnly',
          feedId: 2,
          userId: 'u1',
          note: 'Read this',
          noteAt: 5,
          addedAt: 3,
          updatedAt: T0,
          removedAt: T0,
          stamped: 1,
        },
        // An alias row already taken out goes along, still out, with its note; it stays as it was.
        {
          blogrollId: 'RollAliasOut0',
          feedId: 1,
          userId: 'u1',
          note: 'Gone',
          noteAt: 1,
          addedAt: 1,
          updatedAt: 3,
          removedAt: 3,
          stamped: 1,
        },
        {
          blogrollId: 'RollAliasOut0',
          feedId: 2,
          userId: 'u1',
          note: 'Gone',
          noteAt: 1,
          addedAt: 1,
          updatedAt: 3,
          removedAt: 3,
          stamped: 0,
        },
        // The target in already keeps its own.
        {
          blogrollId: 'RollBothLive0',
          feedId: 1,
          userId: 'u2',
          note: 'Mine',
          noteAt: 2,
          addedAt: 1,
          updatedAt: 2,
          removedAt: null,
          stamped: 0,
        },
        {
          blogrollId: 'RollBothLive0',
          feedId: 2,
          userId: 'u2',
          note: 'Theirs',
          noteAt: 6,
          addedAt: 5,
          updatedAt: T0,
          removedAt: T0,
          stamped: 1,
        },
        // A deleted blogroll is left alone.
        {
          blogrollId: 'RollDeleted00',
          feedId: 2,
          userId: 'u1',
          note: null,
          noteAt: 0,
          addedAt: 1,
          updatedAt: 1,
          removedAt: null,
          stamped: 0,
        },
        // A target taken out comes back with the alias's place and note, its clock not moving back.
        {
          blogrollId: 'RollRevived00',
          feedId: 1,
          userId: 'u2',
          note: 'New',
          noteAt: 6,
          addedAt: 7,
          updatedAt: 9,
          removedAt: null,
          stamped: 1,
        },
        {
          blogrollId: 'RollRevived00',
          feedId: 2,
          userId: 'u2',
          note: 'New',
          noteAt: 6,
          addedAt: 7,
          updatedAt: T0,
          removedAt: T0,
          stamped: 1,
        },
      ])
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

      // So does giving up on them: a row still filed under the alias is refiled as it fails, and
      // every launch language the post is not in is given up on. A row that held the previous
      // title's translation loses it, so nobody reads the old headline under the new one.
      await db.run(sql`update articles set title = 'B', title_hash = 'th-c' where id = 3`)
      await db.run(sql`update article_titles set feed_id = 2 where lang = 'zh-Hans'`)
      await db.batch([bumpSeq(db), failDueTitles(db, 1, T0)] as never)
      expect(
        await db.all(sql`
          select lang, feed_id as "feedId", status, title from article_titles order by lang`),
      ).toEqual([
        { lang: 'en', feedId: 1, status: 'failed', title: null },
        { lang: 'fr', feedId: 1, status: 'failed', title: null },
        { lang: 'zh-Hans', feedId: 1, status: 'failed', title: null },
        { lang: 'zh-Hant', feedId: 1, status: 'failed', title: null },
      ])
    })

    it("leaves a post marked unread unread, and carries a duplicate's unread to its copy", async () => {
      const db = await makeDb()
      await seedFeeds(db, ['blog.example', 'mirror.example'])
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 1, 0, 0)`,
      )
      // Feed 2 mirrors feed 1: duplicates 2 and 5 of copies 1 and 4, and post 3 only it has.
      await db.run(sql`
        insert into articles (id, feed_id, dedup_key, url, fetched_at, sort_at) values
          (1, 1, 'a', 'https://blog.example/a', 1, 1),
          (2, 2, 'mirror-a', 'https://blog.example/a', 1, 1),
          (3, 2, 'mirror-b', 'https://blog.example/b', 1, 1),
          (4, 1, 'c', 'https://blog.example/c', 1, 1),
          (5, 2, 'mirror-c', 'https://blog.example/c', 1, 1)
      `)
      // The alias's watermark covers all three of its posts; the reader marked 2 and 3 unread
      // there, read 5 and then marked its copy, 4, unread on the target, later.
      await db.run(sql`
        insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at) values
          ('u1', 1, 0, 0, 0), ('u1', 2, 5, 0, 0)
      `)
      await db.run(sql`
        insert into user_article_states (user_id, article_id, read_at, read_updated_at) values
          ('u1', 2, null, 8), ('u1', 3, null, 7), ('u1', 5, 6, null), ('u1', 4, null, 9)
      `)
      const carry: [number, number][] = [
        [2, 1],
        [5, 4],
      ]
      await db.batch([
        bumpSeq(db),
        ...mergeFeed(db, { alias: 2, target: 1, move: [3], carry }, T0),
      ] as never)
      expect(
        await db.all(sql`
          select article_id as "articleId", read_at as "readAt", read_updated_at as "readUpdatedAt"
          from user_article_states where article_id in (1, 3, 4) order by article_id`),
      ).toEqual([
        { articleId: 1, readAt: null, readUpdatedAt: 8 },
        { articleId: 3, readAt: null, readUpdatedAt: 7 },
        { articleId: 4, readAt: null, readUpdatedAt: 9 },
      ])
    })

    it("carries a duplicate's later read clock, to a new copy and over an existing one", async () => {
      // Codex review: a duplicate read at 20 and again at 30 was carried as a read at 20 with no
      // clock, so an unread from 25 then won on the target.
      const db = await makeDb()
      await seedFeeds(db, ['blog.example', 'mirror.example'])
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 1, 0, 0)`,
      )
      // Copies 1, 3, 5, 7, 9 on feed 1; their duplicates 2, 4, 6, 8, 10 on feed 2.
      const pairs: [number, number][] = [1, 3, 5, 7, 9].map((copy) => [copy + 1, copy])
      await db.run(sql`
        insert into articles (id, feed_id, dedup_key, fetched_at, sort_at)
        select value, 2 - (value % 2), 'k' || value, 1, 1 from json_each(${JSON.stringify(
          pairs.flat(),
        )})
      `)
      // No watermark on either side, so only what was written down is carried.
      await db.run(sql`
        insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at) values
          ('u1', 1, 0, 0, 0), ('u1', 2, 0, 0, 0)
      `)
      await db.run(sql`
        insert into user_article_states (user_id, article_id, read_at, read_updated_at) values
          ('u1', 2, 20, 30),
          ('u1', 4, 20, 30), ('u1', 3, null, 25),
          ('u1', 6, 20, 30), ('u1', 5, 10, null),
          ('u1', 8, 20, 30), ('u1', 7, 35, 40),
          ('u1', 10, 20, null)
      `)
      await db.batch([
        bumpSeq(db),
        ...mergeFeed(db, { alias: 2, target: 1, move: [], carry: pairs }, T0),
      ] as never)
      expect(
        await db.all(sql`
          select article_id as "articleId", read_at as "readAt", read_updated_at as "readUpdatedAt"
          from user_article_states where article_id in (1, 3, 5, 7, 9) order by article_id`),
      ).toEqual([
        { articleId: 1, readAt: 20, readUpdatedAt: 30 }, // no copy yet: the read and its clock
        { articleId: 3, readAt: 20, readUpdatedAt: 30 }, // marked unread at 25: the read at 30 wins
        { articleId: 5, readAt: 10, readUpdatedAt: 30 }, // read at 10: its first time, the later clock
        { articleId: 7, readAt: 35, readUpdatedAt: 40 }, // read later on the copy: unchanged
        { articleId: 9, readAt: 20, readUpdatedAt: null }, // read once: still no clock to keep
      ])
    })
  })

  describe('placeholder sites', () => {
    const feedless = (db: TelaDb) =>
      db.all(sql`
        select home_url as "homeUrl" from sites s
        where not exists (select 1 from feeds f where f.site_id = s.id) order by home_url`)
    const feedUrl = 'http://blog.example/feed.xml'

    it('a known feed, registered or imported again, makes no site that would hold nothing', async () => {
      const db = await makeDb()
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 1, 0, 0)`,
      )
      const made = await ensureFeed(db, {
        feedUrl,
        host: 'blog.example',
        siteOrigin: 'https://blog.example',
        now: T0,
      })
      expect(made.created).toBe(true)
      expect(
        await ensureFeed(db, {
          feedUrl,
          host: 'blog.example',
          siteOrigin: 'https://elsewhere.example',
          now: T0,
        }),
      ).toEqual({ ...made, created: false })
      const ids = await importFeedUrls(
        db,
        [
          { feedUrl, host: 'blog.example', origin: 'http://blog.example' },
          {
            feedUrl: 'https://new.example/feed',
            host: 'new.example',
            origin: 'https://new.example',
          },
        ],
        'u1',
        T0,
      )
      expect(ids).toHaveLength(2)
      expect(await feedless(db)).toEqual([])
      expect(await db.all(sql`select home_url as "homeUrl" from sites order by home_url`)).toEqual([
        { homeUrl: 'https://blog.example' },
        { homeUrl: 'https://new.example' },
      ])
    })
  })

  describe("an OPML import's folders (ADR 0048)", () => {
    const url = (i: number, host: string) => `https://${host}/feed-${i}.xml`
    const seedMember = async (db: TelaDb) => {
      await seedFeeds(db, ['a.example', 'b.example', 'c.example', 'd.example'])
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'u', 'u@x.y', 1, 0, 0)`,
      )
    }
    const filings = (db: TelaDb) =>
      db.all(sql`
        select feed_id as "feedId", folder_id as "folderId", seq > 0 as stamped
        from feed_folders where user_id = 'u1' order by feed_id`)

    it('files only blogs in no live folder, by name case aside, under the feed a merged one became', async () => {
      const db = await makeDb()
      await seedMember(db)
      await db.run(sql`update feeds set merged_into = 3 where id = 4`)
      await db.run(sql`
        insert into folders (id, user_id, name, created_at, updated_at, deleted_at) values
          ('folder-mine', 'u1', 'Mine', 0, 0, null), ('folder-gone', 'u1', 'Gone', 0, 0, 1)
      `)
      // Feed 1 is filed; feed 2's folder is gone, which is no folder.
      await db.run(sql`
        insert into feed_folders (user_id, feed_id, folder_id, updated_at) values
          ('u1', 1, 'folder-mine', 1), ('u1', 2, 'folder-gone', 1)
      `)
      const filed = await fileImportedFeeds(
        db,
        'u1',
        [
          { name: 'mine', urls: [url(1, 'a.example'), url(4, 'd.example')] },
          { name: 'Tech', urls: [url(2, 'b.example')] },
          { name: 'Empty', urls: [url(1, 'a.example')] },
        ],
        T0,
        () => 'folder-made',
      )
      expect(filed).toEqual({ folders: 1, filed: 2 })
      expect(
        await db.all(sql`select id, name from folders where user_id = 'u1' order by id`),
      ).toEqual([
        { id: 'folder-gone', name: 'Gone' },
        { id: 'folder-made', name: 'Tech' },
        { id: 'folder-mine', name: 'Mine' },
      ])
      expect(await filings(db)).toEqual([
        { feedId: 1, folderId: 'folder-mine', stamped: 0 },
        { feedId: 2, folderId: 'folder-made', stamped: 1 },
        { feedId: 3, folderId: 'folder-mine', stamped: 1 },
      ])
    })

    it('makes no folder past MAX_FOLDERS when others were made meanwhile, nor moves a blog filed meanwhile', async () => {
      const db = await makeDb()
      await seedMember(db)
      // Room for two of the import's three, counted once before it inserts any: counted again
      // after each, the second would not fit.
      const ids = JSON.stringify(Array.from({ length: MAX_FOLDERS - 2 }, (_, i) => i))
      await db.run(sql`
        insert into folders (id, user_id, name, created_at, updated_at)
        select 'folder-n' || value, 'u1', 'F' || value, 0, 0 from json_each(${ids})
      `)
      await db.run(sql`
        insert into feed_folders (user_id, feed_id, folder_id, updated_at)
        values ('u1', 3, 'folder-n0', 1)
      `)
      // What an import decided before those folders and that filing were made.
      const filed = await writeImportFiling(
        db,
        'u1',
        {
          create: [
            { id: 'folder-x', name: 'X' },
            { id: 'folder-y', name: 'Y' },
            { id: 'folder-z', name: 'Z' },
          ],
          file: [
            { feedId: 1, folderId: 'folder-x' },
            { feedId: 2, folderId: 'folder-z' },
            { feedId: 3, folderId: 'folder-x' },
            { feedId: 4, folderId: 'folder-y' },
          ],
        },
        T0,
      )
      expect(filed).toEqual({ folders: 2, filed: 2 })
      expect(
        await db.all(
          sql`select id from folders where user_id = 'u1' and id not like 'folder-n%' order by id`,
        ),
      ).toEqual([{ id: 'folder-x' }, { id: 'folder-y' }])
      expect(await filings(db)).toEqual([
        { feedId: 1, folderId: 'folder-x', stamped: 1 },
        { feedId: 3, folderId: 'folder-n0', stamped: 0 },
        { feedId: 4, folderId: 'folder-y', stamped: 1 },
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

    it('keeps a read or an unread the member chose by hand, under the watermark too', async () => {
      const db = await makeDb()
      await seedFeeds(db, ['h1'])
      await db.run(sql`
        insert into user (id, name, email, email_verified, created_at, updated_at)
        values ('u1', 'u', 'u1@x.y', 1, 0, 0)
      `)
      await db.run(sql`
        insert into articles (id, feed_id, dedup_key, fetched_at, sort_at) values
          (1, 1, 'a', 1, 1), (2, 1, 'b', 1, 1), (3, 1, 'c', 1, 1)
      `)
      await db.run(sql`
        insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at)
        values ('u1', 1, 3, 0, 0)
      `)
      // 1 read once, 2 marked unread, 3 marked unread and then read again.
      await db.run(sql`
        insert into user_article_states (user_id, article_id, read_at, read_updated_at)
        values ('u1', 1, 5, null), ('u1', 2, null, 6), ('u1', 3, 7, 7)
      `)
      const [dropped] = await db.batch([compactReadStates(db)])
      expect(dropped).toEqual([{ article_id: 1 }])
      expect(
        await db.all(sql`
          select article_id as "articleId", read_at as "readAt", read_updated_at as "readUpdatedAt"
          from user_article_states order by article_id`),
      ).toEqual([
        { articleId: 2, readAt: null, readUpdatedAt: 6 },
        { articleId: 3, readAt: 7, readUpdatedAt: 7 },
      ])
    })
  })

  describe('the Discover review queue (ADR 0041)', () => {
    it('holds a blog a member added that a live feed has filled, until someone decides', async () => {
      const db = await makeDb()
      await db.run(sql`
        insert into user (id, name, email, email_verified, created_at, updated_at)
        values ('u1', 'u', 'u1@x.y', 1, 0, 0)
      `)
      // 1 waits. 2 is claimed, 3 judged not for Discover, 4 nobody reads, 5 an empty
      // placeholder, 6 has only a dead feed and 7 only a merged one, 8 is listed already.
      await db.run(sql`
        insert into sites (id, home_url, listing, claimed_by, review, reviewed_at, reader_count,
          created_at, updated_at) values
          (1, 'https://a.test', 'private', null, null, null, 1, 0, 0),
          (2, 'https://b.test', 'private', 'u1', null, null, 1, 0, 0),
          (3, 'https://c.test', 'private', null, 'dismissed', 5, 2, 0, 0),
          (4, 'https://d.test', 'private', null, null, null, 0, 0, 0),
          (5, 'https://e.test', 'private', null, null, null, 1, 0, 0),
          (6, 'https://f.test', 'private', null, null, null, 1, 0, 0),
          (7, 'https://g.test', 'private', null, null, null, 1, 0, 0),
          (8, 'https://h.test', 'listed', null, null, null, 1, 0, 0)
      `)
      await db.run(sql`
        insert into feeds (id, site_id, feed_url, host, status, merged_into, next_fetch_at,
          created_at, updated_at) values
          (1, 1, 'https://a.test/f', 'a.test', 'active', null, 0, 0, 0),
          (2, 2, 'https://b.test/f', 'b.test', 'active', null, 0, 0, 0),
          (3, 3, 'https://c.test/f', 'c.test', 'active', null, 0, 0, 0),
          (4, 4, 'https://d.test/f', 'd.test', 'active', null, 0, 0, 0),
          (5, 5, 'https://e.test/f', 'e.test', 'active', null, 0, 0, 0),
          (6, 6, 'https://f.test/f', 'f.test', 'dead', null, 0, 0, 0),
          (7, 7, 'https://g.test/f', 'g.test', 'active', 1, 0, 0, 0),
          (8, 8, 'https://h.test/f', 'h.test', 'active', null, 0, 0, 0)
      `)
      await db.run(sql`
        insert into articles (feed_id, dedup_key, fetched_at, sort_at)
        select value, 'post', 1, 1 from json_each('[1, 2, 3, 4, 6, 7, 8]') where true
      `)
      const queued = await db.all<{ id: number }>(
        sql`select s.id from sites s where ${DISCOVER_REVIEW} order by s.id`,
      )
      expect(queued).toEqual([{ id: 1 }])
    })

    it('recounts readers, stamping the row only when what a device holds of it changed', async () => {
      const db = await makeDb()
      await db.run(sql`
        insert into user (id, name, email, email_verified, created_at, updated_at)
        select 'u' || value, 'u', 'u' || value || '@x.y', 1, 0, 0 from json_each('[1,2,3,4]')
        where true
      `)
      await db.run(sql`insert into sites (id, home_url, created_at, updated_at, seq)
        values (1, 'https://a.test', 0, 0, 0)`)
      await db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
        updated_at) values (1, 1, 'https://a.test/f', 'a.test', 0, 0, 0)`)
      const recount = async (change: ReturnType<typeof sql>) => {
        await db.batch([bumpSeq(db), db.run(change), ...recountReaders(db, sql`1`, 5)] as never)
        return first<{ reader_count: number; listing: string; seq: number }>(
          db,
          sql`select reader_count, listing, seq from sites where id = 1`,
        )
      }
      const subscribe = (user: string) =>
        recount(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
          values (${user}, 1, 0, 0)`)
      const leave = (user: string) =>
        recount(sql`update subscriptions set deleted_at = 1 where user_id = ${user}`)
      // One reader, then two: a device holds 0 either way, so the seq stays.
      expect(await subscribe('u1')).toEqual({ reader_count: 1, listing: 'private', seq: 0 })
      expect(await subscribe('u2')).toEqual({ reader_count: 2, listing: 'private', seq: 0 })
      // Three: the count and the community door's listing are the device's to hold.
      expect(await subscribe('u3')).toEqual({ reader_count: 3, listing: 'listed', seq: 3 })
      expect(await subscribe('u4')).toEqual({ reader_count: 4, listing: 'listed', seq: 4 })
      // Back to two shows 0 again; and nobody leaving changes nothing.
      expect(await leave('u4')).toEqual({ reader_count: 3, listing: 'listed', seq: 5 })
      expect(await leave('u3')).toEqual({ reader_count: 2, listing: 'listed', seq: 6 })
      expect(await leave('u3')).toEqual({ reader_count: 2, listing: 'listed', seq: 6 })
    })

    it('gives a public reader count only from three readers, and orders the rest as equals', async () => {
      const db = await makeDb()
      await db.run(sql`
        insert into sites (id, home_url, reader_count, created_at, updated_at) values
          (1, 'https://a.test', 0, 0, 0), (2, 'https://b.test', 2, 0, 0),
          (3, 'https://c.test', 1, 0, 0), (4, 'https://d.test', 3, 0, 0),
          (5, 'https://e.test', 40, 0, 0)
      `)
      const count = publicReaderCount('s')
      const rows = await db.all<{ id: number; n: number | null }>(sql`
        select s.id, ${count} as n from sites s order by coalesce(${count}, 0) desc, s.id
      `)
      expect(rows).toEqual([
        { id: 5, n: 40 },
        { id: 4, n: 3 },
        { id: 1, n: null },
        { id: 2, n: null },
        { id: 3, n: null },
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

  describe('runtime settings (ADR 0056)', () => {
    const value = (db: TelaDb, key: Parameters<typeof settingSql>[0]) =>
      first<{ v: unknown }>(db, sql`select ${settingSql(key)} as v`)

    it('reads the default until a row overrides it, a stored null included', async () => {
      const db = await makeDb()
      expect(await value(db, 'member.feedsPerDay')).toEqual({ v: 20 })
      expect(await value(db, 'signup.mode')).toEqual({ v: 'invite' })
      expect(await value(db, 'translation.backgroundDailyTokens')).toEqual({ v: null })
      await db.batch([
        ...setSetting(db, {
          key: 'member.feedsPerDay',
          value: null,
          actor: null,
          group: 'g1',
          now: T0,
        }),
      ] as never)
      // A stored null means no limit; it must not fall back to the default.
      expect(await value(db, 'member.feedsPerDay')).toEqual({ v: null })
      await db.batch([
        ...setSetting(db, { key: 'signup.mode', value: 'open', actor: null, group: 'g2', now: T0 }),
      ] as never)
      expect(await value(db, 'signup.mode')).toEqual({ v: 'open' })
      const all = await readSettings(db)
      expect(all['member.feedsPerDay']).toBe(null)
      expect(all['signup.mode']).toBe('open')
      expect(all['member.maxSubscriptions']).toBe(300)
    })

    it('audits a change once, and an undo puts back the default by deleting the row', async () => {
      const db = await makeDb()
      const set = (v: number) =>
        db.batch([
          ...setSetting(db, {
            key: 'member.translationsPerDay',
            value: v,
            actor: null,
            group: `g${v}`,
            now: T0,
          }),
        ] as never) as unknown as Promise<unknown[][]>
      const first5 = await set(5)
      expect(first5[1]).toEqual([{ key: 'member.translationsPerDay' }])
      // The same value again changes nothing and logs nothing.
      const again = await set(5)
      expect(again[1]).toEqual([])
      await set(7)
      const log = await db.all<{ group_id: string; detail: string }>(
        sql`select group_id, detail from admin_actions where action = 'setting.set' order by id`,
      )
      expect(log.map((r) => [r.group_id, JSON.parse(r.detail)])).toEqual([
        ['g5', { from: { value: null, stored: 0 }, to: { value: 5, stored: true } }],
        ['g7', { from: { value: 5, stored: 1 }, to: { value: 7, stored: true } }],
      ])
      // Undo the 7: still holding it, so not changed since; the 5 comes back.
      expect(
        await first(db, sql`select ${settingChangedSince('member.translationsPerDay', 7)} as c`),
      ).toEqual({ c: 0 })
      await db.batch([
        restoreSetting(db, {
          key: 'member.translationsPerDay',
          from: { value: 5, stored: true },
          now: T0,
        }),
      ] as never)
      expect(await value(db, 'member.translationsPerDay')).toEqual({ v: 5 })
      // Undo the 5: nothing was stored before it, so the row goes and the default holds.
      await db.batch([
        restoreSetting(db, {
          key: 'member.translationsPerDay',
          from: { value: null, stored: false },
          now: T0,
        }),
      ] as never)
      expect(await value(db, 'member.translationsPerDay')).toEqual({ v: 20 })
      expect(await db.all(sql`select key from settings`)).toEqual([])
    })

    it('reads a stored value that no longer parses as the default', async () => {
      const db = await makeDb()
      await db.batch([
        db.run(
          sql`insert into settings (key, value, updated_at) values ('signup.mode', '"closed"', 0), ('nope', '1', 0)`,
        ),
      ] as never)
      expect((await readSettings(db))['signup.mode']).toBe('invite')
    })
  })

  describe('invite codes (ADR 0034)', () => {
    const HOUR = 60 * MIN
    const DAY = 24 * HOUR
    // Members' codes, shaped as tela-api draws them.
    const A = 'A'.repeat(12)
    const B = 'B'.repeat(12)
    const C = 'C'.repeat(12)
    const D = 'D'.repeat(12)
    const E = 'E'.repeat(12)
    const F = 'F'.repeat(12)

    async function people(db: TelaDb, ...ids: string[]) {
      for (const id of ids) {
        await db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
          values (${id}, '', ${`${id}@x.y`}, 1, 0, 0)`)
      }
    }
    /** What the gate and the settlement do once better-auth has inserted the user. */
    async function joined(db: TelaDb, id: string, now = T0) {
      await people(db, id)
      await db.run(sql`insert into profiles (user_id, handle, created_at, updated_at)
        values (${id}, ${id}, 0, 0)`)
      return settleInvite(db, { email: `${id}@x.y`, userId: id, now })
    }
    const rows = (db: TelaDb) =>
      db.all<{ code: string | null; email: string; redeemed: number; user_id: string | null }>(
        sql`select code, email, redeemed_at is not null as redeemed, user_id
          from invite_redemptions order by id`,
      )
    const member = (db: TelaDb, userId: string, code: string, now = T0) =>
      createMemberCode(db, { userId, code, now })
    const hold = (db: TelaDb, code: string, email: string, now = T0) =>
      holdJoin(db, { code, email, now })

    it('checks what a code may be, and keeps one row per code and address', async () => {
      const db = await makeDb()
      const code = (text: string, uses = 1) =>
        caught(() =>
          db.run(
            sql`insert into invite_codes (code, max_uses, created_at) values (${text}, ${uses}, 0)`,
          ),
        )
      for (const bad of ['abcd', 'ABC', 'A'.repeat(33), 'AB-CD']) {
        expect((await code(bad)) === null).toBe(false)
      }
      expect((await code('ABCD', 0)) === null).toBe(false)
      expect((await code('ABCE', 100_001)) === null).toBe(false)
      expect(await code('ABCD')).toBe(null)
      expect(await code('A'.repeat(32), 100_000)).toBe(null)
      const redemption = (text: string | null) =>
        caught(() =>
          db.run(sql`insert into invite_redemptions (code, email, expires_at, created_at)
            values (${text}, 'a@x.y', 1, 0)`),
        )
      expect(await redemption('ABCD')).toBe(null)
      expect((await redemption('ABCD')) === null).toBe(false)
      // The operator's invitations to one address have no code, and nulls never collide.
      expect(await redemption(null)).toBe(null)
      expect(await redemption(null)).toBe(null)
      expect((await redemption('WXYZ')) === null).toBe(false)
    })

    it("holds an address without taking a place; a later join, a member's too, moves a single-use hold", async () => {
      const db = await makeDb()
      await people(db, 'inviter', 'member')
      expect(await member(db, 'inviter', A)).toEqual({ ok: true, code: A })
      expect(await createOperatorCode(db, { code: 'WELCOME', maxUses: 2, now: T0 })).toBe(true)

      expect(await hold(db, 'NOSUCH', 'a@x.y')).toBe('invalid')
      expect(await hold(db, A, 'A@X.Y')).toBe('held')
      expect(await hold(db, A, 'a@x.y', T0 + HOUR)).toBe('held')
      const expiry = await db.all<{ expires_at: number }>(
        sql`select expires_at from invite_redemptions where email = 'a@x.y'`,
      )
      expect(expiry).toEqual([{ expires_at: T0 + HOUR + DAY }])
      expect(await holdsInvite(db, { email: 'a@x.y', now: T0 })).toBe(true)
      // Only the last address asked for can finish.
      expect(await hold(db, A, 'b@x.y')).toBe('held')
      expect(await holdsInvite(db, { email: 'a@x.y', now: T0 })).toBe(false)
      expect(await holdsInvite(db, { email: 'b@x.y', now: T0 })).toBe(true)
      // On a code with more places, every hold stands, and none of them takes one.
      for (const who of ['c', 'd', 'e']) {
        expect(await hold(db, 'WELCOME', `${who}@x.y`)).toBe('held')
      }
      // A hold lapses after a day, and the mail gate stops with it.
      expect(await holdsInvite(db, { email: 'b@x.y', now: T0 + DAY + 1 })).toBe(false)
      // An address with an account writes nothing, whatever it brought, but its join moves a
      // single-use hold like anyone's: were b@'s kept, it would say member@ has an account.
      expect(await hold(db, A, 'member@x.y')).toBe('member')
      expect(await holdsInvite(db, { email: 'b@x.y', now: T0 })).toBe(false)
      expect(await hold(db, 'WELCOME', 'member@x.y')).toBe('member')
      expect(await hold(db, 'NOSUCH', 'member@x.y')).toBe('invalid')
      expect(await holdsInvite(db, { email: 'member@x.y', now: T0 })).toBe(false)
      expect((await rows(db)).map((r) => [r.code, r.email, r.redeemed])).toEqual([
        ['WELCOME', 'c@x.y', 0],
        ['WELCOME', 'd@x.y', 0],
        ['WELCOME', 'e@x.y', 0],
      ])
    })

    it('admits by a claim: the operator invitation first, then the newest hold, never past the places', async () => {
      const db = await makeDb()
      await people(db, 'inviter')
      await member(db, 'inviter', A)
      await member(db, 'inviter', B)
      await createOperatorCode(db, { code: 'WELCOME', maxUses: 2, now: T0 })

      await hold(db, 'WELCOME', 'op@x.y')
      await inviteAddress(db, { email: 'Op@x.y', now: T0 })
      expect((await claimInvite(db, { email: 'op@x.y', now: T0 }))?.code).toBe(null)

      await hold(db, A, 'n@x.y', T0)
      await hold(db, B, 'n@x.y', T0 + MIN)
      expect((await claimInvite(db, { email: 'n@x.y', now: T0 + MIN }))?.code).toBe(B)

      for (const who of ['c', 'd', 'e']) await hold(db, 'WELCOME', `${who}@x.y`)
      expect((await claimInvite(db, { email: 'c@x.y', now: T0 }))?.code).toBe('WELCOME')
      expect((await claimInvite(db, { email: 'd@x.y', now: T0 }))?.code).toBe('WELCOME')
      // Both places taken: the third hold admits nobody, is not mailed, and a new join is refused.
      expect(await claimInvite(db, { email: 'e@x.y', now: T0 })).toBe(null)
      expect(await holdsInvite(db, { email: 'e@x.y', now: T0 })).toBe(false)
      expect(await hold(db, 'WELCOME', 'f@x.y')).toBe('used')
      expect(await hold(db, 'WELCOME', 'inviter@x.y')).toBe('used')

      // A lapsed hold, and an operator invitation past its hour, admit nobody.
      await hold(db, A, 'late@x.y')
      expect(await claimInvite(db, { email: 'late@x.y', now: T0 + DAY + 1 })).toBe(null)
      await inviteAddress(db, { email: 'slow@x.y', now: T0 })
      expect(await claimInvite(db, { email: 'slow@x.y', now: T0 + HOUR + 1 })).toBe(null)
      expect(await claimInvite(db, { email: 'nobody@x.y', now: T0 })).toBe(null)
    })

    it('spends the code an address joined with last, a repeated join included', async () => {
      const db = await makeDb()
      await people(db, 'p', 'q')
      await member(db, 'p', A)
      await member(db, 'q', B)
      // Two members' codes for one visitor, and the first chosen again last.
      await hold(db, A, 'v@x.y', T0)
      await hold(db, B, 'v@x.y', T0 + MIN)
      expect(await hold(db, A, 'v@x.y', T0 + 2 * MIN)).toBe('held')
      expect((await claimInvite(db, { email: 'v@x.y', now: T0 + 2 * MIN }))?.code).toBe(A)
      // The other member's code keeps its place.
      expect(await hold(db, B, 'w@x.y', T0 + 3 * MIN)).toBe('held')
    })

    it('admits the same address again after a failed create, and spends no second place', async () => {
      const db = await makeDb()
      await people(db, 'inviter')
      await member(db, 'inviter', A)
      await hold(db, A, 'xan@x.y')
      const claim = await claimInvite(db, { email: 'xan@x.y', now: T0 })
      expect(claim === null).toBe(false)
      // The user insert after the claim failed: the address may finish, another may not start.
      expect(await claimInvite(db, { email: 'xan@x.y', now: T0 + 2 * DAY })).toEqual(claim)
      expect(await holdsInvite(db, { email: 'xan@x.y', now: T0 + 2 * DAY })).toBe(true)
      expect(await hold(db, A, 'xan@x.y', T0 + 2 * DAY)).toBe('held')
      expect(await hold(db, A, 'y@x.y', T0 + 2 * DAY)).toBe('used')
      expect(await claimByCode(db, { code: A, email: 'xan@x.y', now: T0 })).toEqual(claim)
      // Once the account exists, nothing admits the address again.
      expect(await joined(db, 'xan')).toEqual([claim])
      expect(await claimInvite(db, { email: 'xan@x.y', now: T0 })).toBe(null)
      expect(await claimByCode(db, { code: A, email: 'xan@x.y', now: T0 })).toBe(null)
      expect(await rows(db)).toEqual([{ code: A, email: 'xan@x.y', redeemed: 1, user_id: 'xan' }])
      // Deleting the member leaves the place spent, and no way back in by it.
      await db.run(sql`delete from user where id = 'xan'`)
      expect(await rows(db)).toEqual([{ code: A, email: 'xan@x.y', redeemed: 1, user_id: null }])
      expect(await holdsInvite(db, { email: 'xan@x.y', now: T0 })).toBe(false)
      expect(await claimInvite(db, { email: 'xan@x.y', now: T0 })).toBe(null)
      expect(await claimByCode(db, { code: A, email: 'xan@x.y', now: T0 })).toBe(null)
      expect(await hold(db, A, 'xan@x.y')).toBe('used')
    })

    it('admits a claimed address again by any code that could admit it, spending nothing more', async () => {
      const db = await makeDb()
      await people(db, 'p', 'q')
      for (const code of [A, E]) await member(db, 'p', code)
      for (const code of [B, C, D]) await member(db, 'q', code)
      await revokeCode(db, { code: C, userId: 'q', now: T0 })
      await hold(db, A, 'nan@x.y')
      const claim = await claimInvite(db, { email: 'nan@x.y', now: T0 })
      expect(claim?.code).toBe(A)
      // The create failed, and the retry is a provider sign-in carrying q's code (or it raced the
      // code sign-in). A code that could not admit the address alone admits nothing.
      expect(await claimByCode(db, { code: C, email: 'nan@x.y', now: T0 })).toBe(null)
      expect(await claimByCode(db, { code: 'NOSUCH', email: 'nan@x.y', now: T0 })).toBe(null)
      expect(await claimByCode(db, { code: B, email: 'nan@x.y', now: T0 })).toEqual(claim)
      expect(await joined(db, 'nan')).toEqual([claim])
      // The other way round: a code sign-in after a provider's claim is admitted by that claim.
      await hold(db, D, 'mia@x.y')
      const carried = await claimByCode(db, { code: E, email: 'mia@x.y', now: T0 })
      expect(carried?.code).toBe(E)
      expect(await claimInvite(db, { email: 'mia@x.y', now: T0 })).toEqual(carried)
      expect(await joined(db, 'mia')).toEqual([carried])
      // q's codes kept their places.
      expect(await hold(db, B, 'o@x.y')).toBe('held')
      expect(await hold(db, D, 'o@x.y')).toBe('held')
      expect((await rows(db)).map((r) => [r.code, r.email, r.user_id])).toEqual([
        [A, 'nan@x.y', 'nan'],
        [E, 'mia@x.y', 'mia'],
        [B, 'o@x.y', null],
        [D, 'o@x.y', null],
      ])
    })

    it('claims by the code a provider sign-in carried, once per code and address', async () => {
      const db = await makeDb()
      await people(db, 'inviter', 'member')
      await member(db, 'inviter', A)
      await member(db, 'inviter', B)
      await createOperatorCode(db, { code: 'WELCOME', maxUses: 3, now: T0 })

      const first1 = await claimByCode(db, { code: A, email: 'P@x.y', now: T0 })
      expect(first1?.code).toBe(A)
      expect(await claimByCode(db, { code: A, email: 'p@x.y', now: T0 + MIN })).toEqual(first1)
      expect(await claimByCode(db, { code: A, email: 'q@x.y', now: T0 })).toBe(null)
      // The address's own hold on that code is the row it redeems.
      await hold(db, 'WELCOME', 'r@x.y')
      const [held] = await db.all<{ id: number }>(
        sql`select id from invite_redemptions where email = 'r@x.y'`,
      )
      expect((await claimByCode(db, { code: 'WELCOME', email: 'r@x.y', now: T0 }))?.id).toBe(
        held?.id,
      )
      // Revoked, unknown, or an address with an account: nothing.
      await revokeCode(db, { code: B, userId: 'inviter', now: T0 })
      expect(await claimByCode(db, { code: B, email: 's@x.y', now: T0 })).toBe(null)
      expect(await claimByCode(db, { code: 'NOSUCH', email: 's@x.y', now: T0 })).toBe(null)
      expect(await claimByCode(db, { code: 'WELCOME', email: 'member@x.y', now: T0 })).toBe(null)
      expect((await rows(db)).map((r) => [r.code, r.email, r.redeemed])).toEqual([
        [A, 'p@x.y', 1],
        ['WELCOME', 'r@x.y', 1],
      ])
      // What the sign-in asks before it sends anyone to the provider: places, and whether they
      // are taken. A hold takes none, so it never fills a code.
      await hold(db, 'WELCOME', 't@x.y')
      expect(await liveCode(db, 'WELCOME')).toEqual({ places: 3, full: false })
      for (const who of ['u', 'v']) {
        expect(await claimByCode(db, { code: 'WELCOME', email: `${who}@x.y`, now: T0 })).not.toBe(
          null,
        )
      }
      expect(await liveCode(db, 'WELCOME')).toEqual({ places: 3, full: true })
      expect(await liveCode(db, A)).toEqual({ places: 1, full: true })
      expect(await liveCode(db, B)).toBe(null)
      expect(await liveCode(db, 'NOSUCH')).toBe(null)
    })

    it('settles the member, and drops every hold the address still had', async () => {
      const db = await makeDb()
      await people(db, 'inviter')
      await member(db, 'inviter', A)
      await createOperatorCode(db, { code: 'WELCOME', maxUses: 5, now: T0 })
      await hold(db, A, 'zoe@x.y')
      await hold(db, 'WELCOME', 'zoe@x.y')
      await hold(db, 'WELCOME', 'w@x.y')
      await inviteAddress(db, { email: 'zoe@x.y', now: T0 })
      const claim = await claimInvite(db, { email: 'zoe@x.y', now: T0 })
      expect(await joined(db, 'zoe')).toEqual([claim])
      expect((await rows(db)).map((r) => [r.code, r.email, r.user_id])).toEqual([
        ['WELCOME', 'w@x.y', null],
        [null, 'zoe@x.y', 'zoe'],
      ])
      // The operator's invitation admitted her, so the code she also held has its place still.
      expect(await hold(db, A, 'w@x.y', T0 + MIN)).toBe('held')
      expect((await claimInvite(db, { email: 'w@x.y', now: T0 + MIN }))?.code).toBe(A)
    })

    it('keeps a member to five codes, unrevoked or used, and lists who joined by handle', async () => {
      const db = await makeDb()
      await people(db, 'inviter', 'other')
      for (const code of [A, B, C, D, E]) {
        expect(await member(db, 'inviter', code)).toEqual({ ok: true, code })
      }
      expect(await member(db, 'inviter', F)).toEqual({ ok: false, reason: 'allowance' })
      // Someone else's code taken already is a clash, worth another draw.
      expect(await member(db, 'other', A)).toEqual({ ok: false, reason: 'clash' })

      // A revoked unused code frees its place, and cancels its holds.
      await hold(db, A, 'gone@x.y')
      expect(await revokeCode(db, { code: A, userId: 'other', now: T0 })).toBe(false)
      expect(await revokeCode(db, { code: A, userId: 'inviter', now: T0 })).toBe(true)
      expect(await revokeCode(db, { code: A, userId: 'inviter', now: T0 })).toBe(false)
      expect(await holdsInvite(db, { email: 'gone@x.y', now: T0 })).toBe(false)
      expect(await hold(db, A, 'gone@x.y')).toBe('invalid')
      expect(await member(db, 'inviter', F, T0 + MIN)).toEqual({ ok: true, code: F })

      // A used code counts for good, and cannot be revoked.
      await hold(db, B, 'friend@x.y')
      await claimInvite(db, { email: 'friend@x.y', now: T0 })
      await joined(db, 'friend')
      await hold(db, C, 'pending@x.y')
      expect(await revokeCode(db, { code: B, userId: 'inviter', now: T0 })).toBe(false)
      expect(await member(db, 'inviter', 'G'.repeat(12))).toEqual({
        ok: false,
        reason: 'allowance',
      })
      expect(await listMemberCodes(db, 'inviter')).toEqual([
        { code: B, createdAt: T0, joinedAt: T0, handle: 'friend' },
        { code: C, createdAt: T0, joinedAt: null, handle: null },
        { code: D, createdAt: T0, joinedAt: null, handle: null },
        { code: E, createdAt: T0, joinedAt: null, handle: null },
        { code: F, createdAt: T0 + MIN, joinedAt: null, handle: null },
      ])

      const drawn = drawMemberCode()
      expect(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(drawn)).toBe(true)
      expect(drawMemberCode() === drawn).toBe(false)
    })

    it('lets the operator make, list and withdraw codes of their own, used or not', async () => {
      const db = await makeDb()
      await people(db, 'inviter')
      await member(db, 'inviter', A)
      expect(await createOperatorCode(db, { code: 'WELCOME', maxUses: 3, now: T0 })).toBe(true)
      expect(await createOperatorCode(db, { code: 'WELCOME', maxUses: 9, now: T0 })).toBe(false)
      expect(await createOperatorCode(db, { code: A, maxUses: 9, now: T0 })).toBe(false)
      await hold(db, 'WELCOME', 'one@x.y')
      await claimInvite(db, { email: 'one@x.y', now: T0 })
      await hold(db, 'WELCOME', 'two@x.y')
      await hold(db, 'WELCOME', 'old@x.y', T0 - 2 * DAY)
      expect(await listOperatorCodes(db, T0)).toEqual([
        { code: 'WELCOME', maxUses: 3, uses: 1, holds: 1, createdAt: T0, revokedAt: null },
      ])
      expect(await revokeOperatorCode(db, { code: A, now: T0 })).toBe(false)
      expect(await revokeOperatorCode(db, { code: 'WELCOME', now: T0 + MIN })).toBe(true)
      expect(await revokeOperatorCode(db, { code: 'WELCOME', now: T0 + MIN })).toBe(false)
      expect(await hold(db, 'WELCOME', 'three@x.y')).toBe('invalid')
      // Whoever joined keeps their place; the holds are gone.
      expect((await rows(db)).map((r) => [r.email, r.redeemed])).toEqual([['one@x.y', 1]])
      expect(await listOperatorCodes(db, T0)).toEqual([
        { code: 'WELCOME', maxUses: 3, uses: 1, holds: 0, createdAt: T0, revokedAt: T0 + MIN },
      ])
    })

    it('prunes holds a day past their expiry, and never a place', async () => {
      const db = await makeDb()
      await createOperatorCode(db, { code: 'WELCOME', maxUses: 5, now: T0 })
      await hold(db, 'WELCOME', 'stale@x.y', T0 - 3 * DAY)
      await hold(db, 'WELCOME', 'lapsed@x.y', T0 - DAY - HOUR)
      await hold(db, 'WELCOME', 'kept@x.y', T0 - 2 * DAY)
      await claimInvite(db, { email: 'kept@x.y', now: T0 - 2 * DAY })
      await inviteAddress(db, { email: 'op@x.y', now: T0 - 3 * DAY })
      const [pruned] = await db.batch([pruneInvites(db, T0)])
      expect(pruned).toHaveLength(2)
      expect((await rows(db)).map((r) => r.email)).toEqual(['lapsed@x.y', 'kept@x.y'])
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
