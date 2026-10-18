/**
 * The admin console's Hide from Discover for blogrolls (ADR 0050): Discover's Blogrolls filter
 * lists members' public blogrolls, and an operator hides one from Discover or restores it. The
 * Hide is the operator's alone: no device holds it, so it moves no seq, and it never touches
 * `updated_at`, the member's own clock for the name and description.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { first } from '@tela/data'
import type {
  AdminActResponse,
  AdminBlogrollDetail,
  AdminBlogrollRow,
  AdminList,
  AdminOverview,
} from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import {
  ADMIN_TOKEN,
  codeFor,
  cookiesOf,
  createTestApi,
  memberHeaders,
  type SignedIn,
  type TestApi,
} from './helpers'

const DAY = 24 * 3600 * 1000

let api: TestApi
let ops: SignedIn
let addresses = 0

/** Invite and sign in, each from an address of its own (better-auth's per-address limit). */
async function signedIn(email: string): Promise<SignedIn> {
  const invited = await api.request('/api/admin/invite', {
    body: { email },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  const { userId } = (await invited.json()) as { userId: string }
  const res = await api.request('/api/auth/sign-in/email-otp', {
    body: { email, otp: codeFor(api, email) },
    headers: { 'cf-connecting-ip': `10.8.0.${++addresses % 250}` },
  })
  expect(res.status).toBe(200)
  return { cookie: cookiesOf(res), userId, headers: memberHeaders(userId) }
}

async function member(email: string, handle: string, name: string | null = null) {
  const who = await signedIn(email)
  await api.db.run(
    sql`update profiles set handle = ${handle}, display_name = ${name} where user_id = ${who.userId}`,
  )
  return who
}

beforeEach(async () => {
  api = await createTestApi()
  ops = await signedIn('ops@x.test')
  const granted = await api.request('/api/admin/admins', {
    body: { email: 'ops@x.test', admin: true },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  expect(granted.status).toBe(200)
})

// ---------------------------------------------------------------------------------------------
// Fixtures: rows as a member's device and tela-api would have left them.

let homes = 0
/** A blog with one feed; `title` on the blog, `feedTitle` on the feed. */
async function addBlog(
  o: { title?: string | null; listing?: string; feedTitle?: string | null; siteId?: number } = {},
) {
  const now = api.clock.now()
  const n = ++homes
  let siteId = o.siteId
  if (siteId === undefined) {
    const [site] = await api.db.all<{ id: number }>(sql`
      insert into sites (home_url, title, listing, created_at, updated_at)
      values (${`https://blog${n}.test`}, ${o.title === undefined ? `Blog ${n}` : o.title},
        ${o.listing ?? 'listed'}, ${now}, ${now})
      returning id
    `)
    siteId = site?.id ?? 0
  }
  const [feed] = await api.db.all<{ id: number }>(sql`
    insert into feeds (site_id, feed_url, host, title, next_fetch_at, created_at, updated_at)
    values (${siteId}, ${`https://blog${n}.test/feed`}, ${`blog${n}.test`}, ${o.feedTitle ?? null},
      ${now + DAY}, ${now}, ${now})
    returning id
  `)
  return { siteId, feedId: feed?.id ?? 0 }
}

let rolls = 0
/** A blogroll, public since `publicSince` days ago unless private, with `feeds` in it in order. */
async function addBlogroll(
  owner: SignedIn,
  o: {
    name?: string
    description?: string
    isPublic?: boolean
    daysAgo?: number
    hiddenAt?: number | null
    deleted?: boolean
    feeds?: number[]
    removed?: number[]
  } = {},
): Promise<string> {
  const id = `Roll${String(++rolls).padStart(8, '0')}`
  const now = api.clock.now()
  const isPublic = o.isPublic ?? true
  const since = isPublic ? now - (o.daysAgo ?? 1) * DAY : null
  await api.db.run(sql`
    insert into blogrolls (id, user_id, name, description, is_public, public_version,
      public_since, hidden_at, created_at, updated_at, deleted_at, seq)
    values (${id}, ${owner.userId}, ${o.name ?? `Roll ${rolls}`}, ${o.description ?? ''},
      ${isPublic ? 1 : 0}, 1, ${since}, ${o.hiddenAt ?? null}, ${now - 30 * DAY},
      ${now - 20 * DAY}, ${o.deleted ? now : null}, 7)
  `)
  for (const [i, feedId] of (o.feeds ?? []).entries()) {
    const removed = o.removed?.includes(feedId) ? now : null
    await api.db.run(sql`
      insert into blogroll_blogs (blogroll_id, feed_id, user_id, added_at, updated_at,
        removed_at, seq)
      values (${id}, ${feedId}, ${owner.userId}, ${now - 10 * DAY + i}, ${now - 10 * DAY + i},
        ${removed}, 7)
    `)
  }
  return id
}

/** Three blogs, as a blogroll needs to be listed in Discover. */
async function threeFeeds() {
  return [(await addBlog()).feedId, (await addBlog()).feedId, (await addBlog()).feedId]
}

// ---------------------------------------------------------------------------------------------
// Calls.

async function list(f = 'blogrolls', q = '') {
  const params = new URLSearchParams({ f })
  if (q) params.set('q', q)
  const res = await api.request(`/api/v1/admin/discover?${params}`, { as: ops })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminList<AdminBlogrollRow, 'discover'>
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

async function record(id: string) {
  return api.request(`/api/v1/admin/blogrolls/${encodeURIComponent(id)}`, { as: ops })
}

async function act(action: string, targets: string[]) {
  const res = await api.request('/api/v1/admin/act', {
    as: ops,
    body: { action, ids: targets },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminActResponse
}

async function outcome(action: string, target: string) {
  const body = await act(action, [target])
  return body.done.length === 1 ? 'done' : body.failed[0]?.error
}

const undo = (group: string | undefined) =>
  api.request('/api/v1/admin/undo', { as: ops, body: { group } })

const blogrollOf = (id: string) =>
  first<{ hidden_at: number | null; updated_at: number; seq: number; name: string }>(
    api.db,
    sql`select hidden_at, updated_at, seq, name from blogrolls where id = ${id}`,
  )
const headSeq = async () =>
  (await first<{ v: number }>(api.db, sql`select v from counters where k = 'seq'`))?.v ?? 0

// ---------------------------------------------------------------------------------------------

describe('the Blogrolls filter', () => {
  test('lists public, live blogrolls only, the newest to go public first', async () => {
    const mara = await member('mara@x.test', 'mara', 'Mara')
    const feeds = await threeFeeds()
    const older = await addBlogroll(mara, { name: 'Older', daysAgo: 5, feeds })
    const newer = await addBlogroll(mara, { name: 'Newer', daysAgo: 1, feeds })
    const hidden = await addBlogroll(mara, { daysAgo: 3, hiddenAt: api.clock.now(), feeds })
    await addBlogroll(mara, { name: 'Private', isPublic: false, feeds })
    await addBlogroll(mara, { name: 'Deleted', deleted: true, feeds })

    const listed = await list()
    expect(ids(listed.rows)).toEqual([newer, hidden, older])
    expect(listed.counts.blogrolls).toBe(3)
    expect(listed.truncated).toBe(false)
    // Neither name of a blogroll its member keeps to themselves reaches the console.
    expect(JSON.stringify(listed)).not.toContain('Private')
    expect(JSON.stringify(listed)).not.toContain('Deleted')
    expect(listed.rows[0]).toMatchObject({
      id: newer,
      blogrollId: newer,
      name: 'Newer',
      owner: { id: mara.userId, handle: 'mara', name: 'Mara' },
      blogCount: 3,
      totalCount: 3,
      publicSince: api.clock.now() - DAY,
      hiddenAt: null,
      inDiscover: true,
      actions: ['blogroll.hide'],
    })
    expect(listed.rows[1]).toMatchObject({
      id: hidden,
      inDiscover: false,
      hiddenAt: api.clock.now(),
      actions: ['blogroll.restore'],
    })
  })

  test('counts the blogs others see, names the first three, and says whether Discover lists it', async () => {
    const mara = await member('mara@x.test', 'mara')
    const a = await addBlog({ title: 'Alpha' })
    const b = await addBlog({ title: 'Beta' })
    const rejected = await addBlog({ title: 'Rejected', listing: 'rejected' })
    const taken = await addBlog({ title: 'Taken out' })
    const untitled = await addBlog({ title: null })
    const few = await addBlogroll(mara, {
      feeds: [a.feedId, rejected.feedId, b.feedId, taken.feedId],
      removed: [taken.feedId],
    })
    // Two feeds of one blog keep their own names, so the two stay apart.
    const sibling = await addBlog({ siteId: a.siteId, feedTitle: 'Alpha notes' })
    const full = await addBlogroll(mara, {
      daysAgo: 2,
      feeds: [untitled.feedId, a.feedId, sibling.feedId, b.feedId],
    })

    const [one, two] = (await list()).rows
    expect(one).toMatchObject({
      id: few,
      blogCount: 2,
      totalCount: 3,
      inDiscover: false,
      blogs: [
        { feedId: a.feedId, siteId: a.siteId, name: 'Alpha', homeUrl: expect.any(String) },
        { feedId: b.feedId, name: 'Beta' },
      ],
    })
    expect(two).toMatchObject({ id: full, blogCount: 4, totalCount: 4, inDiscover: true })
    expect(two?.blogs.map((x) => x.name)).toEqual([null, 'Alpha', 'Alpha notes'])
  })

  test('searches by name, handle and id, and counts beside the blogs under every filter', async () => {
    const mara = await member('mara@x.test', 'mara')
    const kim = await member('kim@x.test', 'kimji')
    const feeds = await threeFeeds()
    const essays = await addBlogroll(mara, { name: 'Essays I return to', feeds })
    const kims = await addBlogroll(kim, { name: 'Small web', feeds })

    expect(ids((await list('blogrolls', 'essays')).rows)).toEqual([essays])
    expect(ids((await list('blogrolls', 'kimji')).rows)).toEqual([kims])
    expect(ids((await list('blogrolls', kims)).rows)).toEqual([kims])
    expect((await list('blogrolls', 'nothing')).rows).toEqual([])

    // A blog filter's answer carries the count too, under the same search.
    const blogs = await list('listed')
    expect(Object.keys(blogs.counts)).toEqual([
      'candidates',
      'featured',
      'listed',
      'dismissed',
      'hidden',
      'blogrolls',
    ])
    expect(blogs.counts).toMatchObject({ listed: 3, blogrolls: 2 })
    expect((await list('listed', 'small')).counts).toMatchObject({ listed: 0, blogrolls: 1 })
  })

  test('a record: every blog in its order, those an operator hid marked, and its history', async () => {
    const mara = await member('mara@x.test', 'mara')
    const a = await addBlog({ title: 'Alpha' })
    const rejected = await addBlog({ title: 'Rejected', listing: 'rejected' })
    const taken = await addBlog({ title: 'Taken out' })
    const id = await addBlogroll(mara, {
      name: 'Mine',
      description: 'Blogs I read\non the train',
      feeds: [rejected.feedId, a.feedId, taken.feedId],
      removed: [taken.feedId],
    })

    const hidden = await act('blogroll.hide', [id])
    expect((await undo(hidden.undo?.group)).status).toBe(200)
    const res = await record(id)
    expect(res.status).toBe(200)
    const detail = (await res.json()) as AdminBlogrollDetail
    expect(detail.blogroll).toMatchObject({
      id,
      name: 'Mine',
      description: 'Blogs I read\non the train',
      blogCount: 1,
      totalCount: 2,
      actions: ['blogroll.hide'],
    })
    expect(detail.blogs).toEqual([
      expect.objectContaining({ feedId: rejected.feedId, name: 'Rejected', shown: false }),
      expect.objectContaining({ feedId: a.feedId, name: 'Alpha', shown: true }),
    ])
    expect(detail.history.map((h) => h.action)).toEqual(['undo', 'blogroll.hide'])
    expect(detail.history[1]).toMatchObject({
      targetKind: 'blogroll',
      targetKey: id,
      actor: { id: ops.userId },
      to: { hiddenAt: api.clock.now() },
    })
  })

  test('a private, deleted, unknown or malformed blogroll has no record', async () => {
    const mara = await member('mara@x.test', 'mara')
    const secret = await addBlogroll(mara, { isPublic: false })
    const gone = await addBlogroll(mara, { deleted: true })
    for (const id of [secret, gone, 'Nobody123456', 'short', '12', 'Roll00000001x']) {
      expect({ id, status: (await record(id)).status }).toEqual({ id, status: 404 })
    }
  })
})

describe('Hide from Discover', () => {
  test('hides and restores, moving no seq and leaving the member’s clock alone', async () => {
    const mara = await member('mara@x.test', 'mara')
    const id = await addBlogroll(mara, { feeds: await threeFeeds() })
    const before = await blogrollOf(id)
    const seq = await headSeq()

    const hidden = await act('blogroll.hide', [id])
    expect(hidden.done).toEqual([id])
    expect(hidden.undo).not.toBeNull()
    expect(await blogrollOf(id)).toEqual({ ...before, hidden_at: api.clock.now() } as never)
    expect(await headSeq()).toBe(seq)
    expect((await list()).rows[0]).toMatchObject({
      inDiscover: false,
      actions: ['blogroll.restore'],
    })
    // Once is enough.
    expect(await outcome('blogroll.hide', id)).toBe('not_applicable')

    api.clock.advance(DAY)
    const restored = await act('blogroll.restore', [id])
    expect(restored.done).toEqual([id])
    expect(await blogrollOf(id)).toEqual(before as never)
    expect(await headSeq()).toBe(seq)
    expect((await list()).rows[0]).toMatchObject({ inDiscover: true, actions: ['blogroll.hide'] })
    expect(await outcome('blogroll.restore', id)).toBe('not_applicable')
  })

  test('each is undone while untouched, and the undo moves no seq either', async () => {
    const mara = await member('mara@x.test', 'mara')
    const id = await addBlogroll(mara, { feeds: await threeFeeds() })
    const before = await blogrollOf(id)
    const seq = await headSeq()

    const hidden = await act('blogroll.hide', [id])
    expect(await (await undo(hidden.undo?.group)).json()).toEqual({ restored: 1 })
    expect(await blogrollOf(id)).toEqual(before as never)
    // Undone once, the group is spent.
    expect((await undo(hidden.undo?.group)).status).toBe(409)

    const hiddenAgain = await act('blogroll.hide', [id])
    const at = api.clock.now()
    api.clock.advance(DAY)
    const restored = await act('blogroll.restore', [id])
    expect((await undo(restored.undo?.group)).status).toBe(200)
    expect(await blogrollOf(id)).toEqual({ ...before, hidden_at: at } as never)
    expect(await headSeq()).toBe(seq)
    expect(hiddenAgain.done).toEqual([id])
  })

  test('an undo is refused once something changed since', async () => {
    const mara = await member('mara@x.test', 'mara')
    const id = await addBlogroll(mara, { feeds: await threeFeeds() })

    // A Restore since stands in the way of undoing the Hide, and stays.
    const hidden = await act('blogroll.hide', [id])
    expect((await act('blogroll.restore', [id])).done).toEqual([id])
    expect(await (await undo(hidden.undo?.group)).json()).toEqual({ error: 'changed_since' })
    expect((await blogrollOf(id))?.hidden_at).toBeNull()

    // So does a Hide the log does not know about.
    const again = await act('blogroll.hide', [id])
    await api.db.run(sql`update blogrolls set hidden_at = 1 where id = ${id}`)
    expect((await undo(again.undo?.group)).status).toBe(409)
    expect((await blogrollOf(id))?.hidden_at).toBe(1)
  })

  test('the member’s own changes since do not stand in the way: the Hide is the operator’s', async () => {
    const mara = await member('mara@x.test', 'mara')
    const id = await addBlogroll(mara, { feeds: await threeFeeds() })
    const hidden = await act('blogroll.hide', [id])
    // The member renames it and makes it private: neither is the operator's choice.
    await api.db.run(sql`update blogrolls set name = 'Renamed', is_public = 0,
      updated_at = ${api.clock.now()} where id = ${id}`)
    expect((await undo(hidden.undo?.group)).status).toBe(200)
    expect(await blogrollOf(id)).toMatchObject({ hidden_at: null, name: 'Renamed' })
  })

  test('is refused on a private, deleted, unknown or malformed blogroll', async () => {
    const mara = await member('mara@x.test', 'mara')
    const feeds = await threeFeeds()
    const secret = await addBlogroll(mara, { isPublic: false, feeds })
    const gone = await addBlogroll(mara, { deleted: true, feeds })
    const hiddenSecret = await addBlogroll(mara, {
      isPublic: false,
      hiddenAt: api.clock.now(),
      feeds,
    })
    expect(await outcome('blogroll.hide', secret)).toBe('not_applicable')
    expect(await outcome('blogroll.hide', gone)).toBe('not_applicable')
    expect(await outcome('blogroll.restore', hiddenSecret)).toBe('not_applicable')
    expect(await outcome('blogroll.hide', 'Nobody123456')).toBe('not_found')
    expect(await outcome('blogroll.hide', '12')).toBe('not_found')
    expect((await blogrollOf(secret))?.hidden_at).toBeNull()
    expect((await blogrollOf(gone))?.hidden_at).toBeNull()
    // Nothing was audited for what did not change.
    const audited = await api.db.all(
      sql`select 1 from admin_actions where target_kind = 'blogroll'`,
    )
    expect(audited).toEqual([])
  })

  test('applies whatever its count, and hides several at once with one undo', async () => {
    const mara = await member('mara@x.test', 'mara')
    const lone = await addBlogroll(mara, { feeds: [(await addBlog()).feedId] })
    const empty = await addBlogroll(mara)
    const both = await act('blogroll.hide', [lone, empty])
    expect(both.done.sort()).toEqual([lone, empty].sort())
    expect(await (await undo(both.undo?.group)).json()).toEqual({ restored: 2 })
    expect((await blogrollOf(lone))?.hidden_at).toBeNull()
    expect((await blogrollOf(empty))?.hidden_at).toBeNull()
  })

  test('the Overview names it while others can open it, and not once its member made it private', async () => {
    const mara = await member('mara@x.test', 'mara')
    const id = await addBlogroll(mara, { name: 'Essays', feeds: await threeFeeds() })
    await act('blogroll.hide', [id])
    const overview = async () => {
      const res = await api.request('/api/v1/admin/overview', { as: ops })
      return ((await res.json()) as AdminOverview).activity[0]
    }
    expect(await overview()).toMatchObject({
      action: 'blogroll.hide',
      targetKind: 'blogroll',
      targetKey: id,
      label: 'Essays',
    })
    await api.db.run(sql`update blogrolls set is_public = 0 where id = ${id}`)
    expect(await overview()).toMatchObject({ targetKey: id, label: null })
  })
})
