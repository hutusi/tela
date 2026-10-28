/**
 * The public side's shared reads (`core/public.ts`, ADR 0065): what the API pages by that the web
 * does not (a 1-based page, and whether there is more), and the writers' choices they keep.
 * Everything else they decide is held by the web's own public tests, which answer through them.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import {
  ARTICLES_PAGE,
  readDiscover,
  readSitePage,
  SEARCH_POSTS_PAGE,
  SITE_POSTS_PAGE,
  search,
} from '../src/core/public'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let db: TelaDb
let reader: SignedIn

/** What the reads need: the database and the clock. */
const deps = () => ({ db: api.db, clock: api.clock })

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  reader = await signedIn(api)
})

/** A listed blog `id` with `posts` posts, each titled `Post <n>`, the newest last. */
async function blog(id: number, posts: number, options: { optOut?: boolean } = {}) {
  const now = api.clock.now()
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, title, listing, translation_opt_out, created_at,
        updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${`Blog ${id}`}, 'listed',
        ${options.optOut ? 1 : 0}, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
        updated_at, seq)
      values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0, 0, 0,
        ${currentSeq})`),
    db.run(sql`insert into articles (feed_id, dedup_key, title, title_hash, fetched_at, sort_at,
        source_lang, content_key, seq)
      select ${id}, ${`b${id}-`} || j.value, 'Post ' || j.value, 'h' || j.value, 0,
        ${now} - 1000 * (${posts} - j.value), 'en', ${`c${id}-`} || j.value, ${currentSeq}
      from json_each(${JSON.stringify(Array.from({ length: posts }, (_, i) => i + 1))}) j`),
  ] as never)
}

describe('paging', () => {
  test("a blog's posts, a page at a time, say when there are more", async () => {
    await blog(1, SITE_POSTS_PAGE + 5)
    const first = await readSitePage(deps(), 1)
    expect([first?.posts.length, first?.more]).toEqual([SITE_POSTS_PAGE, true])
    const second = await readSitePage(deps(), 1, 2)
    expect([second?.posts.length, second?.more]).toEqual([5, false])
    expect(second?.posts[0]?.title).toBe('Post 5')
    expect(await readSitePage(deps(), 2)).toBe(null)
  })

  test('Articles pages by number where no cursor is given, the week only on the first', async () => {
    await blog(1, ARTICLES_PAGE + 2)
    const second = await readDiscover(deps(), 'articles', { page: 2 })
    expect(second.posts.map((p) => p.article.title)).toEqual(['Post 2', 'Post 1'])
    expect([second.recommended, second.next]).toEqual([[], null])
  })

  test('search pages its posts', async () => {
    await blog(1, SEARCH_POSTS_PAGE + 1)
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
      values (${reader.userId}, 1, 0, 0)`)
    const first = await search(deps(), reader, { q: 'Post' })
    expect([first.articles.length, first.more]).toEqual([SEARCH_POSTS_PAGE, true])
    const second = await search(deps(), reader, { q: 'Post', page: 2 })
    expect([second.articles.length, second.more]).toEqual([1, false])
  })
})

describe("a writer's choices", () => {
  test('search names no translated title of a blog that turned translation off', async () => {
    await blog(1, 1)
    await blog(2, 1, { optOut: true })
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
      values (${reader.userId}, 1, 0, 0), (${reader.userId}, 2, 0, 0)`)
    await db.run(sql`insert into article_titles (article_id, lang, feed_id, title, status,
        source_hash, updated_at)
      select a.id, 'fr', a.feed_id, 'Billet', 'done', a.title_hash, 0 from articles a`)
    const found = await search(deps(), reader, { q: 'Post', lang: 'fr' })
    const titles = Object.fromEntries(found.articles.map((a) => [a.feedId, a.translatedTitle]))
    expect(titles).toEqual({ 1: 'Billet', 2: null })
  })
})

describe('a blog read through overlapping feeds (ADR 0068)', () => {
  /**
   * Blog 1 read through two section feeds kept elsewhere, as Anthropic's are: Engineering (11),
   * added first with two posts, and Research (12) with three, one of them Engineering's too.
   */
  async function lab() {
    const now = api.clock.now()
    const feed = (id: number, name: string) =>
      db.run(sql`insert into feeds (id, site_id, feed_url, host, title, next_fetch_at, created_at,
          updated_at, seq)
        values (${id}, 1, ${`https://feeds.example/${name}.xml`}, 'feeds.example', ${name}, 0, 0, 0,
          ${currentSeq})`)
    const post = (feedId: number, ago: number, slug: string) =>
      db.run(sql`insert into articles (feed_id, dedup_key, url, title, title_hash, fetched_at,
          sort_at, source_lang, content_key, seq)
        values (${feedId}, ${slug}, ${`https://lab.example/research/${slug}`}, ${slug},
          ${`h-${slug}`}, 0, ${now - 1000 * ago}, 'en', ${`c${feedId}-${slug}`}, ${currentSeq})`)
    await db.batch([
      bumpSeq(db),
      db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at, seq)
        values (1, 'https://lab.example', 'Lab', 'listed', 0, 0, ${currentSeq})`),
      feed(11, 'engineering'),
      feed(12, 'research'),
      post(11, 5, 'source-control'),
      post(11, 4, 'agents'),
      post(12, 3, 'source-control'),
      post(12, 2, 'proteins'),
      post(12, 1, 'verification'),
    ] as never)
  }

  test('Subscribe adds the feed with the most posts, not the one a member added first', async () => {
    await lab()
    expect((await readSitePage(deps(), 1))?.feeds.map((f) => f.id)).toEqual([12, 11])
    const blogs = await readDiscover(deps(), 'blogs')
    expect(blogs.sites.map((s) => [s.id, s.feedId])).toEqual([[1, 12]])
    const found = await search(deps(), reader, { q: 'Lab' })
    expect(found.sites.map((s) => s.feedId)).toEqual([12])
  })

  test('a post both feeds hold is shown once, as the feed that stored it first has it', async () => {
    await lab()
    const shown = ['verification', 'proteins', 'agents', 'source-control']
    const page = await readSitePage(deps(), 1)
    expect(page?.posts.map((p) => p.title)).toEqual(shown)
    expect(page?.posts.at(-1)?.feedId).toBe(11)
    expect(page?.site.postsLast30d).toBe(4)
    const articles = await readDiscover(deps(), 'articles')
    expect(articles.posts.map((p) => p.article.title)).toEqual(shown)
    const card = (await readDiscover(deps(), 'blogs')).sites[0]
    expect(card?.postsLast30d).toBe(4)
  })
})
