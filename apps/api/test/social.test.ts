/**
 * The Following feed, the readers you follow on a blog, and "Your data" (ADR 0031): what the
 * people a member follows did, only as far as each of them chose to show it.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { PAGE_ENTRIES } from '../src/routes/social'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

const DAY = 24 * 60 * 60 * 1000
const ANNA = 'member-anna-0000001'
const BORIS = 'member-boris-000002'
const CLEO = 'member-cleo-0000003'

let api: TestApi
let db: TelaDb
let me: SignedIn
let now: number

type Person = { id: string; handle: string; displayName: string | null }
type Post = {
  siteId: number
  listed: boolean
  translatedTitle: string | null
  article: { id: number }
}
type Item =
  | { kind: 'recommended'; at: number; person: Person; note: string | null; post: Post }
  | { kind: 'liked'; at: number; person: Person; count: number; posts: Post[] }
  | {
      kind: 'subscribed'
      at: number
      person: Person
      count: number
      sites: { id: number; feedId: number }[]
    }
type Feed = { items: Item[]; next: string | null; suggested: (Person & { bio: string | null })[] }

async function write(...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

/** A member who never signs in here, and what they choose to show. */
async function person(id: string, handle: string, show: { likes?: boolean; subs?: boolean } = {}) {
  await write(
    db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
    db.run(sql`insert into profiles (user_id, handle, display_name, bio, public_likes,
        public_subscriptions, created_at, updated_at, seq)
      values (${id}, ${handle}, ${`Name ${handle}`}, ${`Bio of ${handle}`}, ${show.likes ? 1 : 0},
        ${show.subs ? 1 : 0}, 0, 0, ${currentSeq})`),
  )
}

async function blog(id: number, listing = 'listed') {
  await write(
    db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${`Blog ${id}`}, ${listing}, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0, 0, 0, ${currentSeq})`),
  )
}

let nextArticle = 1
async function article(feedId: number) {
  const id = nextArticle++
  await write(
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, seq)
      values (${id}, ${feedId}, ${`k${id}`}, ${`Post ${id}`}, ${now}, ${now}, ${currentSeq})`),
  )
  return id
}

const recommend = (who: string, articleId: number, at: number, note: string | null = null) =>
  write(
    db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at, seq)
      values (${who}, ${articleId}, ${note}, ${at}, ${at}, ${currentSeq})`),
  )
const like = (who: string, articleId: number, at: number) =>
  write(
    db.run(sql`insert into user_article_states (user_id, article_id, read_at, liked_at, liked_updated_at, seq)
      values (${who}, ${articleId}, ${at}, ${at}, ${at}, ${currentSeq})`),
  )
const subscribe = (who: string, feedId: number, at: number) =>
  write(
    db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, seq)
      values (${who}, ${feedId}, ${at}, ${at}, ${currentSeq})`),
  )

const push = (mutations: Record<string, unknown>[], as = me) =>
  api.request('/api/v1/mutations', {
    body: {
      mutations: mutations.map((m, i) => ({ mid: `social-${i}-${Math.random()}`, at: now, ...m })),
    },
    as,
  })
const follow = (...ids: string[]) => push(ids.map((userId) => ({ type: 'follow', userId })))

async function feed(query = '') {
  const res = await api.request(`/api/v1/following${query}`, { as: me })
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  return (await res.json()) as Feed
}

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  now = api.clock.now()
  nextArticle = 1
  me = await signedIn(api, 'me@x.test')
  await person(ANNA, 'anna', { likes: true, subs: true })
  await person(BORIS, 'boris')
  await person(CLEO, 'cleo', { likes: true, subs: true })
  await blog(1)
  await blog(2)
  await blog(3, 'private')
})

describe('the Following feed', () => {
  test('merges what the people I follow recommended, liked and subscribed to, newest first', async () => {
    const a = await article(1)
    const b = await article(2)
    await follow(ANNA, BORIS)
    await recommend(ANNA, a, now - 3 * 60_000, 'the last line')
    await like(ANNA, a, now - 2 * 60_000)
    await like(ANNA, b, now - 1 * 60_000)
    await subscribe(ANNA, 2, now - 60 * 60_000)
    await recommend(BORIS, b, now - 30 * 60_000)
    const { items } = await feed()
    expect(items.map((i) => [i.kind, i.person.handle])).toEqual([
      ['liked', 'anna'],
      ['recommended', 'anna'],
      ['recommended', 'boris'],
      ['subscribed', 'anna'],
    ])
    const liked = items[0] as Extract<Item, { kind: 'liked' }>
    expect(liked.count).toBe(2)
    expect(liked.posts.map((p) => p.article.id)).toEqual([b, a])
    expect(items[1]).toMatchObject({
      note: 'the last line',
      post: { article: { id: a }, listed: true },
    })
    expect(items[3]).toMatchObject({ count: 1, sites: [{ id: 2, feedId: 2 }] })
  })

  test('shows likes and subscriptions only of people who show them, and only listed blogs', async () => {
    const a = await article(1)
    await follow(BORIS, CLEO)
    await like(BORIS, a, now - 60_000) // Boris keeps his likes private
    await subscribe(BORIS, 1, now - 60_000) // and his subscriptions
    await subscribe(CLEO, 3, now - 60_000) // a private blog, even shown
    await subscribe(CLEO, 1, now - 120_000)
    const { items } = await feed()
    expect(items.map((i) => [i.kind, i.person.handle])).toEqual([['subscribed', 'cleo']])
    expect((items[0] as Extract<Item, { kind: 'subscribed' }>).sites.map((s) => s.id)).toEqual([1])
  })

  test('nothing from people I do not follow, or no longer follow', async () => {
    const a = await article(1)
    await recommend(CLEO, a, now - 60_000, 'not followed')
    await follow(ANNA)
    await recommend(ANNA, a, now - 60_000, 'followed')
    expect((await feed()).items).toHaveLength(1)
    await push([{ type: 'unfollow', userId: ANNA }])
    expect((await feed()).items).toEqual([])
  })

  test('the tabs keep to their kind', async () => {
    const a = await article(1)
    await follow(ANNA)
    await recommend(ANNA, a, now - 60_000)
    await like(ANNA, a, now - 60_000)
    await subscribe(ANNA, 1, now - 60_000)
    expect((await feed('?tab=recs')).items.map((i) => i.kind)).toEqual(['recommended'])
    expect((await feed('?tab=likes')).items.map((i) => i.kind)).toEqual(['liked'])
  })

  test('a day is the viewer’s local day, whatever UTC says', async () => {
    const a = await article(1)
    const b = await article(2)
    await follow(ANNA)
    // 23:30 and 00:30 UTC either side of yesterday's midnight: two UTC days, one day in UTC−3.
    const midnight = Math.floor(now / DAY) * DAY - DAY
    await like(ANNA, a, midnight - 30 * 60_000)
    await like(ANNA, b, midnight + 30 * 60_000)
    expect((await feed()).items.map((i) => (i as { count: number }).count)).toEqual([1, 1])
    expect((await feed('?tz=-180')).items.map((i) => (i as { count: number }).count)).toEqual([2])
  })

  /** Every page of the feed, following each `next`; it must end, and each page move on. */
  async function everyPage(query = '') {
    const pages: Feed[] = []
    let cursor: string | null = null
    for (let i = 0; i < 50; i++) {
      const page: Feed = await feed(
        `?${new URLSearchParams({ ...(cursor ? { cursor } : {}), ...Object.fromEntries(new URLSearchParams(query)) })}`,
      )
      pages.push(page)
      if (page.next === null) return pages
      expect(page.items).toHaveLength(PAGE_ENTRIES) // a page is short only when it is the last
      cursor = page.next
    }
    throw new Error('the feed never ended')
  }
  const keyOf = (i: Item) =>
    `${i.kind}:${i.person.id}:${i.at}:${'post' in i ? i.post.article.id : ''}`

  test('activity of any age is on the first page when it is the newest there is', async () => {
    const recent = await article(1)
    const old = await article(1)
    await follow(ANNA)
    await recommend(ANNA, recent, now - 2 * DAY)
    await recommend(ANNA, old, now - 400 * DAY) // more than a year of nothing between
    const first = await feed()
    expect(first.items.map((i) => (i as { post: Post }).post.article.id)).toEqual([recent, old])
    expect(first.next).toBeNull()
  })

  test('pages by count, newest first, with nothing twice and nothing skipped', async () => {
    await follow(ANNA, CLEO)
    const recs: number[] = []
    for (let i = 0; i < 70; i++) {
      const id = await article(1)
      recs.push(id)
      await recommend(i % 2 ? ANNA : CLEO, id, now - i * 37 * 60_000) // one every 37 minutes
    }
    // Anna liked 7 posts one afternoon, between the recommendations.
    const liked: number[] = []
    for (let i = 0; i < 7; i++) {
      const id = await article(2)
      liked.push(id)
      await like(ANNA, id, now - 20 * 60 * 60_000 - i * 60_000)
    }
    const pages = await everyPage()
    const items = pages.flatMap((p) => p.items)
    expect(new Set(items.map(keyOf)).size).toBe(items.length)
    const seenRecs = items.flatMap((i) => (i.kind === 'recommended' ? [i.post.article.id] : []))
    expect(seenRecs.sort((x, y) => x - y)).toEqual(recs)
    // The day's likes are one entry, whole, on one page, placed at the newest of them.
    const days = items.filter((i) => i.kind === 'liked')
    expect(days).toHaveLength(1)
    expect(days[0]).toMatchObject({ count: 7, at: now - 20 * 60 * 60_000 })
    expect((days[0] as Extract<Item, { kind: 'liked' }>).posts).toHaveLength(5)
    // Newest first across the pages.
    const times = items.map((i) => i.at)
    expect([...times].sort((x, y) => y - x)).toEqual(times)
  })

  test('a busy day pages through, and entries at the same moment are split without loss', async () => {
    await follow(ANNA)
    const ids: number[] = []
    for (let i = 0; i < 2 * PAGE_ENTRIES + 7; i++) {
      const id = await article(1)
      ids.push(id)
      // One morning, and the first 40 in the very same millisecond.
      await recommend(ANNA, id, i < 40 ? now - 60_000 : now - 60_000 - i)
    }
    const pages = await everyPage()
    expect(pages).toHaveLength(3)
    const seen = pages.flatMap((p) => p.items).map((i) => (i as { post: Post }).post.article.id)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.sort((x, y) => x - y)).toEqual(ids)
  })

  test('a walk keeps the day grouping it started with, whatever the clock says next', async () => {
    const a = await article(1)
    const b = await article(2)
    await follow(ANNA)
    // A like just after a UTC midnight: today in UTC+8, still yesterday in UTC.
    const midnight = Math.floor(now / DAY) * DAY
    await like(ANNA, a, midnight + 60_000)
    await recommend(ANNA, b, midnight - 60_000)
    const first = await feed('?tz=480')
    const group = first.items[0] as Item & { key: string }
    expect(group.kind).toBe('liked')
    // The next page is asked for after the device's offset changed (a DST change, a flight).
    const cursor = `${group.at}:480:${group.key}`
    const next = await feed(`?tz=-300&cursor=${encodeURIComponent(cursor)}`)
    expect(next.items.map((i) => i.kind)).toEqual(['recommended'])
  })

  test('a malformed cursor is the first page', async () => {
    const a = await article(1)
    await follow(ANNA)
    await recommend(ANNA, a, now - 60_000)
    const page = await feed('?cursor=nonsense')
    expect(page.items).toHaveLength(1)
    expect(page.suggested).toBeDefined()
  })

  test('suggests readers from public signals only, never myself or someone I follow', async () => {
    const a = await article(1)
    await push([{ type: 'subscribe', feedId: 1 }])
    await follow(ANNA)
    await recommend(ANNA, a, now - 60_000) // followed already
    await recommend(CLEO, a, now - 60_000) // recommends what I read
    await subscribe(BORIS, 1, now - 60_000) // reads what I read, privately: not a signal
    const { suggested } = await feed()
    expect(suggested.map((p) => p.handle)).toEqual(['cleo'])
    expect(suggested[0]).toMatchObject({ id: CLEO, bio: 'Bio of cleo' })
  })
})

describe('the readers I follow, on a blog', () => {
  test('are the followees who show their subscriptions to it', async () => {
    await follow(ANNA, BORIS)
    await subscribe(ANNA, 1, now)
    await subscribe(BORIS, 1, now) // private subscriptions
    await subscribe(CLEO, 1, now) // not followed
    const res = await api.request('/api/v1/sites/1/followed-readers', { as: me })
    expect(await res.json()).toEqual({
      readers: [{ id: ANNA, handle: 'anna', displayName: 'Name anna' }],
    })
  })
})

describe('your data', () => {
  test("is the member's own rows, as a file, and nobody else's", async () => {
    const a = await article(1)
    await push([
      { type: 'subscribe', feedId: 1 },
      { type: 'setLiked', articleId: a, liked: true },
      { type: 'recommend', articleId: a, note: 'mine' },
      { type: 'follow', userId: ANNA },
      { type: 'setPref', key: 'reader.size', value: 'l' },
    ])
    await recommend(CLEO, a, now, 'not mine')
    const res = await api.request('/api/v1/export', { as: me })
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="tela-/)
    const body = (await res.json()) as Record<string, unknown[]>
    expect(body.subscriptions).toMatchObject([{ feedUrl: 'https://blog1.example/feed' }])
    expect(body.likes).toMatchObject([{ title: `Post ${a}` }])
    expect(body.recommendations).toMatchObject([{ note: 'mine' }])
    expect(body.following).toMatchObject([{ handle: 'anna' }])
    expect(body.prefs).toEqual([{ key: 'reader.size', value: 'l' }])
    expect(JSON.stringify(body)).not.toContain('not mine')
    expect(JSON.stringify(body)).not.toContain('anna@x.test')
  })
})
