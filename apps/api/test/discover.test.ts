/**
 * Discover's This week, Articles and Readers (ADR 0044): public answers, the same for everyone,
 * which the device personalizes from its own rows. What they may show is what the public answers
 * already show: listed and featured blogs, live feeds, posts whose date has come, public
 * recommendations, and subscriptions only of people who show them.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import {
  ARTICLES_PAGE,
  EARLY_MIN,
  NEW_BLOGS,
  RECOMMENDERS_SHOWN,
  RECS_IN_WEEK,
  WEEK_POSTS,
} from '../src/routes/discover'
import { PROFILE_CACHE, PUBLIC_CACHE } from '../src/routes/public'
import { createTestApi, signedIn, type TestApi } from './helpers'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let api: TestApi
let db: TelaDb
let now: number

type Person = { id: string; handle: string; displayName: string | null; avatar: string | null }
type PostSite = {
  id: number
  title: string | null
  homeUrl: string
  faviconKey: string | null
  primaryLang: string | null
  claimed: boolean
}
type Article = {
  id: number
  feedId: number
  title: string
  sortAt: number
  sourceLang: string | null
  titles: Record<string, string>
  excerpts?: Record<string, string>
}
type DiscoverPost = {
  article: Article
  site: PostSite
  weekRecs: number
  recommenders: string[]
  note: { text: string; person: Person } | null
}
type Site = { id: number; claimed: boolean; readerCount: number | null; topics: string[] }
type ReaderPost = { article: Article; site: PostSite }
type Reader = Person & {
  bio: string | null
  recs: [number, number][]
  sites: number[] | null
  recent: number
  withNote: number
  total: number
  early: (ReaderPost & { others: number }) | null
  sample: (ReaderPost & { note: string }) | null
}
type WeekData = {
  since: number
  recommended: DiscoverPost[]
  edition: { span: 'week' | 'latest'; posts: DiscoverPost[] }
  newBlogs: Site[]
  readers: Reader[]
}
type ArticlesData = {
  recommended: DiscoverPost[]
  posts: DiscoverPost[]
  next: string | null
  languages: { lang: string; count: number }[]
}

async function write(...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

/** A member who never signs in here, and whether they show what they read. */
async function person(id: string, handle: string, show: { subs?: boolean } = {}) {
  await write(
    db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
    db.run(sql`insert into profiles (user_id, handle, display_name, bio, public_subscriptions,
        created_at, updated_at, seq)
      values (${id}, ${handle}, ${`Name ${handle}`}, ${`Bio of ${handle}`}, ${show.subs ? 1 : 0},
        0, 0, ${currentSeq})`),
  )
}

type BlogOptions = {
  listing?: string
  lang?: string | null
  /** Who added its feed; none is a curated pick. */
  addedBy?: string | null
  claimedBy?: string | null
  claimedAt?: number | null
  createdAt?: number
  readers?: number
}

/** A blog and its feed, both numbered `id`. */
async function blog(id: number, o: BlogOptions = {}) {
  await write(
    db.run(sql`insert into sites (id, home_url, title, listing, primary_lang, claimed_by, claimed_at,
        reader_count, review, reviewed_at, created_at, updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${`Blog ${id}`}, ${o.listing ?? 'listed'},
        ${o.lang === undefined ? 'en' : o.lang}, ${o.claimedBy ?? null}, ${o.claimedAt ?? null},
        ${o.readers ?? 0}, 'listed', ${now}, ${o.createdAt ?? 0}, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, added_by, created_at,
        updated_at, seq)
      values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0,
        ${o.addedBy ?? null}, 0, 0, ${currentSeq})`),
  )
}

/** Another feed of blog `siteId`, merged into `mergedInto` (ADR 0028). */
async function mergedFeed(id: number, siteId: number, mergedInto: number) {
  await write(
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, status, merged_into,
        created_at, updated_at, seq)
      values (${id}, ${siteId}, ${`https://mirror${id}.example/feed`}, ${`mirror${id}.example`}, 0,
        'paused', ${mergedInto}, 0, 0, ${currentSeq})`),
  )
}

let nextArticle = 1
/** A post on feed `feedId`, `ago` before now (negative: dated in the future). */
async function post(feedId: number, ago: number, lang: string | null = 'en') {
  const id = nextArticle++
  await write(
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, excerpt, source_lang, fetched_at,
        sort_at, seq)
      values (${id}, ${feedId}, ${`k${id}`}, ${`Post ${id}`}, ${`Excerpt ${id}`}, ${lang}, ${now},
        ${now - ago}, ${currentSeq})`),
  )
  return id
}

/** A recommendation, made `ago` before now as its device says; ids go up in the order made. */
const recommend = (who: string, articleId: number, ago = HOUR, note: string | null = null) =>
  write(
    db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at, seq)
      values (${who}, ${articleId}, ${note}, ${now - ago}, ${now - ago}, ${currentSeq})`),
  )
const unrecommend = (who: string, articleId: number) =>
  write(
    db.run(sql`update recommendations set deleted_at = ${now}, seq = ${currentSeq}
      where user_id = ${who} and article_id = ${articleId}`),
  )
const subscribe = (who: string, feedId: number) =>
  write(
    db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, seq)
      values (${who}, ${feedId}, 0, 0, ${currentSeq})`),
  )

async function get<T>(path: string): Promise<T> {
  const res = await api.request(`/api/v1/public/discover${path}`) // no session
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe(PROFILE_CACHE)
  return (await res.json()) as T
}
const week = () => get<WeekData>('/week')
const articles = (query = '') => get<ArticlesData>(`/articles${query}`)
const readers = async () => (await get<{ readers: Reader[] }>('/readers')).readers

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k)
      keysOf(v, into)
    }
  }
  return into
}

const ANNA = 'member-anna-0000001'
const BORIS = 'member-boris-000002'
const CLEO = 'member-cleo-0000003'
const DANA = 'member-dana-0000004'

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  now = api.clock.now()
  nextArticle = 1
  await person(ANNA, 'anna')
  await person(BORIS, 'boris')
  await person(CLEO, 'cleo', { subs: true })
  await person(DANA, 'dana')
})

describe('the routes', () => {
  test('sit below the Blogs answer, which keeps its path and its answer', async () => {
    await blog(1)
    const blogs = await api.request('/api/v1/public/discover')
    expect(blogs.status).toBe(200)
    expect(blogs.headers.get('cache-control')).toBe(PUBLIC_CACHE)
    expect(await blogs.json()).toMatchObject({ sites: [{ id: 1 }], total: 1, page: 1 })
    for (const path of ['/week', '/articles', '/readers']) {
      const res = await api.request(`/api/v1/public/discover${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe(PROFILE_CACHE)
    }
    expect((await api.request('/api/v1/public/discover/elsewhere')).status).toBe(404)
  })

  test('no answer says how a blog was listed', async () => {
    await blog(1, { listing: 'featured' })
    await blog(2)
    const a = await post(1, HOUR)
    const b = await post(2, 2 * HOUR)
    await recommend(ANNA, a, HOUR, 'a note')
    await recommend(BORIS, a)
    await recommend(CLEO, a)
    await recommend(DANA, b)
    await subscribe(CLEO, 2)
    const bodies = [await week(), await articles(), { readers: await readers() }]
    expect(JSON.stringify(bodies)).toContain(`"id":${a}`)
    for (const body of bodies) {
      const keys = keysOf(body)
      for (const key of ['listing', 'review', 'reviewedAt', 'reviewed_at']) {
        expect(keys.has(key)).toBe(false)
      }
    }
  })
})

describe('This week', () => {
  test("ranks the week's recommended posts by how many recommended them, then the newest", async () => {
    await blog(1)
    await blog(2, { listing: 'featured' })
    const older = await post(1, 3 * DAY)
    const newer = await post(2, 2 * DAY)
    const most = await post(1, 6 * DAY)
    const once = await post(2, HOUR)
    await recommend(ANNA, older)
    await recommend(BORIS, older)
    await recommend(ANNA, newer)
    await recommend(BORIS, newer, 2 * HOUR, 'first note')
    await recommend(CLEO, newer, 3 * HOUR, 'the newest note')
    await unrecommend(CLEO, newer) // a removed one counts for nothing, its note included
    await recommend(DANA, newer, 4 * HOUR, '')
    for (const who of [ANNA, BORIS, CLEO, DANA]) await recommend(who, most)
    await recommend(DANA, once)
    const body = await week()
    expect(body.since).toBe(now - 7 * DAY)
    expect(body.recommended.map((p) => p.article.id)).toEqual([most, newer, older, once])
    const second = body.recommended[1] as DiscoverPost
    expect(second.weekRecs).toBe(3)
    // Newest first by id, which is the order they were made in.
    expect(second.recommenders).toEqual([DANA, BORIS, ANNA])
    expect(second.note).toEqual({
      text: 'first note',
      person: { id: BORIS, handle: 'boris', displayName: 'Name boris', avatar: null },
    })
    expect(body.recommended[0]?.note).toBeNull()
    expect(second.site).toEqual({
      id: 2,
      title: 'Blog 2',
      homeUrl: 'https://blog2.example',
      faviconKey: null,
      primaryLang: 'en',
      claimed: false,
    })
    expect(second.article).toMatchObject({ title: `Post ${newer}`, titles: {}, excerpts: {} })
  })

  test('leaves out private blogs, merged feeds, future posts, and old or removed recommendations', async () => {
    await blog(1)
    await blog(2, { listing: 'private' })
    await blog(3, { listing: 'rejected' })
    await mergedFeed(40, 1, 1)
    const shown = await post(1, DAY)
    const onPrivate = await post(2, DAY)
    const onRejected = await post(3, DAY)
    const onMerged = await post(40, DAY)
    const future = await post(1, -DAY)
    const lastWeek = await post(1, 9 * DAY)
    const removed = await post(1, DAY)
    for (const id of [shown, onPrivate, onRejected, onMerged, future, removed]) {
      await recommend(ANNA, id)
    }
    await recommend(ANNA, lastWeek, 8 * DAY) // made before the week began
    await unrecommend(ANNA, removed)
    const body = await week()
    expect(body.recommended.map((p) => p.article.id)).toEqual([shown])
  })

  test('a recommendation made again keeps the time it was first made', async () => {
    await blog(1)
    const a = await post(1, 20 * DAY)
    const me = await signedIn(api, 'me@x.test')
    const push = (mutation: Record<string, unknown>) =>
      api.request('/api/v1/mutations', {
        body: { mutations: [{ mid: `m-${Math.random()}`, ...mutation }] },
        as: me,
      })
    await push({ type: 'recommend', articleId: a, note: null, at: now - 10 * DAY })
    await push({ type: 'unrecommend', articleId: a, at: now - 9 * DAY })
    await push({ type: 'recommend', articleId: a, note: 'again', at: now - HOUR })
    expect((await week()).recommended).toEqual([])
    // It is live, and Readers counts it, made ten days ago.
    const [reader] = await readers()
    expect(reader).toMatchObject({ id: me.userId, recent: 1, total: 1 })
  })

  test("the edition is the front page's: the week's newest post of each blog, else the latest", async () => {
    await blog(1, { claimedBy: ANNA, claimedAt: 0 })
    await blog(2)
    const old = await post(1, 9 * DAY)
    const latest = await post(2, 8 * DAY)
    const quiet = await week()
    expect(quiet.edition.span).toBe('latest')
    expect(quiet.edition.posts.map((p) => p.article.id)).toEqual([latest, old])
    expect(quiet.edition.posts[1]?.site.claimed).toBe(true)

    const fresh = await post(1, DAY)
    await recommend(BORIS, fresh, HOUR, 'worth it')
    const body = await week()
    expect(body.edition.span).toBe('week')
    expect(body.edition.posts.map((p) => p.article.id)).toEqual([fresh])
    expect(body.edition.posts[0]).toMatchObject({
      site: { id: 1, claimed: true },
      weekRecs: 1,
      recommenders: [BORIS],
      note: { text: 'worth it', person: { handle: 'boris' } },
    })
    expect(Object.keys(body.edition.posts[0] as object).sort()).toEqual(
      ['article', 'note', 'recommenders', 'site', 'weekRecs'].sort(),
    )
  })

  test('new blogs are every listed blog, newest first, whichever way it was listed', async () => {
    await blog(1, { createdAt: now - 5 * DAY }) // curated: no feed a member added
    // Listed from the queue: there like any other, since its absence would name what Anna reads.
    await blog(2, { addedBy: ANNA, readers: 2, createdAt: now - HOUR })
    await blog(3, {
      addedBy: ANNA,
      claimedBy: BORIS,
      claimedAt: now - DAY,
      createdAt: now - 20 * DAY,
    })
    await blog(4, { addedBy: BORIS, readers: 3, createdAt: now - 2 * DAY })
    await blog(5, { listing: 'private', createdAt: now })
    await blog(6, { listing: 'featured', createdAt: now - 5 * DAY })
    await write(
      db.run(sql`insert into site_topics (site_id, topic) values (1, 'tech'), (1, 'design')`),
    )
    const body = await week()
    expect(body.newBlogs.map((s) => s.id)).toEqual([2, 3, 4, 6, 1])
    expect(body.newBlogs[4]?.topics).toEqual(['design', 'tech'])
    expect(body.newBlogs[0]).toMatchObject({ claimed: false, readerCount: null })
    expect(body.newBlogs[1]).toMatchObject({ claimed: true, readerCount: null, topics: [] })
    expect(body.newBlogs[2]?.readerCount).toBe(3)
    // A card exactly as Discover's Blogs shows one.
    const blogs = (await (await api.request('/api/v1/public/discover')).json()) as {
      sites: Record<string, unknown>[]
    }
    const card = blogs.sites.find((s) => s.id === 1)
    expect(body.newBlogs[4]).toEqual(card as never)
  })

  test(`at most ${NEW_BLOGS} new blogs and ${WEEK_POSTS} posts of each kind`, async () => {
    for (let id = 1; id <= WEEK_POSTS + 2; id++) await blog(id, { createdAt: id })
    for (let id = 1; id <= WEEK_POSTS + 2; id++) await recommend(ANNA, await post(id, id * HOUR))
    const body = await week()
    expect(body.newBlogs).toHaveLength(NEW_BLOGS)
    expect(body.newBlogs[0]?.id).toBe(WEEK_POSTS + 2)
    expect(body.recommended).toHaveLength(WEEK_POSTS)
    expect(body.edition.posts).toHaveLength(WEEK_POSTS)
  })

  test(`names at most ${RECOMMENDERS_SHOWN} recommenders, and its readers carry ${RECS_IN_WEEK} of theirs`, async () => {
    await blog(1)
    const a = await post(1, HOUR)
    const ids: string[] = []
    for (let i = 0; i < RECOMMENDERS_SHOWN + 3; i++) {
      const id = `member-many-${String(i).padStart(7, '0')}`
      ids.push(id)
      await person(id, `many${i}`)
      await recommend(id, a)
    }
    for (let i = 0; i < RECS_IN_WEEK + 2; i++) await recommend(ANNA, await post(1, DAY + i))
    const body = await week()
    expect(body.recommended[0]?.weekRecs).toBe(RECOMMENDERS_SHOWN + 3)
    expect(body.recommended[0]?.recommenders).toEqual(ids.reverse().slice(0, RECOMMENDERS_SHOWN))
    const anna = body.readers.find((r) => r.id === ANNA)
    expect(anna?.recs).toHaveLength(RECS_IN_WEEK)
    expect((await readers()).find((r) => r.id === ANNA)?.recs).toHaveLength(RECS_IN_WEEK + 2)
  })
})

describe('Articles', () => {
  /** Every page, following each `next`; it must end, and each page move on. */
  async function everyPage(query = '') {
    const pages: ArticlesData[] = []
    let cursor: string | null = null
    for (let i = 0; i < 20; i++) {
      const params = new URLSearchParams(query)
      if (cursor) params.set('cursor', cursor)
      const page: ArticlesData = await articles(`?${params}`)
      pages.push(page)
      if (page.next === null) return pages
      expect(page.posts).toHaveLength(ARTICLES_PAGE)
      cursor = page.next
    }
    throw new Error('Articles never ended')
  }

  test('pages newest first by key, through posts dated the same moment', async () => {
    await blog(1)
    await blog(2)
    const written: { id: number; at: number }[] = []
    // 65 posts, seven to a millisecond, across two blogs.
    for (let i = 0; i < 65; i++) {
      const ago = Math.floor(i / 7) * HOUR
      written.push({ id: await post(1 + (i % 2), ago), at: now - ago })
    }
    const pages = await everyPage()
    expect(pages.map((p) => p.posts.length)).toEqual([30, 30, 5])
    const seen = pages.flatMap((p) => p.posts.map((x) => x.article))
    expect(seen.map((a) => a.id)).toEqual(
      written.sort((x, y) => y.at - x.at || y.id - x.id).map((x) => x.id),
    )
    const first = pages[0]?.posts.at(-1)?.article
    expect(pages[0]?.next).toBe(`${first?.sortAt}:${first?.id}`)
  })

  test('a post written or removed behind the cursor neither repeats nor skips one', async () => {
    await blog(1)
    for (let i = 0; i < 40; i++) await post(1, Math.floor(i / 4) * HOUR)
    const first = await articles()
    const cursor = first.next as string
    const [at] = cursor.split(':').map(Number)
    const before = (await everyPage()).flatMap((p) => p.posts.map((x) => x.article.id))
    // Meanwhile: three newer posts, one at the cursor's own moment (a higher id sorts before it),
    // and the newest post read so far removed.
    await post(1, 0)
    await post(1, -1) // a millisecond from now is still the future: never shown
    await write(
      db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, seq)
        values (1000, 1, 'k1000', 'Tied', ${now}, ${at}, ${currentSeq})`),
    )
    await write(db.run(sql`delete from articles where id = ${first.posts[0]?.article.id}`))
    const second = await articles(`?cursor=${encodeURIComponent(cursor)}`)
    expect(second.posts.map((p) => p.article.id)).toEqual(before.slice(ARTICLES_PAGE))
  })

  test('a topic narrows to its blogs, a language to its posts; neither takes a pattern', async () => {
    await blog(1)
    await blog(2)
    await write(db.run(sql`insert into site_topics (site_id, topic) values (1, 'tech')`))
    const en = await post(1, HOUR, 'en')
    const ja = await post(1, 2 * HOUR, 'ja')
    const other = await post(2, 3 * HOUR, 'ja')
    const ids = (body: ArticlesData) => body.posts.map((p) => p.article.id)
    expect(ids(await articles('?topic=tech'))).toEqual([en, ja])
    expect(ids(await articles('?lang=ja'))).toEqual([ja, other])
    expect(ids(await articles('?topic=tech&lang=ja'))).toEqual([ja])
    expect(ids(await articles('?topic=not-a-topic&lang=%25'))).toEqual([en, ja, other])
  })

  test('a cursor that is not one is the first page, and only the first page has the recommended', async () => {
    await blog(1)
    const posts: number[] = []
    for (let i = 0; i < ARTICLES_PAGE + 5; i++) posts.push(await post(1, i * HOUR))
    const eleventh = posts[10] as number
    const fourth = posts[3] as number
    await recommend(ANNA, eleventh)
    await recommend(BORIS, eleventh)
    await recommend(ANNA, fourth)
    const first = await articles()
    expect(first.recommended.map((p) => p.article.id)).toEqual([eleventh, fourth])
    expect(first.posts[10]).toMatchObject({ weekRecs: 2, recommenders: [BORIS, ANNA] })
    for (const junk of ['nonsense', '12:x', ':1', '1:', '1:2:3', '1234567890123456:1']) {
      expect(await articles(`?cursor=${encodeURIComponent(junk)}`)).toEqual(first)
    }
    const second = await articles(`?cursor=${encodeURIComponent(first.next as string)}`)
    expect(second.recommended).toEqual([])
    expect(second.posts).toHaveLength(5)
    expect(second.next).toBeNull()
  })

  test("the recommended keep to the topic and language, and the week's", async () => {
    await blog(1)
    await blog(2)
    await write(db.run(sql`insert into site_topics (site_id, topic) values (1, 'tech')`))
    const tech = await post(1, HOUR, 'en')
    const techJa = await post(1, HOUR, 'ja')
    const elsewhere = await post(2, HOUR, 'en')
    for (const id of [tech, techJa, elsewhere]) await recommend(ANNA, id)
    const ids = (body: ArticlesData) => body.recommended.map((p) => p.article.id)
    expect(ids(await articles('?topic=tech'))).toEqual([techJa, tech])
    expect(ids(await articles('?topic=tech&lang=en'))).toEqual([tech])
  })

  test('counts languages over ninety days, within the topic and not the language', async () => {
    await blog(1)
    await blog(2)
    await blog(3, { listing: 'private' })
    await write(
      db.run(sql`insert into site_topics (site_id, topic) values (1, 'tech'), (3, 'tech')`),
    )
    await post(1, HOUR, 'en')
    await post(1, 2 * HOUR, 'en')
    await post(1, 3 * HOUR, 'ja')
    await post(1, 91 * DAY, 'fr') // too old
    await post(1, -DAY, 'fr') // not yet
    await post(1, HOUR, null)
    await post(2, HOUR, 'de')
    await post(3, HOUR, 'es') // a private blog
    expect((await articles()).languages).toEqual([
      { lang: 'en', count: 2 },
      { lang: 'de', count: 1 },
      { lang: 'ja', count: 1 },
    ])
    const tech = [
      { lang: 'en', count: 2 },
      { lang: 'ja', count: 1 },
    ]
    expect((await articles('?topic=tech')).languages).toEqual(tech)
    expect((await articles('?topic=tech&lang=ja')).languages).toEqual(tech)
  })
})

describe('Readers', () => {
  test('are the people who recommend or show what they read, the most active first', async () => {
    await blog(1)
    await blog(2, { listing: 'private' })
    const a = await post(1, HOUR)
    const b = await post(1, 2 * HOUR)
    const old = await post(1, 60 * DAY)
    await recommend(ANNA, a, HOUR, 'a note')
    await recommend(ANNA, old, 40 * DAY, 'an old note') // counted in total only
    await recommend(DANA, a)
    await recommend(DANA, b, HOUR, 'note one')
    await recommend(DANA, old, 2 * HOUR, 'note two')
    await subscribe(CLEO, 1) // shows what she reads, recommends nothing
    await subscribe(BORIS, 1) // reads privately, recommends nothing: not a signal
    await person('member-eli-00000005', 'eli', { subs: true })
    await subscribe('member-eli-00000005', 2) // shows only a private blog: nothing to show
    const pool = await readers()
    expect(pool.map((r) => r.handle)).toEqual(['dana', 'anna', 'cleo'])
    expect(pool[0]).toMatchObject({ recent: 3, withNote: 2, total: 3, bio: 'Bio of dana' })
    expect(pool[1]).toMatchObject({ recent: 1, withNote: 1, total: 2 })
    expect(pool[2]).toMatchObject({ recent: 0, withNote: 0, total: 0, recs: [], sites: [1] })
    expect(Object.keys(pool[2] as object).sort()).toEqual(
      [
        'avatar',
        'bio',
        'displayName',
        'early',
        'handle',
        'id',
        'recent',
        'recs',
        'sample',
        'sites',
        'total',
        'withNote',
      ].sort(),
    )
  })

  test('carry their recommendations as ids, private blogs too, and public blogs only if shown', async () => {
    await blog(1)
    await blog(2)
    await blog(3, { listing: 'private' })
    const a = await post(1, HOUR)
    const hidden = await post(3, HOUR)
    const c = await post(2, HOUR)
    await recommend(CLEO, a)
    await recommend(CLEO, hidden)
    await recommend(CLEO, c)
    await recommend(ANNA, a)
    await subscribe(ANNA, 2) // Anna does not show hers
    await subscribe(CLEO, 2)
    await subscribe(CLEO, 1)
    await subscribe(CLEO, 3) // a private blog, even shown
    await mergedFeed(40, 1, 1)
    await subscribe(CLEO, 40) // another address of blog 1: one blog
    const pool = await readers()
    const cleo = pool.find((r) => r.handle === 'cleo')
    expect(cleo?.recs).toEqual([
      [c, 2],
      [hidden, 3],
      [a, 1],
    ])
    expect(cleo?.sites).toEqual([1, 2])
    expect(pool.find((r) => r.handle === 'anna')?.sites).toBeNull()
  })

  test('an early find is by when the recommendation reached Tela, not the time its device gave', async () => {
    await blog(1)
    await blog(2, { listing: 'private' })
    const found = await post(1, DAY)
    const later = await post(1, DAY)
    const hidden = await post(2, DAY)
    await recommend(ANNA, found, HOUR)
    await recommend(BORIS, found, 30 * DAY) // after Anna, dated a month back
    await recommend(CLEO, found)
    await recommend(DANA, found)
    await recommend(CLEO, later)
    await recommend(ANNA, later)
    await recommend(BORIS, later)
    // Dana was first on a private blog's post: nobody may see that find.
    await recommend(DANA, hidden)
    for (const who of [ANNA, BORIS, CLEO]) await recommend(who, hidden)
    const pool = await readers()
    const by = (handle: string) => pool.find((r) => r.handle === handle)
    expect(by('anna')?.early).toMatchObject({ others: 3, article: { id: found }, site: { id: 1 } })
    // By its time Boris's was first on `found`; by id it came after Anna's, before two others.
    expect(by('boris')?.early).toMatchObject({ others: EARLY_MIN, article: { id: found } })
    expect(by('cleo')?.early).toMatchObject({ others: EARLY_MIN, article: { id: later } })
    expect(by('dana')?.early).toBeNull()
    expect(by('anna')?.early?.article.titles).toEqual({})
    expect(by('anna')?.early?.article.excerpts).toBeUndefined()
  })

  test(`is early only from ${EARLY_MIN} others after`, async () => {
    await blog(1)
    const a = await post(1, DAY)
    await recommend(ANNA, a)
    await recommend(BORIS, a)
    expect((await readers()).find((r) => r.handle === 'anna')?.early).toBeNull()
    await recommend(CLEO, a)
    expect((await readers()).find((r) => r.handle === 'anna')?.early?.others).toBe(EARLY_MIN)
  })

  test('a sample is their newest note on a public blog’s post', async () => {
    await blog(1)
    await blog(2, { listing: 'private' })
    await blog(3)
    await mergedFeed(40, 3, 3)
    const a = await post(1, DAY)
    const b = await post(1, DAY)
    const hidden = await post(2, DAY)
    const mirrored = await post(40, DAY)
    await recommend(ANNA, a, HOUR, 'older note')
    await recommend(ANNA, b, 2 * HOUR, 'newer note') // newer by id, whatever its time says
    await recommend(ANNA, hidden, HOUR, 'private note')
    await recommend(ANNA, mirrored, HOUR, 'a copy')
    await recommend(ANNA, await post(1, DAY), HOUR, '')
    await recommend(BORIS, a)
    const pool = await readers()
    expect(pool.find((r) => r.handle === 'anna')?.sample).toMatchObject({
      note: 'newer note',
      article: { id: b, titles: {} },
      site: { id: 1, homeUrl: 'https://blog1.example', claimed: false },
    })
    expect(pool.find((r) => r.handle === 'boris')?.sample).toBeNull()
  })

  test('a post whose date has not come is nobody’s early find or sample yet', async () => {
    await blog(1)
    // A member's device can hold a scheduled post and recommend it before it is published.
    const scheduled = await post(1, -DAY)
    await recommend(ANNA, scheduled, HOUR, 'too soon')
    for (const who of [BORIS, CLEO]) await recommend(who, scheduled)
    const anna = (await readers()).find((r) => r.handle === 'anna')
    expect(anna?.early).toBeNull()
    expect(anna?.sample).toBeNull()
  })

  test('nobody to suggest is an empty list', async () => {
    expect(await readers()).toEqual([])
    expect((await week()).readers).toEqual([])
  })
})
