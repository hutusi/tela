/**
 * What Tela's own feeds are made of (ADR 0062): a public blogroll's listed blogs and their newest
 * posts, and Discover's. Rows are written here directly, as in `blogrolls-public.test.ts`; the
 * edge's rendering of them into RSS and OPML is tested in the reader (`edge.test.ts`).
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { PROFILE_CACHE, PUBLIC_CACHE } from '../src/routes/public'
import { DISCOVER_FEED_BLOGS, FEED_POSTS, type FeedPost } from '../src/routes/public-feeds'
import { createTestApi, type TestApi } from './helpers'

const ANNA = 'member-anna-0000001'
const BORIS = 'member-boris-000002'
const ROLL = 'Abc123def456'

let api: TestApi
let db: TelaDb
let now: number

type FeedBlog = { siteId: number; name: string | null; homeUrl: string; feedUrl: string }
type BlogrollFeed = {
  blogroll: { id: string; name: string; description: string; updatedAt: number }
  owner: { handle: string; displayName: string | null }
  blogs: FeedBlog[]
  posts: FeedPost[]
}
type DiscoverFeed = { topic: string | null; blogs: FeedBlog[]; posts: FeedPost[] }

async function write(...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

async function person(id: string, handle: string) {
  await write(
    db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
    db.run(sql`insert into profiles (user_id, handle, display_name, created_at, updated_at, seq)
      values (${id}, ${handle}, ${`Name ${handle}`}, 0, 0, ${currentSeq})`),
  )
}

/** A blog and its feed, both numbered `id`. */
async function blog(id: number, o: { listing?: string; optOut?: boolean; title?: string } = {}) {
  await write(
    db.run(sql`insert into sites (id, home_url, title, listing, translation_opt_out, created_at,
        updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${o.title ?? `Blog ${id}`},
        ${o.listing ?? 'listed'}, ${o.optOut ? 1 : 0}, 0, 0, ${currentSeq})`),
  )
  await feed(id, id)
}

async function feed(id: number, siteId: number, o: { mergedInto?: number } = {}) {
  await write(
    db.run(sql`insert into feeds (id, site_id, feed_url, host, status, merged_into, next_fetch_at,
        created_at, updated_at, seq)
      values (${id}, ${siteId}, ${`https://blog${siteId}.example/feed${id}`},
        ${`blog${siteId}.example`}, 'active', ${o.mergedInto ?? null}, 0, 0, 0, ${currentSeq})`),
  )
}

/** A post of feed `feedId`, `ago` ms old, in English unless told, with its title hash `h<id>`. */
async function post(
  id: number,
  feedId: number,
  o: { ago?: number; lang?: string; url?: string | null; title?: string } = {},
) {
  const url = o.url === undefined ? `https://post.example/${id}` : o.url
  await write(
    db.run(sql`insert into articles (id, feed_id, dedup_key, url, title, excerpt, source_lang,
        fetched_at, sort_at, title_hash, seq)
      values (${id}, ${feedId}, ${`k${id}`}, ${url}, ${o.title ?? `Post ${id}`},
        ${`Excerpt ${id}`}, ${o.lang ?? 'en'}, ${now}, ${now - (o.ago ?? id * 1000)}, ${`h${id}`},
        ${currentSeq})`),
  )
}

/** Post `id`'s title and excerpt in `lang`, made from its current title unless `stale`. */
async function translated(id: number, lang: string, title: string, o: { stale?: boolean } = {}) {
  await write(
    db.run(sql`insert into article_titles (article_id, lang, feed_id, title, excerpt, status,
        source_hash, updated_at, seq)
      values (${id}, ${lang}, (select feed_id from articles where id = ${id}), ${title},
        ${`${title} (excerpt)`}, 'done', ${o.stale ? 'old' : `h${id}`}, 0, ${currentSeq})`),
  )
}

async function blogroll(
  id: string,
  owner: string,
  feeds: number[],
  o: { isPublic?: boolean; hiddenAt?: number; deletedAt?: number } = {},
) {
  const isPublic = o.isPublic ?? true
  await write(
    db.run(sql`insert into blogrolls (id, user_id, name, description, is_public, public_version,
        public_since, hidden_at, created_at, updated_at, deleted_at, seq)
      values (${id}, ${owner}, 'Cities & <walks>', 'On foot.', ${isPublic ? 1 : 0}, 1,
        ${isPublic ? 1 : null}, ${o.hiddenAt ?? null}, 1, 1, ${o.deletedAt ?? null},
        ${currentSeq})`),
  )
  for (const [i, feedId] of feeds.entries()) {
    await write(
      db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, note_at, added_at,
          updated_at, seq)
        values (${id}, ${feedId}, ${owner}, 0, ${i + 1}, ${i + 1}, ${currentSeq})`),
    )
  }
}

const get = (path: string) => api.request(path)
async function rollFeed(id = ROLL): Promise<BlogrollFeed> {
  const res = await get(`/api/v1/public/feeds/blogrolls/${id}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe(PROFILE_CACHE)
  return (await res.json()) as BlogrollFeed
}
async function discoverFeed(query = ''): Promise<DiscoverFeed> {
  const res = await get(`/api/v1/public/feeds/discover${query}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe(PUBLIC_CACHE)
  return (await res.json()) as DiscoverFeed
}

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  now = api.clock.now()
  await person(ANNA, 'anna')
  await person(BORIS, 'boris')
})

describe("a blogroll's feeds", () => {
  test('carry its listed blogs in its order, by the feed a merge made them, and nothing else', async () => {
    await blog(1, { listing: 'featured' })
    await blog(2, { listing: 'private' })
    await blog(3, { listing: 'rejected' })
    await blog(4)
    // Feed 5 of blog 4 was merged into feed 4: its row resolves to feed 4, once.
    await feed(5, 4, { mergedInto: 4 })
    await blog(6)
    await feed(7, 6, { mergedInto: 6 })
    await blogroll(ROLL, ANNA, [4, 1, 2, 3, 5, 7])
    const data = await rollFeed()
    expect(data.blogroll).toEqual({
      id: ROLL,
      name: 'Cities & <walks>',
      description: 'On foot.',
      updatedAt: 6,
    })
    expect(data.owner).toEqual({ handle: 'anna', displayName: 'Name anna' })
    expect(data.blogs).toEqual([
      // Feeds 4 and 5 are one feed now, listed once, where it was first put in.
      {
        siteId: 4,
        name: 'Blog 4',
        homeUrl: 'https://blog4.example',
        feedUrl: 'https://blog4.example/feed4',
      },
      {
        siteId: 1,
        name: 'Blog 1',
        homeUrl: 'https://blog1.example',
        feedUrl: 'https://blog1.example/feed1',
      },
      {
        siteId: 6,
        name: 'Blog 6',
        homeUrl: 'https://blog6.example',
        feedUrl: 'https://blog6.example/feed6',
      },
    ])
  })

  test("carry the newest posts of its listed blogs' feeds, newest first, never a merged copy", async () => {
    await blog(1)
    await blog(2, { listing: 'private' })
    await blog(3)
    await feed(4, 3, { mergedInto: 3 })
    await blog(9)
    await blogroll(ROLL, ANNA, [1, 2, 4])
    await post(10, 1, { ago: 3000 })
    await post(11, 2, { ago: 1000 })
    await post(12, 3, { ago: 2000 })
    // The merged address's own copy of a post, and a post on a blog the blogroll does not hold.
    await post(13, 4, { ago: 500 })
    await post(14, 9, { ago: 100 })
    // Not before its date, and nothing a feed reader cannot link to.
    await post(15, 1, { ago: -60_000 })
    await post(16, 1, { ago: 50, url: null })
    await post(17, 1, { ago: 60, url: 'javascript:alert(1)' })
    const { posts } = await rollFeed()
    expect(posts.map((p) => p.id)).toEqual([12, 10])
    expect(posts[1]).toEqual({
      id: 10,
      url: 'https://post.example/10',
      title: 'Post 10',
      excerpt: 'Excerpt 10',
      sourceLang: 'en',
      sortAt: now - 3000,
      titles: {},
      excerpts: {},
      blog: {
        siteId: 1,
        name: 'Blog 1',
        homeUrl: 'https://blog1.example',
        feedUrl: 'https://blog1.example/feed1',
      },
    })
  })

  test(`carry at most ${FEED_POSTS} posts`, async () => {
    await blog(1)
    await blogroll(ROLL, ANNA, [1])
    for (let i = 1; i <= FEED_POSTS + 5; i++) await post(100 + i, 1, { ago: i * 1000 })
    const { posts } = await rollFeed()
    expect(posts).toHaveLength(FEED_POSTS)
    expect(posts[0]?.id).toBe(101)
  })

  test('are not found for a private, deleted, hidden or unknown blogroll, or a bad id', async () => {
    await blog(1)
    await blogroll('privateRoll1', ANNA, [1], { isPublic: false })
    await blogroll('deletedRoll1', ANNA, [1], { deletedAt: 5 })
    await blogroll('hiddenRoll01', ANNA, [1], { hiddenAt: 5 })
    for (const id of ['privateRoll1', 'deletedRoll1', 'hiddenRoll01', 'unknownRoll1', 'bad-id']) {
      const res = await get(`/api/v1/public/feeds/blogrolls/${id}`)
      expect(res.status).toBe(404)
      expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60')
    }
  })

  test('are not found once their owner is suspended or has left', async () => {
    await blog(1)
    await blogroll(ROLL, ANNA, [1])
    await blogroll('borisRoll001', BORIS, [1])
    await rollFeed()
    await db.run(sql`update profiles set suspended_at = 1 where user_id = ${ANNA}`)
    await db.run(sql`update profiles set deleted_at = 1 where user_id = ${BORIS}`)
    expect((await get(`/api/v1/public/feeds/blogrolls/${ROLL}`)).status).toBe(404)
    expect((await get('/api/v1/public/feeds/blogrolls/borisRoll001')).status).toBe(404)
  })
})

describe('translations in a feed', () => {
  test('come in every language a post has, current ones only, never for a blog that opted out', async () => {
    await blog(1)
    await blog(2, { optOut: true })
    await blogroll(ROLL, ANNA, [1, 2])
    await post(10, 1, { ago: 1000 })
    await post(11, 2, { ago: 2000 })
    await post(12, 1, { ago: 3000 })
    await translated(10, 'fr', 'Article 10')
    await translated(10, 'zh-Hans', '文章 10')
    await translated(10, 'zh-Hant', '文章 10（繁）')
    await translated(11, 'fr', 'Article 11')
    // Made from a title the post no longer has.
    await translated(12, 'fr', 'Ancien titre', { stale: true })
    const { posts } = await rollFeed()
    const byId = new Map(posts.map((p) => [p.id, p]))
    expect(byId.get(10)?.titles).toEqual({
      fr: 'Article 10',
      'zh-Hans': '文章 10',
      'zh-Hant': '文章 10（繁）',
    })
    expect(byId.get(10)?.excerpts.fr).toBe('Article 10 (excerpt)')
    expect(byId.get(11)?.titles).toEqual({})
    expect(byId.get(11)?.excerpts).toEqual({})
    expect(byId.get(12)?.titles).toEqual({})
  })
})

describe("Discover's feeds", () => {
  test('carry its public blogs as the Blogs tab orders them, each by its first live feed', async () => {
    await blog(1)
    await blog(2, { listing: 'featured' })
    await blog(3, { listing: 'private' })
    await blog(4, { listing: 'rejected' })
    // Blog 5's first feed was merged into its second: Subscribe adds the live one.
    await write(
      db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at, seq)
        values (5, 'https://blog5.example', 'Blog 5', 'listed', 0, 0, ${currentSeq})`),
    )
    await feed(51, 5)
    await feed(50, 5, { mergedInto: 51 })
    const { blogs, topic } = await discoverFeed()
    expect(topic).toBeNull()
    expect(blogs.map((b) => [b.siteId, b.feedUrl])).toEqual([
      [2, 'https://blog2.example/feed2'],
      [1, 'https://blog1.example/feed1'],
      [5, 'https://blog5.example/feed51'],
    ])
  })

  test('carry the newest public posts, and a topic narrows both', async () => {
    await blog(1)
    await blog(2)
    await blog(3, { listing: 'private' })
    await write(db.run(sql`insert into site_topics (site_id, topic) values (2, 'tech')`))
    await post(10, 1, { ago: 1000 })
    await post(11, 2, { ago: 2000 })
    await post(12, 3, { ago: 500 })
    expect((await discoverFeed()).posts.map((p) => p.id)).toEqual([10, 11])
    const tech = await discoverFeed('?topic=tech')
    expect(tech.topic).toBe('tech')
    expect(tech.blogs.map((b) => b.siteId)).toEqual([2])
    expect(tech.posts.map((p) => p.id)).toEqual([11])
    // A topic Tela does not have is no topic at all.
    expect((await discoverFeed('?topic=nope')).topic).toBeNull()
  })

  test(`list at most ${DISCOVER_FEED_BLOGS} blogs, what Tela's own import reads`, async () => {
    const values = Array.from(
      { length: DISCOVER_FEED_BLOGS + 3 },
      (_, i) => `(${1000 + i}, 'https://b${i}.example', 'listed', 0, 0, 0)`,
    ).join(', ')
    const feeds = Array.from(
      { length: DISCOVER_FEED_BLOGS + 3 },
      (_, i) =>
        `(${1000 + i}, ${1000 + i}, 'https://b${i}.example/feed', 'b${i}.example', 'active', 0, 0, 0, 0)`,
    ).join(', ')
    await write(
      db.run(
        sql.raw(`insert into sites (id, home_url, listing, created_at, updated_at, seq)
        values ${values}`),
      ),
      db.run(
        sql.raw(`insert into feeds (id, site_id, feed_url, host, status, next_fetch_at,
          created_at, updated_at, seq) values ${feeds}`),
      ),
    )
    expect((await discoverFeed()).blogs).toHaveLength(DISCOVER_FEED_BLOGS)
  })
})
