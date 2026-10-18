/**
 * Blogrolls as others see them (ADR 0050): a public blogroll's page, and its card on its member's
 * profile and on Discover. Rows are written here directly: the mutations that write them have
 * their own tests (`blogroll-sync.test.ts`).
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { BLOGROLL_DISCOVER_MIN } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { BLOG_DESCRIPTION_MAX } from '../src/routes/blogrolls'
import { BLOGROLLS_PAGE, DISCOVER_CARD_BLOGS } from '../src/routes/discover'
import { PROFILE_CACHE, PROFILE_CARD_BLOGS } from '../src/routes/public'
import { createTestApi, type TestApi } from './helpers'

const ANNA = 'member-anna-0000001'
const BORIS = 'member-boris-000002'

let api: TestApi
let db: TelaDb
let now: number

type Person = { id: string; handle: string; displayName: string | null; avatar: string | null }
type BlogrollBlog = {
  feedId: number
  siteId: number
  name: string | null
  homeUrl: string
  faviconKey: string | null
  primaryLang: string | null
  description: string | null
  listed: boolean
  readerCount: number | null
  dead: boolean
  note: string | null
  addedAt: number
}
type BlogrollData = {
  blogroll: { id: string; name: string; description: string; updatedAt: number }
  owner: Person
  blogs: BlogrollBlog[]
}
type BlogrollCard = {
  id: string
  name: string
  description: string
  owner: Person
  blogCount: number
  blogs: { feedId: number; siteId: number; name: string | null; homeUrl: string }[]
  publicSince: number | null
  updatedAt: number
}
type BlogrollsData = { blogrolls: BlogrollCard[]; next: string | null }

async function write(...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

/** A member who never signs in here. */
async function person(id: string, handle: string) {
  await write(
    db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
    db.run(sql`insert into profiles (user_id, handle, display_name, created_at, updated_at, seq)
      values (${id}, ${handle}, ${`Name ${handle}`}, 0, 0, ${currentSeq})`),
  )
}

type BlogOptions = {
  listing?: string
  title?: string | null
  description?: string | null
  readers?: number
}

/** A blog and its feed, both numbered `id`. */
async function blog(id: number, o: BlogOptions = {}) {
  await write(
    db.run(sql`insert into sites (id, home_url, title, description, listing, primary_lang,
        favicon_key, reader_count, created_at, updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${o.title === undefined ? `Blog ${id}` : o.title},
        ${o.description ?? null}, ${o.listing ?? 'listed'}, 'en', ${`fav${id}`}, ${o.readers ?? 0},
        0, 0, ${currentSeq})`),
  )
  await feed(id, id)
}

/** A feed of blog `siteId`. */
async function feed(
  id: number,
  siteId: number,
  o: { title?: string | null; status?: string; mergedInto?: number } = {},
) {
  await write(
    db.run(sql`insert into feeds (id, site_id, feed_url, host, title, status, merged_into,
        next_fetch_at, created_at, updated_at, seq)
      values (${id}, ${siteId}, ${`https://blog${siteId}.example/feed${id}`}, ${`blog${siteId}.example`},
        ${o.title ?? null}, ${o.status ?? 'active'}, ${o.mergedInto ?? null}, 0, 0, 0, ${currentSeq})`),
  )
}

type BlogrollOptions = {
  name?: string
  description?: string
  isPublic?: boolean
  publicSince?: number | null
  hiddenAt?: number | null
  createdAt?: number
  updatedAt?: number
  deletedAt?: number | null
}

/** A blogroll of `owner`'s, public unless told otherwise. */
async function blogroll(id: string, owner: string, o: BlogrollOptions = {}) {
  const isPublic = o.isPublic ?? true
  await write(
    db.run(sql`insert into blogrolls (id, user_id, name, description, is_public, public_version,
        public_since, hidden_at, created_at, updated_at, deleted_at, seq)
      values (${id}, ${owner}, ${o.name ?? `Roll ${id}`}, ${o.description ?? ''}, ${isPublic ? 1 : 0},
        ${isPublic ? 1 : 0},
        ${o.publicSince === undefined ? (isPublic ? (o.createdAt ?? 1) : null) : o.publicSince},
        ${o.hiddenAt ?? null}, ${o.createdAt ?? 1}, ${o.updatedAt ?? o.createdAt ?? 1},
        ${o.deletedAt ?? null}, ${currentSeq})`),
  )
}

type RollOptions = {
  addedAt?: number
  updatedAt?: number
  removedAt?: number | null
  note?: string | null
  noteAt?: number
}

/** Feed `feedId` in blogroll `blogrollId`, which `owner` keeps. */
async function roll(blogrollId: string, feedId: number, owner: string, o: RollOptions = {}) {
  await write(
    db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, note, note_at, added_at,
        updated_at, removed_at, seq)
      values (${blogrollId}, ${feedId}, ${owner}, ${o.note ?? null}, ${o.noteAt ?? 0},
        ${o.addedAt ?? feedId}, ${o.updatedAt ?? o.addedAt ?? feedId}, ${o.removedAt ?? null},
        ${currentSeq})`),
  )
}

/** A blogroll of `owner`'s holding feeds `feeds`, in that order. */
async function filled(id: string, owner: string, feeds: number[], o: BlogrollOptions = {}) {
  await blogroll(id, owner, o)
  for (const [i, feedId] of feeds.entries()) await roll(id, feedId, owner, { addedAt: i + 1 })
}

const get = (path: string) => api.request(path)
async function page(id: string): Promise<BlogrollData> {
  const res = await get(`/api/v1/public/blogrolls/${id}`)
  expect(res.status).toBe(200)
  return (await res.json()) as BlogrollData
}
async function profileCards(handle: string): Promise<BlogrollCard[]> {
  const res = await get(`/api/v1/public/profiles/${handle}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { blogrolls: BlogrollCard[] }).blogrolls
}
async function discover(cursor?: string): Promise<BlogrollsData> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
  const res = await get(`/api/v1/public/discover/blogrolls${query}`)
  expect(res.status).toBe(200)
  return (await res.json()) as BlogrollsData
}

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  now = api.clock.now()
  await person(ANNA, 'anna')
  await person(BORIS, 'boris')
})

describe("a public blogroll's page", () => {
  test('is not found for a bad id, an unknown one, a private one or a deleted one', async () => {
    await filled('privateRoll1', ANNA, [], { isPublic: false })
    await filled('deletedRoll1', ANNA, [], { deletedAt: 5 })
    for (const id of ['short', 'has-a-dash01', 'thirteenchars', 'unknownRoll1', 'privateRoll1']) {
      const res = await get(`/api/v1/public/blogrolls/${id}`)
      expect(res.status).toBe(404)
      // Found within minutes once made public: the same short life as any public 404.
      expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60')
    }
    expect((await get('/api/v1/public/blogrolls/deletedRoll1')).status).toBe(404)
  })

  test('is not found when its owner has no profile, or no account', async () => {
    await blog(1)
    await filled('annasRoll001', ANNA, [1])
    expect((await get('/api/v1/public/blogrolls/annasRoll001')).status).toBe(200)
    await db.run(sql`delete from profiles where user_id = ${ANNA}`)
    expect((await get('/api/v1/public/blogrolls/annasRoll001')).status).toBe(404)
    await db.run(sql`delete from user where id = ${ANNA}`)
    expect((await get('/api/v1/public/blogrolls/annasRoll001')).status).toBe(404)
  })

  test('lists the blogs others see, in the order they were put in, as a page shows them', async () => {
    await blog(1, { readers: 5, description: 'x'.repeat(400) })
    await blog(2, { listing: 'featured', readers: 2 })
    await blog(3, { listing: 'private', title: null })
    await blog(4, { listing: 'rejected', readers: 9 })
    await blog(5)
    await blog(6)
    await feed(7, 6, { status: 'dead' })
    await blogroll('annasRoll001', ANNA, {
      name: 'Cities',
      description: 'Blogs\nabout cities',
      updatedAt: 10,
    })
    await roll('annasRoll001', 2, ANNA, { addedAt: 20 })
    await roll('annasRoll001', 1, ANNA, { addedAt: 30, note: 'Read this one', noteAt: 40 })
    await roll('annasRoll001', 3, ANNA, { addedAt: 30 })
    await roll('annasRoll001', 4, ANNA, { addedAt: 25, note: 'Hidden by the operator' })
    await roll('annasRoll001', 5, ANNA, { addedAt: 26, removedAt: 50, updatedAt: 50 })
    await roll('annasRoll001', 7, ANNA, { addedAt: 35 })
    const res = await get('/api/v1/public/blogrolls/annasRoll001')
    expect(res.headers.get('cache-control')).toBe(PROFILE_CACHE)
    const data = (await res.json()) as BlogrollData
    expect(data.blogroll).toEqual({
      id: 'annasRoll001',
      name: 'Cities',
      description: 'Blogs\nabout cities',
      // The removal of blog 5 is the latest change.
      updatedAt: 50,
    })
    expect(data.owner).toEqual({ id: ANNA, handle: 'anna', displayName: 'Name anna', avatar: null })
    expect(data.blogs.map((b) => b.feedId)).toEqual([2, 1, 3, 7])
    expect(data.blogs[0]).toEqual({
      feedId: 2,
      siteId: 2,
      name: 'Blog 2',
      homeUrl: 'https://blog2.example',
      faviconKey: 'fav2',
      primaryLang: 'en',
      description: null,
      listed: true,
      // Two readers is nobody's to publish (ADR 0041).
      readerCount: null,
      dead: false,
      note: null,
      addedAt: 20,
    })
    expect(data.blogs[1]).toMatchObject({
      readerCount: 5,
      note: 'Read this one',
      description: 'x'.repeat(BLOG_DESCRIPTION_MAX),
    })
    // A blog with no page on Tela, and none of a name: the page links it and shows its host.
    expect(data.blogs[2]).toMatchObject({ siteId: 3, name: null, listed: false })
    expect(data.blogs[3]).toMatchObject({ feedId: 7, siteId: 6, dead: true })
    const text = JSON.stringify(data)
    expect(text).not.toContain('Hidden by the operator')
    expect(text).not.toContain('anna@x.test')
  })

  test('names a blog by its feed when the blogroll holds another feed of that blog', async () => {
    // As the e2e fixtures are: two feeds of one blog.
    await blog(1, { title: 'Fixture blog' })
    await feed(2, 1, { title: 'Fixture comments' })
    await write(db.run(sql`update feeds set title = 'Fixture posts' where id = 1`))
    await blog(3, { title: null })
    await feed(4, 3, { title: 'Untitled blog feed' })
    await filled('annasRoll001', ANNA, [1, 2, 4])
    expect((await page('annasRoll001')).blogs.map((b) => b.name)).toEqual([
      'Fixture posts',
      'Fixture comments',
      // No title of its own: its feed's.
      'Untitled blog feed',
    ])
    // Its sibling taken out, a feed goes back to its blog's name.
    await write(
      db.run(sql`update blogroll_blogs set removed_at = 9 where feed_id = 2`),
      db.run(sql`delete from blogroll_blogs where feed_id = 4`),
    )
    expect((await page('annasRoll001')).blogs.map((b) => b.name)).toEqual(['Fixture blog'])
  })

  test("keeps a merged feed's row, not updating when the feed it became is not", async () => {
    await blog(1)
    await feed(2, 1, { status: 'paused', mergedInto: 1 })
    await filled('annasRoll001', ANNA, [2])
    expect((await page('annasRoll001')).blogs).toMatchObject([{ feedId: 2, dead: false }])
    await write(db.run(sql`update feeds set status = 'dead' where id = 1`))
    expect((await page('annasRoll001')).blogs).toMatchObject([{ feedId: 2, dead: true }])
  })

  test('names its owner with their picture while they show one (ADR 0032)', async () => {
    await filled('annasRoll001', ANNA, [])
    await write(
      db.run(sql`update profiles set gravatar = 1, gravatar_found = 1, avatar_version = 9
        where user_id = ${ANNA}`),
    )
    expect((await page('annasRoll001')).owner.avatar).toBe(`/avatar/${ANNA}?v=9`)
    expect((await profileCards('anna'))[0]?.owner.avatar).toBe(`/avatar/${ANNA}?v=9`)
  })

  test('stays open while the operator hides it from Discover', async () => {
    await blog(1)
    await filled('annasRoll001', ANNA, [1], { hiddenAt: 5 })
    expect((await page('annasRoll001')).blogs).toHaveLength(1)
  })

  test('takes the latest note as a change', async () => {
    await blog(1)
    await blogroll('annasRoll001', ANNA, { updatedAt: 10 })
    await roll('annasRoll001', 1, ANNA, { addedAt: 20, note: 'Later', noteAt: 70 })
    expect((await page('annasRoll001')).blogroll.updatedAt).toBe(70)
  })
})

describe("a member's profile", () => {
  test('carries their public blogrolls, hidden ones too, newest first', async () => {
    for (const id of [1, 2, 3, 4, 5]) await blog(id)
    await blog(6, { listing: 'rejected' })
    await filled('olderRoll001', ANNA, [6, 4, 2, 3, 1], { createdAt: 10, publicSince: 15 })
    await filled('hiddenRoll01', ANNA, [5], { createdAt: 20, hiddenAt: 30 })
    await filled('privateRoll1', ANNA, [1], { createdAt: 30, isPublic: false })
    await filled('deletedRoll1', ANNA, [1], { createdAt: 40, deletedAt: 45 })
    await filled('borissRoll01', BORIS, [1], { createdAt: 50 })
    const cards = await profileCards('anna')
    expect(cards.map((c) => c.id)).toEqual(['hiddenRoll01', 'olderRoll001'])
    expect(cards[1]).toEqual({
      id: 'olderRoll001',
      name: 'Roll olderRoll001',
      description: '',
      owner: { id: ANNA, handle: 'anna', displayName: 'Name anna', avatar: null },
      // The rejected blog is neither counted nor named.
      blogCount: 4,
      blogs: [4, 2, 3].map((id) => ({
        feedId: id,
        siteId: id,
        name: `Blog ${id}`,
        homeUrl: `https://blog${id}.example`,
      })),
      publicSince: 15,
      updatedAt: 10,
    })
    expect(cards[1]?.blogs).toHaveLength(PROFILE_CARD_BLOGS)
    expect(await profileCards('boris')).toMatchObject([{ id: 'borissRoll01', blogCount: 1 }])
    // With none public, an empty list, never none.
    await write(db.run(sql`update blogrolls set is_public = 0 where id = 'borissRoll01'`))
    expect(await profileCards('boris')).toEqual([])
  })
})

describe("Discover's Blogrolls", () => {
  test(`lists public blogrolls with ${BLOGROLL_DISCOVER_MIN} blogs others see, newest public first`, async () => {
    for (const id of [1, 2, 3, 4, 5, 6]) await blog(id)
    await blog(7, { listing: 'rejected' })
    await filled('sixBlogs0001', ANNA, [1, 2, 3, 4, 5, 6], { createdAt: 1, publicSince: 100 })
    await filled('threeBlogs01', BORIS, [1, 2, 3], { createdAt: 2, publicSince: 200 })
    // Two blogs others see, with a rejected one and one taken out.
    await filled('twoShown0001', BORIS, [1, 2, 7], { publicSince: 300 })
    await roll('twoShown0001', 4, BORIS, { removedAt: 5 })
    await filled('hiddenRoll01', ANNA, [1, 2, 3], { publicSince: 400, hiddenAt: 401 })
    await filled('privateRoll1', ANNA, [1, 2, 3], { isPublic: false })
    await filled('deletedRoll1', ANNA, [1, 2, 3], { publicSince: 500, deletedAt: 501 })
    const res = await get('/api/v1/public/discover/blogrolls')
    expect(res.headers.get('cache-control')).toBe(PROFILE_CACHE)
    const data = (await res.json()) as BlogrollsData
    expect(data.next).toBeNull()
    expect(data.blogrolls.map((b) => b.id)).toEqual(['threeBlogs01', 'sixBlogs0001'])
    expect(data.blogrolls[1]).toMatchObject({
      owner: { id: ANNA, handle: 'anna' },
      blogCount: 6,
      publicSince: 100,
    })
    expect(data.blogrolls[1]?.blogs.map((b) => b.feedId)).toEqual([1, 2, 3, 4, 5])
    expect(data.blogrolls[1]?.blogs).toHaveLength(DISCOVER_CARD_BLOGS)
    // Hidden from Discover only: still on its page and its member's profile.
    expect((await page('hiddenRoll01')).blogs).toHaveLength(3)
    expect((await profileCards('anna')).map((c) => c.id)).toContain('hiddenRoll01')
  })

  test('pages by key: a change between pages repeats nothing and skips nothing', async () => {
    for (const id of [1, 2, 3]) await blog(id)
    const ids: string[] = []
    for (let i = 0; i < BLOGROLLS_PAGE + 5; i++) {
      const id = `roll${String(i).padStart(8, '0')}`
      ids.push(id)
      // Pairs share a moment, so the id breaks the tie.
      await filled(id, i % 2 ? ANNA : BORIS, [1, 2, 3], { publicSince: 1000 + Math.floor(i / 2) })
    }
    const first = await discover()
    expect(first.blogrolls).toHaveLength(BLOGROLLS_PAGE)
    expect(first.next).not.toBeNull()
    // Made public meanwhile: newer than everything, so before the first page, not on the second.
    await filled('newcomer0001', ANNA, [1, 2, 3], { publicSince: now })
    // One already shown made private: counted by offset, the second page would skip one.
    const gone = first.blogrolls[0]?.id ?? ''
    await write(db.run(sql`update blogrolls set is_public = 0 where id = ${gone}`))
    const second = await discover(first.next ?? '')
    expect(second.next).toBeNull()
    expect(second.blogrolls).toHaveLength(5)
    const seen = [...first.blogrolls, ...second.blogrolls].map((b) => b.id)
    const newestFirst = [...ids].sort((a, b) => {
      const at = (id: string) => Math.floor(Number(id.slice(4)) / 2)
      return at(b) - at(a) || (b < a ? -1 : 1)
    })
    expect(seen).toEqual(newestFirst)
    const again = (await discover()).blogrolls.map((b) => b.id)
    expect(again[0]).toBe('newcomer0001')
    expect(again).not.toContain(gone)
  })

  test('a cursor it cannot read is the first page', async () => {
    for (const id of [1, 2, 3]) await blog(id)
    await filled('onlyRoll0001', ANNA, [1, 2, 3])
    for (const cursor of ['nonsense', '12:short', '-1:onlyRoll0001', ''])
      expect((await discover(cursor)).blogrolls.map((b) => b.id)).toEqual(['onlyRoll0001'])
  })
})
