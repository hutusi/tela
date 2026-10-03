/**
 * The front page's edition and the handle check (ADR 0035): what a visitor reads before they sign
 * in, and what For writers' card asks as a handle is typed.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { ACTION_LIMITS, bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { EDITION_POSTS, PROFILE_CACHE } from '../src/routes/public'
import { createTestApi, type TestApi } from './helpers'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let api: TestApi
let db: TelaDb
let now: number

type FrontPost = {
  article: {
    id: number
    feedId: number
    title: string
    sortAt: number
    sourceLang: string | null
    titles: Record<string, string>
    excerpts: Record<string, string>
  }
  site: {
    id: number
    title: string
    homeUrl: string
    faviconKey: string | null
    primaryLang: string | null
  }
  claimant: { handle: string; displayName: string | null } | null
}
type FrontData = {
  counts: { blogs: number }
  week: { blogs: number; languages: number; posts: number }
  edition: { span: 'week' | 'latest'; posts: FrontPost[] }
}

async function write(...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

/** A blog and its feed, both numbered `id`. */
async function blog(id: number, listing = 'listed', lang: string | null = 'en') {
  await write(
    db.run(sql`insert into sites (id, home_url, title, listing, primary_lang, created_at, updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${`Blog ${id}`}, ${listing}, ${lang}, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0, 0, 0, ${currentSeq})`),
  )
}

/** Another feed of blog `siteId`, merged into `mergedInto` if given (ADR 0028). */
async function feed(id: number, siteId: number, mergedInto: number | null = null) {
  await write(
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, status, merged_into,
        created_at, updated_at, seq)
      values (${id}, ${siteId}, ${`https://mirror${id}.example/feed`}, ${`mirror${id}.example`}, 0,
        ${mergedInto === null ? 'active' : 'paused'}, ${mergedInto}, 0, 0, ${currentSeq})`),
  )
}

let nextArticle = 1
/** A post on feed `feedId`, `ago` before now (negative: dated in the future). */
async function post(feedId: number, ago: number, lang: string | null = 'en') {
  const id = nextArticle++
  const at = now - ago
  await write(
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, excerpt, source_lang, fetched_at,
        sort_at, reading_minutes, seq)
      values (${id}, ${feedId}, ${`k${id}`}, ${`Post ${id}`}, ${`Excerpt ${id}`}, ${lang}, ${now},
        ${at}, 4, ${currentSeq})`),
  )
  return id
}

const front = async () => {
  const res = await api.request('/api/v1/public/front') // no session
  expect(res.status).toBe(200)
  return (await res.json()) as FrontData
}

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  now = api.clock.now()
  nextArticle = 1
})

describe('the front page', () => {
  test("each public blog's newest post this week, newest first, eleven at most", async () => {
    for (let id = 1; id <= 13; id++) await blog(id, id % 2 ? 'listed' : 'featured')
    // Blog 1's newest is on a second feed of its own; its older posts never show.
    await post(1, 6 * DAY)
    await post(1, 5 * HOUR)
    await feed(20, 1)
    const newest = await post(20, 1 * HOUR)
    for (let id = 2; id <= 13; id++) await post(id, id * HOUR)
    const body = await front()
    expect(body.edition.span).toBe('week')
    expect(body.edition.posts).toHaveLength(EDITION_POSTS)
    expect(body.edition.posts.map((p) => p.site.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(body.edition.posts[0]?.article.id).toBe(newest)
    const at = body.edition.posts.map((p) => p.article.sortAt)
    expect(at).toEqual([...at].sort((a, b) => b - a))
    expect(body.counts.blogs).toBe(13)
    // Every post of the week counts, not only each blog's newest.
    expect(body.week).toEqual({ blogs: 13, languages: 1, posts: 15 })
  })

  test('private, rejected and merged blogs and feeds stay out, and future posts wait', async () => {
    await blog(1, 'listed')
    await blog(2, 'private')
    await blog(3, 'rejected')
    const shown = await post(1, 2 * HOUR)
    await post(2, HOUR)
    await post(3, HOUR)
    // A mirror merged into blog 1's feed holds a newer copy, and blog 1 dated one for tomorrow.
    await feed(30, 1, 1)
    await post(30, HOUR)
    await post(1, -DAY)
    const body = await front()
    expect(body.edition.posts.map((p) => p.article.id)).toEqual([shown])
    expect(body.counts.blogs).toBe(1)
    expect(body.week).toEqual({ blogs: 1, languages: 1, posts: 1 })
  })

  test('counts the distinct blogs and languages that wrote this week, and their posts', async () => {
    await blog(1, 'listed', 'en')
    await blog(2, 'featured', 'zh-Hans')
    await blog(3, 'listed', 'ja')
    await blog(4, 'listed', 'es')
    await post(1, HOUR, 'en')
    await post(1, 2 * DAY, 'en')
    await post(1, 8 * DAY, 'en')
    // A blog may write in more than one language: languages are the posts', not the blogs'.
    await post(2, 3 * HOUR, 'zh-Hans')
    await post(2, 4 * HOUR, 'en')
    await post(3, 10 * DAY, 'ja')
    const body = await front()
    expect(body.counts).toEqual({ blogs: 4 })
    expect(body.week).toEqual({ blogs: 2, languages: 2, posts: 4 })
    expect(body.edition.span).toBe('week')
    expect(body.edition.posts.map((p) => p.site.id)).toEqual([1, 2])
  })

  test('the latest from each blog when nobody wrote this week', async () => {
    await blog(1)
    await blog(2)
    await blog(3)
    await post(1, 9 * DAY)
    await post(2, 8 * DAY)
    await post(1, 20 * DAY)
    const body = await front()
    expect(body.edition.span).toBe('latest')
    expect(body.edition.posts.map((p) => p.site.id)).toEqual([2, 1])
    expect(body.week).toEqual({ blogs: 0, languages: 0, posts: 0 })
    expect(body.counts.blogs).toBe(3)
  })

  test('nothing to show yet is an empty edition, not an error', async () => {
    const body = await front()
    expect(body).toEqual({
      counts: { blogs: 0 },
      week: { blogs: 0, languages: 0, posts: 0 },
      edition: { span: 'latest', posts: [] },
    })
  })

  test('a post carries its titles and excerpts, its blog and who claimed it', async () => {
    await blog(1)
    await blog(2, 'listed', 'ja')
    const claimed = await post(1, HOUR)
    const unclaimed = await post(2, 2 * HOUR, 'ja')
    await write(
      db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
        values ('writer-1', 'Writer', 'writer@x.test', 1, 0, 0)`),
      db.run(sql`insert into profiles (user_id, handle, display_name, created_at, updated_at, seq)
        values ('writer-1', 'writer', 'A Writer', 0, 0, ${currentSeq})`),
      db.run(
        sql`update sites set claimed_by = 'writer-1', favicon_key = 'favicons/1.png' where id = 1`,
      ),
      db.run(sql`insert into article_titles (article_id, lang, feed_id, title, excerpt, status,
          source_hash, updated_at, seq)
        values (${claimed}, 'zh-Hans', 1, '帖子', '摘要', 'done', 'h', 0, ${currentSeq}),
          (${unclaimed}, 'en', 2, 'A post', 'An excerpt', 'done', 'h', 0, ${currentSeq}),
          (${unclaimed}, 'zh-Hans', 2, '另一篇', null, 'done', 'h', 0, ${currentSeq})`),
    )
    const res = await api.request('/api/v1/public/front')
    expect(res.headers.get('cache-control')).toBe(PROFILE_CACHE)
    const [first, second] = ((await res.json()) as FrontData).edition.posts
    expect(first).toMatchObject({
      article: {
        id: claimed,
        title: `Post ${claimed}`,
        excerpt: `Excerpt ${claimed}`,
        readingMinutes: 4,
        titles: { 'zh-Hans': '帖子' },
        excerpts: { 'zh-Hans': '摘要' },
      },
      site: {
        id: 1,
        title: 'Blog 1',
        homeUrl: 'https://blog1.example',
        faviconKey: 'favicons/1.png',
        primaryLang: 'en',
      },
      claimant: { handle: 'writer', displayName: 'A Writer' },
    })
    expect(second).toMatchObject({
      article: {
        id: unclaimed,
        sourceLang: 'ja',
        titles: { en: 'A post', 'zh-Hans': '另一篇' },
        // A title translated without its excerpt has none to show.
        excerpts: { en: 'An excerpt' },
      },
      site: { id: 2, primaryLang: 'ja' },
      claimant: null,
    })
  })
})

describe('whether a handle is free', () => {
  type Check = { handle: string; status: string; suggestion: string | null }
  const check = async (handle: string, ip = '198.51.100.1') => {
    const res = await api.request(`/api/v1/public/handles/${encodeURIComponent(handle)}`, {
      headers: { 'cf-connecting-ip': ip },
    })
    expect(res.headers.get('cache-control')).toBe('no-store')
    return { status: res.status, body: (await res.json()) as Check }
  }
  async function taken(...handles: string[]) {
    for (const handle of handles) {
      const id = `member-${handle}`
      await write(
        db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
          values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
        db.run(sql`insert into profiles (user_id, handle, created_at, updated_at, seq)
          values (${id}, ${handle}, 0, 0, ${currentSeq})`),
      )
    }
  }

  test('a free handle is available, and suggests itself; capitals are read lowercase', async () => {
    expect((await check('hutusi')).body).toEqual({
      handle: 'hutusi',
      status: 'available',
      suggestion: 'hutusi',
    })
    expect((await check('HuTuSi')).body).toEqual({
      handle: 'hutusi',
      status: 'available',
      suggestion: 'hutusi',
    })
  })

  test('a taken handle suggests the first free one made from it', async () => {
    await taken('hutusi', 'hutusi1')
    expect((await check('hutusi')).body).toEqual({
      handle: 'hutusi',
      status: 'taken',
      suggestion: 'hutusi2',
    })
    await taken('anna', 'anna1', 'anna2', 'anna3', 'anna4', 'anna5', 'anna6', 'anna7', 'anna8')
    await taken('anna9')
    expect((await check('anna')).body.suggestion).toBe('anna_writes')
    await taken('anna_writes')
    expect((await check('anna')).body).toEqual({
      handle: 'anna',
      status: 'taken',
      suggestion: null,
    })
  })

  test('a suggestion is itself a valid handle', async () => {
    const long = 'x'.repeat(30)
    await taken(long)
    // Every suffix makes it longer than a handle may be.
    expect((await check(long)).body).toEqual({ handle: long, status: 'taken', suggestion: null })
    const almost = 'y'.repeat(29)
    await taken(almost)
    expect((await check(almost)).body.suggestion).toBe(`${almost}1`)
  })

  test('an app path is reserved, an impossible shape invalid, and neither suggests it', async () => {
    expect((await check('admin')).body).toEqual({
      handle: 'admin',
      status: 'reserved',
      suggestion: 'admin1',
    })
    for (const handle of ['ab', 'hu-tusi', 'x'.repeat(31), 'hü_tusi', 's']) {
      const { status, body } = await check(handle)
      expect(status).toBe(200)
      expect(body).toMatchObject({ status: 'invalid', suggestion: null })
    }
  })

  test('checks are limited per IP, and an invalid shape spends none', async () => {
    const window = Math.floor(now / (ACTION_LIMITS.handleCheck.windowSec * 1000))
    await db.run(sql`insert into action_limits (key, window_start, count)
      values ('handleCheck:203.0.113.5', ${window * ACTION_LIMITS.handleCheck.windowSec * 1000},
        ${ACTION_LIMITS.handleCheck.limit - 1})`)
    expect((await check('hutusi', '203.0.113.5')).status).toBe(200)
    expect((await check('ab', '203.0.113.5')).status).toBe(200)
    const refused = await check('hutusi', '203.0.113.5')
    expect(refused.status).toBe(429)
    expect(refused.body).toEqual({ error: 'rate_limited' } as never)
    expect((await check('hutusi', '203.0.113.6')).status).toBe(200)
  })
})
