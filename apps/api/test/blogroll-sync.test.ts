/**
 * Blogrolls through push and pull (ADR 0050): the six mutations as tela-api applies them, from
 * one device or two whose changes arrive in either order, and what the owner's device is sent.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, first, type TelaDb } from '@tela/data'
import { MAX_BLOGROLL_BLOGS, MAX_BLOGROLLS } from '@tela/shared'
import type { PullResponse, PushResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let db: TelaDb
let now: number
let reader: SignedIn

const ID = 'RollAAAAAAAA'

async function write(...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

async function addFeed(n: number, site = n) {
  await write(
    db.run(sql`insert into sites (id, home_url, title, created_at, updated_at, seq)
      values (${site}, ${`https://blog${site}.example`}, ${`Blog ${site}`}, 0, 0, ${currentSeq})
      on conflict (id) do nothing`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (${n}, ${site}, ${`https://blog${n}.example/feed`}, ${`blog${n}.example`}, 0, 0, 0, ${currentSeq})`),
  )
}

let nextArticle = 1
async function addArticle(feedId: number) {
  const id = nextArticle++
  await write(
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, seq)
      values (${id}, ${feedId}, ${`k${id}`}, ${`Post ${id}`}, ${now}, ${now}, ${currentSeq})`),
  )
  return id
}

const pull = async (cursor: number, as = reader) => {
  const res = await api.request(`/api/v1/sync?cursor=${cursor}`, { as })
  expect(res.status).toBe(200)
  return (await res.json()) as PullResponse
}

let mids = 0
const push = async (mutations: Record<string, unknown>[], as = reader) => {
  const res = await api.request('/api/v1/mutations', {
    body: {
      mutations: mutations.map((m) => ({ mid: `mid-${++mids}-padding`, at: now, ...m })),
    },
    as,
  })
  expect(res.status).toBe(200)
  return (await res.json()) as PushResponse
}

/** Move the server's clock on too: a push clamps `at` to it. */
const later = (ms: number) => {
  api.clock.advance(ms)
  now = api.clock.now()
}

const put = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  type: 'putBlogroll',
  id,
  name,
  description: '',
  isPublic: false,
  ...extra,
})
const show = (id: string, base: number) => ({ type: 'setBlogrollPublic', id, isPublic: true, base })
const hide = (id: string) => ({ type: 'setBlogrollPublic', id, isPublic: false, base: 0 })
const roll = (feedId: number, blogrollId = ID) => ({ type: 'rollBlog', blogrollId, feedId })
const unroll = (feedId: number, blogrollId = ID) => ({ type: 'unrollBlog', blogrollId, feedId })
const note = (feedId: number, text: string | null, blogrollId = ID) => ({
  type: 'noteBlog',
  blogrollId,
  feedId,
  note: text,
})

type BlogrollState = {
  user_id: string
  name: string
  description: string
  is_public: number
  public_version: number
  public_since: number | null
  updated_at: number
  deleted_at: number | null
}
const blogroll = (id = ID) =>
  first<BlogrollState>(
    db,
    sql`select user_id, name, description, is_public, public_version, public_since, updated_at,
      deleted_at from blogrolls where id = ${id}`,
  )
type BlogState = {
  note: string | null
  note_at: number
  added_at: number
  updated_at: number
  removed_at: number | null
}
const blog = (feedId: number, blogrollId = ID) =>
  first<BlogState>(
    db,
    sql`select note, note_at, added_at, updated_at, removed_at from blogroll_blogs
      where blogroll_id = ${blogrollId} and feed_id = ${feedId}`,
  )

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  now = api.clock.now()
  nextArticle = 1
  reader = await signedIn(api, 'reader@x.test')
  await addFeed(1)
  await addFeed(2)
  await addFeed(3)
})

describe('blogrolls (ADR 0050)', () => {
  test('a blogroll and its blogs round-trip; a delta carries each change, a snapshot what is live', async () => {
    const head = (await pull(0)).cursor
    await push([
      put(ID, '  Friends  ', { description: '  Blogs I read.\nAll of them.  ', isPublic: true }),
      roll(1),
      roll(2),
      note(1, '  Start here.  '),
    ])
    const delta = await pull(head)
    expect(delta.rows.blogrolls).toEqual([
      {
        id: ID,
        name: 'Friends',
        description: 'Blogs I read.\nAll of them.',
        isPublic: true,
        publicVersion: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        seq: expect.any(Number),
      },
    ])
    expect(delta.rows.blogrollBlogs.map((b) => [b.feedId, b.note, b.removedAt])).toEqual([
      [1, 'Start here.', null],
      [2, null, null],
    ])
    expect(await blogroll()).toMatchObject({ public_since: now, public_version: 0 })
    later(10)
    await push([put(ID, 'Neighbours'), unroll(2)])
    const next = await pull(delta.cursor)
    expect(next.rows.blogrolls).toMatchObject([{ name: 'Neighbours', isPublic: true }])
    expect(next.rows.blogrollBlogs).toMatchObject([{ feedId: 2, removedAt: now }])
    // A snapshot sends every blog of a live blogroll, a removed one too: it keeps its note.
    const snap = await pull(0)
    expect(snap.rows.blogrolls.map((r) => r.name)).toEqual(['Neighbours'])
    expect(snap.rows.blogrollBlogs.map((b) => [b.feedId, b.removedAt === null])).toEqual([
      [1, true],
      [2, false],
    ])
    // Its blogs never reach anyone else.
    const other = await signedIn(api, 'other@x.test')
    const theirs = await pull(0, other)
    expect(theirs.rows.blogrolls).toEqual([])
    expect(theirs.rows.blogrollBlogs).toEqual([])
  })

  test('a blog in a blogroll brings its feed and site to the owner, though not subscribed, and none of its posts', async () => {
    await addArticle(3)
    const head = (await pull(0)).cursor
    await push([put(ID, 'Friends'), roll(3)])
    const delta = await pull(head)
    expect(delta.rows.feeds.map((f) => f.id)).toEqual([3])
    expect(delta.rows.sites.map((s) => s.id)).toEqual([3])
    expect(delta.rows.articles).toEqual([])
    const snap = await pull(0)
    expect(snap.rows.feeds.map((f) => f.id)).toEqual([3])
    expect(snap.rows.sites.map((s) => s.id)).toEqual([3])
    expect(snap.rows.articles).toEqual([])
    expect(snap.rows.subscriptions).toEqual([])
    // A change to its feed or site reaches the owner too.
    await write(
      db.run(sql`update feeds set title = 'Renamed feed', seq = ${currentSeq} where id = 3`),
      db.run(sql`update sites set title = 'Renamed blog', seq = ${currentSeq} where id = 3`),
    )
    const changed = await pull(delta.cursor)
    expect(changed.rows.feeds).toMatchObject([{ id: 3, title: 'Renamed feed' }])
    expect(changed.rows.sites).toMatchObject([{ id: 3, title: 'Renamed blog' }])
    expect(changed.rows.articles).toEqual([])
    // Taken out, or its blogroll deleted, it is no longer sent.
    later(10)
    await push([unroll(3)])
    const out = await pull(changed.cursor)
    await write(db.run(sql`update feeds set title = 'Again', seq = ${currentSeq} where id = 3`))
    expect((await pull(out.cursor)).rows.feeds).toEqual([])
    expect((await pull(0)).rows.feeds).toEqual([])
  })

  test('refuses a name with a control character, and a description or note with one other than a line break', async () => {
    await push([put(ID, 'Friends'), roll(1)])
    const res = await push([
      put('RollNULNULNU', '\u0000Friends'),
      put('RollTABTABTA', 'Tab\there'),
      put('RollBELLBELL', 'Bell', { description: 'Ring\u0007' }),
      put('RollLINELINE', 'Lines', { description: 'One\nTwo' }),
      note(1, 'Bad\u001bnote'),
      note(1, 'Good\nnote'),
    ])
    expect(res.rejected.map((r) => r.error)).toEqual([
      'invalid_name',
      'invalid_name',
      'invalid_text',
      'invalid_text',
    ])
    expect(await blogroll('RollLINELINE')).toMatchObject({ description: 'One\nTwo' })
    expect(await blog(1)).toMatchObject({ note: 'Good\nnote' })
  })

  test('refuses a bad id, an empty name, and text past its limit in characters, not UTF-16 units', async () => {
    const res = await push([
      put('short', 'Friends'),
      put('RollBLANKBLA', '   '),
      put('RollLONGLONG', 'x'.repeat(61)),
      put('RollDESCDESC', 'D', { description: 'x'.repeat(281) }),
      note(1, 'x'.repeat(281)),
    ])
    expect(res.rejected.map((r) => r.error)).toEqual([
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
    ])
    // Sixty emoji are sixty characters, though 120 UTF-16 units, and SQLite counts them so too.
    const emoji = '😀'.repeat(60)
    expect((await push([put('RollEMOJIEMO', emoji)])).rejected).toEqual([])
    expect((await blogroll('RollEMOJIEMO'))?.name).toBe(emoji)
  })

  test('past the limit a new blogroll is not made, though an edit still applies, and nothing is refused', async () => {
    const ids = Array.from({ length: MAX_BLOGROLLS }, (_, i) => `Roll${String(i).padStart(8, '0')}`)
    await push(ids.map((id, i) => put(id, `R${i}`)))
    later(10)
    const res = await push([put('RollOVEROVER', 'Over'), put(ids[0] as string, 'Renamed')])
    expect(res.rejected).toEqual([])
    expect(res.applied).toHaveLength(2)
    expect(await blogroll('RollOVEROVER')).toBeUndefined()
    expect((await blogroll(ids[0]))?.name).toBe('Renamed')
    // A deleted one frees its place.
    await push([{ type: 'deleteBlogroll', id: ids[1] }])
    await push([put('RollOVEROVER', 'Over')])
    expect((await blogroll('RollOVEROVER'))?.name).toBe('Over')
  })

  test('past the limit a new blog is not put in, though one in already can be, and one taken out frees a place', async () => {
    const feeds = Array.from({ length: MAX_BLOGROLL_BLOGS }, (_, i) => 100 + i)
    await write(
      db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at)
        select value, 1, 'https://many.example/' || value, 'many.example', 0, 0, 0
        from json_each(${JSON.stringify(feeds)})`),
    )
    await push([put(ID, 'Many')])
    for (let i = 0; i < feeds.length; i += 50)
      await push(feeds.slice(i, i + 50).map((f) => roll(f)))
    later(10)
    const res = await push([roll(1), roll(100)])
    expect(res.rejected).toEqual([])
    expect(await blog(1)).toBeUndefined()
    expect((await blog(100))?.updated_at).toBe(now)
    later(10)
    await push([unroll(101), roll(1)])
    expect((await blog(1))?.removed_at).toBeNull()
  })

  test('public or private counts only when a blogroll is made; after that an edit leaves it alone', async () => {
    await push([put(ID, 'Friends', { isPublic: false })])
    await push([put('RollPUBLICPU', 'Open', { isPublic: true })])
    later(10)
    await push([
      put(ID, 'Friends', { isPublic: true }),
      put('RollPUBLICPU', 'Open', { isPublic: false }),
    ])
    expect(await blogroll(ID)).toMatchObject({ is_public: 0, public_since: null })
    expect(await blogroll('RollPUBLICPU')).toMatchObject({ is_public: 1, public_version: 0 })
  })

  test('a show applies against the version it saw; a stale one after a hide is refused', async () => {
    await push([put(ID, 'Friends')])
    const head = (await pull(0)).cursor
    later(10)
    await push([show(ID, 0)])
    expect(await blogroll()).toMatchObject({ is_public: 1, public_version: 1, public_since: now })
    // Another device hid it; a show made before that hide, sent after it, names version 1.
    later(10)
    await push([hide(ID)])
    later(10)
    await push([show(ID, 1)])
    expect(await blogroll()).toMatchObject({ is_public: 0, public_version: 2 })
    // The device hears the row that beat it: stamped though nothing changed.
    expect((await pull(head)).rows.blogrolls).toMatchObject([{ isPublic: false, publicVersion: 2 }])
    // A show against the version its own hide made applies, whatever its clock says.
    await push([{ ...show(ID, 2), at: now - 1000 }])
    expect(await blogroll()).toMatchObject({ is_public: 1, public_version: 3 })
    // An old hide arriving after a newer show turns it off, failing closed.
    await push([{ ...hide(ID), at: now - 5000 }])
    expect(await blogroll()).toMatchObject({ is_public: 0, public_version: 4 })
  })

  test('first public is when it first went public: hiding and showing again never moves it, nor the name clock', async () => {
    await push([put(ID, 'Friends', { isPublic: true })])
    const since = now
    for (let v = 0; v < 4; v += 2) {
      later(10)
      await push([hide(ID)])
      later(10)
      await push([show(ID, v + 1)])
    }
    expect(await blogroll()).toMatchObject({
      is_public: 1,
      public_version: 4,
      public_since: since,
      updated_at: since,
    })
    // And one made private first goes public, for the first time, at the show.
    await push([put('RollLATERLAT', 'Later')])
    later(10)
    await push([show('RollLATERLAT', 0)])
    expect((await blogroll('RollLATERLAT'))?.public_since).toBe(now)
  })

  test('deleting wins: no later edit, switch, blog or note brings it back, and its blogs stay where they were', async () => {
    await push([put(ID, 'Gone'), roll(1), note(1, 'kept')])
    const head = (await pull(0)).cursor
    later(10)
    await push([{ type: 'deleteBlogroll', id: ID }])
    const delta = await pull(head)
    expect(delta.rows.blogrolls).toMatchObject([{ id: ID, deletedAt: now }])
    later(10)
    await push([put(ID, 'Back'), show(ID, 0), roll(2), unroll(1), note(1, 'changed')])
    expect(await blogroll()).toMatchObject({ name: 'Gone', is_public: 0, deleted_at: now - 10 })
    expect(await blog(2)).toBeUndefined()
    expect(await blog(1)).toMatchObject({ note: 'kept', removed_at: null })
    // Nothing of it in a snapshot, and its blogs' feeds are no longer sent.
    const snap = await pull(0)
    expect(snap.rows.blogrolls).toEqual([])
    expect(snap.rows.blogrollBlogs).toEqual([])
    expect(snap.rows.feeds).toEqual([])
  })

  test('two devices: the later of a put-in and a take-out wins, whatever order they arrive in', async () => {
    await push([put(ID, 'Friends'), roll(1), roll(2)])
    const t0 = now
    later(30)
    // Feed 1: taken out at t0 + 20, put back at t0 + 10; the take-out arrives first.
    await push([{ ...unroll(1), at: t0 + 20 }])
    await push([{ ...roll(1), at: t0 + 10 }])
    expect(await blog(1)).toMatchObject({ removed_at: t0 + 20, updated_at: t0 + 20 })
    // Feed 2: taken out at t0 + 10, put back at t0 + 20; the put-back arrives first.
    await push([{ ...roll(2), at: t0 + 20 }])
    await push([{ ...unroll(2), at: t0 + 10 }])
    expect(await blog(2)).toMatchObject({ removed_at: null, updated_at: t0 + 20, added_at: t0 })
  })

  test('a second take-out moves the clock, so a late put-back with an earlier `at` loses', async () => {
    await push([put(ID, 'Friends'), roll(1)])
    const t0 = now
    later(30)
    await push([{ ...unroll(1), at: t0 + 10 }])
    // Another device took it out too, at t0 + 25, not knowing; a third put it back at t0 + 20.
    await push([{ ...unroll(1), at: t0 + 25 }])
    await push([{ ...roll(1), at: t0 + 20 }])
    expect(await blog(1)).toMatchObject({ removed_at: t0 + 10, updated_at: t0 + 25 })
    // A take-out of a blog never put in writes nothing.
    await push([unroll(2)])
    expect(await blog(2)).toBeUndefined()
  })

  test('a note survives a take-out and a put-back, which goes to the end; a note never puts a blog back', async () => {
    await push([put(ID, 'Friends'), roll(1), note(1, 'Start here.')])
    const t0 = now
    later(10)
    await push([unroll(1)])
    later(10)
    await push([note(1, 'Still worth it.')])
    // Written on a blog taken out: kept, and the blog stays out.
    expect(await blog(1)).toMatchObject({ note: 'Still worth it.', removed_at: now - 10 })
    later(10)
    await push([roll(1)])
    expect(await blog(1)).toMatchObject({
      note: 'Still worth it.',
      removed_at: null,
      added_at: now,
    })
    expect(now).toBeGreaterThan(t0)
    // An older note loses on the note's own clock; a newer one clears it.
    await push([{ ...note(1, 'Older'), at: t0 + 5 }])
    expect((await blog(1))?.note).toBe('Still worth it.')
    later(10)
    await push([note(1, null)])
    expect(await blog(1)).toMatchObject({ note: null, note_at: now })
    // A note for a blog never put in writes nothing.
    await push([note(2, 'Nowhere')])
    expect(await blog(2)).toBeUndefined()
  })

  test("an id taken from another member's blogroll cannot edit, switch, delete, fill, empty or annotate it", async () => {
    await push([put(ID, 'Mine'), roll(1), note(1, 'mine')])
    const other = await signedIn(api, 'other@x.test')
    later(10)
    const res = await push(
      [
        put(ID, 'Theirs', { isPublic: true }),
        show(ID, 0),
        roll(2),
        unroll(1),
        note(1, 'theirs'),
        { type: 'deleteBlogroll', id: ID },
      ],
      other,
    )
    expect(res.rejected).toEqual([])
    expect(await blogroll()).toEqual({
      user_id: reader.userId,
      name: 'Mine',
      description: '',
      is_public: 0,
      public_version: 0,
      public_since: null,
      updated_at: now - 10,
      deleted_at: null,
    })
    expect(await blog(2)).toBeUndefined()
    expect(await blog(1)).toMatchObject({ note: 'mine', removed_at: null })
    const theirs = await pull(0, other)
    expect(theirs.rows.blogrolls).toEqual([])
    expect(theirs.rows.blogrollBlogs).toEqual([])
  })

  test('a blog under a feed that merged into another is put in, taken out and noted as the one it became', async () => {
    await db.run(sql`update feeds set status = 'paused', merged_into = 1 where id = 2`)
    await push([put(ID, 'Friends'), roll(2), note(2, 'Under its other address')])
    expect(await blog(2)).toBeUndefined()
    expect(await blog(1)).toMatchObject({ note: 'Under its other address', removed_at: null })
    later(10)
    await push([unroll(2)])
    expect((await blog(1))?.removed_at).toBe(now)
  })
})
