/**
 * What search engines may index (ADR 0060): each public answer says whether its page may be
 * (`indexable`), and the sitemap's data lists exactly those pages, by the same rules. Rows are
 * written directly; the actions that write them have their own tests.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { PROFILE_INDEX_AFTER } from '../src/routes/public-sql'
import { SITEMAP_CACHE, SITEMAP_PAGE } from '../src/routes/sitemap'
import { createTestApi, type TestApi } from './helpers'

const DAY = 24 * 60 * 60 * 1000

let api: TestApi
let db: TelaDb
let now: number

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  now = api.clock.now()
})

async function write(...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

/** A member and their profile, made `age` ago. */
async function member(
  id: string,
  handle: string,
  age: number,
  standing: 'ok' | 'suspended' = 'ok',
) {
  await write(
    db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
    db.run(sql`insert into profiles (user_id, handle, created_at, updated_at, suspended_at, seq)
      values (${id}, ${handle}, ${now - age}, ${now - age},
        ${standing === 'suspended' ? now : null}, ${currentSeq})`),
  )
}

/** A blog and its feed, both numbered `id`. */
async function blog(
  id: number,
  o: { listing?: string; review?: string | null; claimedBy?: string; lastItemAt?: number } = {},
) {
  await write(
    db.run(sql`insert into sites (id, home_url, title, listing, review, claimed_by, primary_lang,
        created_at, updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${`Blog ${id}`}, ${o.listing ?? 'listed'},
        ${o.review === undefined ? 'listed' : o.review}, ${o.claimedBy ?? null}, 'en', 0, 100,
        ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, last_item_at, next_fetch_at,
        created_at, updated_at, seq)
      values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`},
        ${o.lastItemAt ?? null}, 0, 0, 0, ${currentSeq})`),
  )
}

/** A public blogroll of `owner`'s holding blogs `feeds`. */
async function blogroll(id: string, owner: string, feeds: number[], hidden = false) {
  await write(
    db.run(sql`insert into blogrolls (id, user_id, name, is_public, public_version, public_since,
        hidden_at, created_at, updated_at, seq)
      values (${id}, ${owner}, ${`Roll ${id}`}, 1, 1, 1, ${hidden ? now : null}, 1, 500,
        ${currentSeq})`),
    ...feeds.map((feedId, i) =>
      db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, added_at, updated_at,
          seq)
        values (${id}, ${feedId}, ${owner}, ${i + 1}, ${i + 1}, ${currentSeq})`),
    ),
  )
}

const json = async <T>(path: string): Promise<T> => {
  const res = await api.request(path)
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

describe('a public answer says whether its page may be indexed', () => {
  test('a blog, once an operator listed it: a claim alone is not a review', async () => {
    await member('member-ana-00000001', 'ana', 30 * DAY)
    await blog(1)
    await blog(2, { listing: 'featured' })
    await blog(3, { review: null, claimedBy: 'member-ana-00000001' })
    await blog(4, { review: 'dismissed', claimedBy: 'member-ana-00000001' })
    const indexable = async (id: number) =>
      (await json<{ site: { indexable: boolean } }>(`/api/v1/public/sites/${id}`)).site.indexable
    expect(await indexable(1)).toBe(true)
    expect(await indexable(2)).toBe(true)
    expect(await indexable(3)).toBe(false)
    expect(await indexable(4)).toBe(false)
  })

  test('a profile, once its account is a week old and in good standing', async () => {
    await member('member-old-00000001', 'old', PROFILE_INDEX_AFTER)
    await member('member-new-00000001', 'new', PROFILE_INDEX_AFTER - 1)
    await member('member-bad-00000001', 'bad', 30 * DAY, 'suspended')
    const indexable = async (handle: string) => {
      const res = await api.request(`/api/v1/public/profiles/${handle}`)
      if (res.status === 404) return null
      return ((await res.json()) as { profile: { indexable: boolean } }).profile.indexable
    }
    expect(await indexable('old')).toBe(true)
    expect(await indexable('new')).toBe(false)
    // Suspended: not indexed, if it is shown at all (ADR 0059 hides it).
    expect(await indexable('bad')).not.toBe(true)
  })

  test('a blogroll, once Discover shows it and its owner is a week old', async () => {
    await member('member-ana-00000001', 'ana', 30 * DAY)
    await member('member-new-00000001', 'new', PROFILE_INDEX_AFTER - 1)
    for (const id of [1, 2, 3]) await blog(id)
    await blogroll('rollFULLabcd', 'member-ana-00000001', [1, 2, 3])
    await blogroll('rollTHINabcd', 'member-ana-00000001', [1, 2])
    await blogroll('rollHIDEabcd', 'member-ana-00000001', [1, 2, 3], true)
    // A new account's blogroll waits as its profile does: making one skips no week.
    await blogroll('rollNEWWabcd', 'member-new-00000001', [1, 2, 3])
    const indexable = async (id: string) =>
      (await json<{ blogroll: { indexable: boolean } }>(`/api/v1/public/blogrolls/${id}`)).blogroll
        .indexable
    expect(await indexable('rollFULLabcd')).toBe(true)
    expect(await indexable('rollTHINabcd')).toBe(false)
    expect(await indexable('rollHIDEabcd')).toBe(false)
    expect(await indexable('rollNEWWabcd')).toBe(false)
  })
})

describe("a public answer says which blogs' links are followed", () => {
  test('a post names whether an operator listed its blog, wherever it is shown', async () => {
    await member('member-ana-00000001', 'ana', 30 * DAY)
    await blog(1)
    await blog(3, { review: null, claimedBy: 'member-ana-00000001' })
    for (const id of [1, 3]) {
      await write(
        db.run(sql`insert into articles (id, feed_id, dedup_key, url, title, source_lang,
            fetched_at, sort_at, seq)
          values (${id}, ${id}, ${`k${id}`}, ${`https://blog${id}.example/${id}`}, ${`Post ${id}`},
            'en', ${now - id}, ${now - id}, ${currentSeq})`),
        db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at)
          values ('member-ana-00000001', ${id}, 'Good', ${now - id}, ${now - id})`),
      )
    }
    type Posted = { article: { id: number }; site: { vouched: boolean } }
    const vouched = (posts: Posted[]) =>
      Object.fromEntries(posts.map((p) => [p.article.id, p.site.vouched]))
    const front = await json<{ edition: { posts: Posted[] } }>('/api/v1/public/front')
    expect(vouched(front.edition.posts)).toEqual({ 1: true, 3: false })
    const articles = await json<{ posts: Posted[] }>('/api/v1/public/discover/articles')
    expect(vouched(articles.posts)).toEqual({ 1: true, 3: false })
    const week = await json<{ recommended: Posted[]; edition: { posts: Posted[] } }>(
      '/api/v1/public/discover/week',
    )
    expect(vouched(week.recommended)).toEqual({ 1: true, 3: false })
    expect(vouched(week.edition.posts)).toEqual({ 1: true, 3: false })
    const profile = await json<{
      recommendations: { article: { id: number }; vouched: boolean }[]
    }>('/api/v1/public/profiles/ana')
    expect(
      Object.fromEntries(profile.recommendations.map((r) => [r.article.id, r.vouched])),
    ).toEqual({ 1: true, 3: false })
  })
})

type Summary = Record<'sites' | 'blogrolls' | 'profiles', { count: number; lastmod: number | null }>
type Items = { kind: string; page: number; items: Record<string, unknown>[] }

describe("the sitemap's data", () => {
  beforeEach(async () => {
    await member('member-ana-00000001', 'ana', 30 * DAY)
    await member('member-new-00000001', 'new', DAY)
    await blog(1, { lastItemAt: 5000 })
    await blog(2)
    await blog(3, { review: null, claimedBy: 'member-ana-00000001' })
    await blog(4, { listing: 'private', review: null })
    await blog(5, { listing: 'rejected', review: 'dismissed' })
    await blogroll('rollFULLabcd', 'member-ana-00000001', [1, 2, 3])
    await blogroll('rollTHINabcd', 'member-ana-00000001', [1])
    await blogroll('rollNEWWabcd', 'member-new-00000001', [1, 2, 3])
  })

  test('counts the pages that may be indexed, and when each kind last changed', async () => {
    const res = await api.request('/api/v1/public/sitemap')
    expect(res.headers.get('cache-control')).toBe(SITEMAP_CACHE)
    const summary = (await res.json()) as Summary & { pageSize: number }
    expect(summary).toEqual({
      pageSize: SITEMAP_PAGE,
      sites: { count: 2, lastmod: 5000 },
      blogrolls: { count: 1, lastmod: 500 },
      profiles: { count: 1, lastmod: now - 30 * DAY },
    })
  })

  test('lists them a file at a time, in a fixed order, and nothing else', async () => {
    expect(await json<Items>('/api/v1/public/sitemap/sites')).toEqual({
      kind: 'sites',
      page: 1,
      items: [
        { id: 1, lastmod: 5000 },
        { id: 2, lastmod: 100 },
      ],
    })
    expect((await json<Items>('/api/v1/public/sitemap/blogrolls')).items).toEqual([
      { id: 'rollFULLabcd', lastmod: 500 },
    ])
    expect((await json<Items>('/api/v1/public/sitemap/profiles?page=1')).items).toEqual([
      { handle: 'ana', lastmod: now - 30 * DAY },
    ])
    expect((await json<Items>('/api/v1/public/sitemap/sites?page=2')).items).toEqual([])
    for (const path of ['/api/v1/public/sitemap/feeds', '/api/v1/public/sitemap/sites?page=0']) {
      expect((await api.request(path)).status).toBe(404)
    }
  })
})
