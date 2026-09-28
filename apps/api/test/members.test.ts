import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, first, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { likePattern } from '../src/routes/members'
import { PUBLIC_CACHE } from '../src/routes/public'
import { createTestApi, signedIn, type TestApi } from './helpers'

let api: TestApi
let db: TelaDb
let reader: { cookie: string; userId: string }

async function blog(
  id: number,
  listing: string,
  claimedBy: string | null = null,
  title = `Blog ${id}`,
) {
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, title, listing, claimed_by, primary_lang, created_at, updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${title}, ${listing}, ${claimedBy}, 'en', 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0, 0, 0, ${currentSeq})`),
    db.run(sql`insert into articles (feed_id, dedup_key, title, fetched_at, sort_at, seq)
      values (${id}, ${`p${id}`}, ${`Post on blog ${id}`}, 0, ${id}, ${currentSeq})`),
  ] as never)
}

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  reader = await signedIn(api)
})

const put = (path: string, body: unknown, cookie = reader.cookie) =>
  api.request(path, { method: 'PUT', body, cookie })

describe('profile', () => {
  test('sets a handle, name and bio, and refuses bad or taken handles', async () => {
    const ok = await put('/api/v1/profile', {
      handle: ' Reader_1 ',
      displayName: '  R  ',
      bio: 'b',
    })
    expect(await ok.json()).toEqual({ ok: true, handle: 'reader_1' })
    const row = await first<{ display_name: string; bio: string }>(
      db,
      sql`select display_name, bio from profiles where user_id = ${reader.userId}`,
    )
    expect(row).toEqual({ display_name: 'R', bio: 'b' })
    expect((await put('/api/v1/profile', { handle: 'ab' })).status).toBe(400)
    expect((await put('/api/v1/profile', { handle: 'admin' })).status).toBe(400)
    const other = await signedIn(api, 'other@x.test')
    const taken = await put('/api/v1/profile', { handle: 'reader_1' }, other.cookie)
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'handle_taken' })
  })
})

describe("a blog's own settings", () => {
  test('only the member who claimed it may change them, and they sync', async () => {
    await blog(1, 'listed', reader.userId)
    const other = await signedIn(api, 'other@x.test')
    expect((await put('/api/v1/sites/1/translation', { optOut: true }, other.cookie)).status).toBe(
      403,
    )
    const before =
      (await first<{ seq: number }>(db, sql`select seq from sites where id = 1`))?.seq ?? 0
    expect(await (await put('/api/v1/sites/1/translation', { optOut: true })).json()).toEqual({
      optOut: true,
    })
    expect(
      await (await put('/api/v1/sites/1/topics', { topics: ['tech', 'nope', 'tech'] })).json(),
    ).toEqual({
      topics: ['tech'],
    })
    const site = await first<{ translation_opt_out: number; seq: number }>(
      db,
      sql`select translation_opt_out, seq from sites where id = 1`,
    )
    expect(site?.translation_opt_out).toBe(1)
    expect(site?.seq).toBeGreaterThan(before)
  })
})

describe('dashboard', () => {
  test("shows the member's blogs with their posts and the notes readers left", async () => {
    await blog(1, 'listed', reader.userId)
    await blog(2, 'listed') // not theirs
    const fan = await signedIn(api, 'fan@x.test')
    await db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at)
      values (${fan.userId}, 1, 'lovely', 5, 5)`)
    const res = (await (
      await api.request('/api/v1/dashboard', { cookie: reader.cookie })
    ).json()) as {
      sites: { id: number; posts: { title: string }[] }[]
      notes: { note: string; handle: string }[]
    }
    expect(res.sites.map((s) => s.id)).toEqual([1])
    expect(res.sites[0]?.posts.map((p) => p.title)).toEqual(['Post on blog 1'])
    expect(res.notes).toMatchObject([{ note: 'lovely', handle: expect.stringMatching(/^u_/) }])
  })
})

describe('search', () => {
  test("finds public blogs, the member's private ones, and articles only in their feeds", async () => {
    await blog(1, 'listed', null, 'Gardening Notes')
    await blog(2, 'private', null, 'Garden Secrets')
    await blog(3, 'private', null, 'Gardeners Hidden')
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
      values (${reader.userId}, 2, 0, 0)`)
    const res = (await (
      await api.request('/api/v1/search?q=garden', { cookie: reader.cookie })
    ).json()) as { sites: { id: number }[]; articles: { feedId: number }[] }
    expect(res.sites.map((s) => s.id).sort()).toEqual([1, 2])
    const posts = (await (
      await api.request('/api/v1/search?q=post%20on', { cookie: reader.cookie })
    ).json()) as { articles: { feedId: number }[] }
    expect(posts.articles.map((a) => a.feedId)).toEqual([2])
  })

  test('treats LIKE wildcards as text', () => {
    expect(likePattern('  100%  _off ')).toBe('%100\\% \\_off%')
    expect(likePattern('   ')).toBeNull()
  })
})

describe('public', () => {
  const get = (path: string) => api.request(path) // no session
  test('Discover lists listed and featured blogs only, featured first, cached at the edge', async () => {
    await blog(1, 'listed')
    await blog(2, 'featured')
    await blog(3, 'private')
    await blog(4, 'rejected')
    const res = await get('/api/v1/public/discover')
    expect(res.headers.get('cache-control')).toBe(PUBLIC_CACHE)
    const body = (await res.json()) as { sites: { id: number }[]; languages: unknown[] }
    expect(body.sites.map((s) => s.id)).toEqual([2, 1])
    expect(body.languages).toEqual([{ lang: 'en', count: 2 }])
  })

  test("a private blog's page is not found, a listed one's is", async () => {
    await blog(1, 'listed', reader.userId)
    await blog(2, 'private')
    expect((await get('/api/v1/public/sites/2')).status).toBe(404)
    const page = (await (await get('/api/v1/public/sites/1')).json()) as {
      site: { claimedBy: string }
      posts: unknown[]
    }
    expect(page.site.claimedBy).toMatch(/^u_/)
    expect(page.posts).toHaveLength(1)
  })

  test('a profile shows its public side only', async () => {
    await put('/api/v1/profile', { handle: 'shown', bio: 'hello' })
    await blog(1, 'listed')
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
      values (${reader.userId}, 1, 0, 0)`)
    const hidden = (await (await get('/api/v1/public/profiles/shown')).json()) as {
      profile: { bio: string }
      subscriptions: unknown
    }
    expect(hidden.profile.bio).toBe('hello')
    expect(hidden.subscriptions).toBeNull()
    await put('/api/v1/profile', { publicSubscriptions: true })
    const shown = (await (await get('/api/v1/public/profiles/shown')).json()) as {
      subscriptions: { id: number; listed: boolean }[]
    }
    expect(shown.subscriptions).toEqual([
      { id: 1, title: 'Blog 1', homeUrl: 'https://blog1.example', listed: true },
    ] as never)
    expect((await get('/api/v1/public/profiles/nobody')).status).toBe(404)
    expect(JSON.stringify(shown)).not.toContain('@x.test')
  })
})
