import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, first, recountReaders, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { likePattern } from '../src/routes/members'
import { DISCOVER_PAGE, PROFILE_CACHE, PUBLIC_CACHE } from '../src/routes/public'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let db: TelaDb
let reader: SignedIn

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

const put = (path: string, body: unknown, as = reader) =>
  api.request(path, { method: 'PUT', body, as })

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
    const taken = await put('/api/v1/profile', { handle: 'reader_1' }, other)
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'handle_taken' })
  })
})

describe("a blog's own settings", () => {
  test('only the member who claimed it may change them, and they sync', async () => {
    await blog(1, 'listed', reader.userId)
    const other = await signedIn(api, 'other@x.test')
    expect((await put('/api/v1/sites/1/translation', { optOut: true }, other)).status).toBe(403)
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
    const res = (await (await api.request('/api/v1/dashboard', { as: reader })).json()) as {
      sites: { id: number; posts: { title: string }[] }[]
      notes: { note: string; handle: string }[]
    }
    expect(res.sites.map((s) => s.id)).toEqual([1])
    expect(res.sites[0]?.posts.map((p) => p.title)).toEqual(['Post on blog 1'])
    expect(res.notes).toMatchObject([{ note: 'lovely', handle: expect.stringMatching(/^u_/) }])
  })

  test("says a blog's language, topics and new readers, each post's notes, and who wrote them", async () => {
    await blog(1, 'listed', reader.userId)
    const now = api.clock.now()
    const daysAgo = (n: number) => now - n * 24 * 60 * 60 * 1000
    const member = (id: string) =>
      db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
        values (${id}, ${id}, ${`${id}@x.test`}, 1, 0, 0)`)
    const sub = (userId: string, feedId: number, at: number, deletedAt: number | null = null) =>
      db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, deleted_at)
        values (${userId}, ${feedId}, ${at}, ${at}, ${deletedAt})`)
    await db.batch([
      bumpSeq(db),
      // Another address for the blog, merged into its feed (ADR 0028): its readers are the blog's.
      db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, status, merged_into,
          created_at, updated_at, seq)
        values (11, 1, 'https://blog1.example/atom', 'blog1.example', 0, 'paused', 1, 0, 0, ${currentSeq})`),
      db.run(sql`insert into articles (feed_id, dedup_key, title, fetched_at, sort_at, seq)
        values (1, 'quiet', 'Quiet post', 0, 0, ${currentSeq})`),
      ...['u-newcomer', 'u-longtime', 'u-left', 'u-twofeeds', 'u-merged'].map(member),
      db.run(sql`insert into profiles (user_id, handle, display_name, avatar_key, avatar_version,
          created_at, updated_at, seq)
        values ('u-newcomer', 'newcomer', 'New Comer', 'avatars/u-newcomer', 3, 0, 0, ${currentSeq})`),
      sub('u-newcomer', 1, daysAgo(5)),
      sub('u-longtime', 1, daysAgo(40)),
      sub('u-left', 1, daysAgo(2), daysAgo(1)),
      // Read the blog long before subscribing to its other address: not a new reader.
      sub('u-twofeeds', 1, daysAgo(60)),
      sub('u-twofeeds', 11, daysAgo(3)),
      sub('u-merged', 11, daysAgo(1)),
      ...recountReaders(db, sql`1`, now),
    ] as never)
    await put('/api/v1/sites/1/topics', { topics: ['tech', 'design'] })
    const post = await first<{ id: number }>(
      db,
      sql`select id from articles where dedup_key = 'p1'`,
    )
    await db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at,
        deleted_at)
      values ('u-newcomer', ${post?.id}, 'lovely', 5, 5, null),
        ('u-longtime', ${post?.id}, null, 6, 6, null),
        ('u-twofeeds', ${post?.id}, 'taken back', 7, 7, 8)`)

    const res = (await (await api.request('/api/v1/dashboard', { as: reader })).json()) as {
      sites: Record<string, unknown>[]
      notes: Record<string, unknown>[]
    }
    expect(res.sites[0]).toMatchObject({
      primaryLang: 'en',
      topics: ['design', 'tech'],
      // Four live readers, two of them new: the one who left and the two from before are not.
      readerCount: 4,
      newReaders30d: 2,
      posts: [
        { title: 'Post on blog 1', noteCount: 1 },
        { title: 'Quiet post', noteCount: 0 },
      ],
    })
    expect(res.notes).toEqual([
      {
        note: 'lovely',
        createdAt: 5,
        siteId: 1,
        articleId: post?.id,
        articleTitle: 'Post on blog 1',
        articleUrl: null,
        handle: 'newcomer',
        displayName: 'New Comer',
        avatar: '/avatar/u-newcomer?v=3',
      },
    ])
  })

  test('totals the whole blog, not the twenty posts listed, counting only live notes', async () => {
    await blog(1, 'listed', reader.userId)
    // Claimed, with no post yet: its totals are zero, not missing.
    await db.batch([
      bumpSeq(db),
      db.run(sql`insert into sites (id, home_url, title, listing, claimed_by, created_at, updated_at, seq)
        values (2, 'https://blog2.example', 'Blog 2', 'private', ${reader.userId}, 0, 0, ${currentSeq})`),
      // Twenty-one newer posts, a like each, push the first post out of the list.
      db.run(sql`insert into articles (feed_id, dedup_key, title, fetched_at, sort_at, like_count, seq)
        select 1, 'newer' || value, 'Newer ' || value, 0, 100 + value, 1, ${currentSeq}
        from json_each(${JSON.stringify(Array.from({ length: 21 }, (_, i) => i))}) where true`),
      db.run(sql`update articles set like_count = 2, recommend_count = 2 where dedup_key = 'p1'`),
    ] as never)
    const oldest = (
      await first<{ id: number }>(db, sql`select id from articles where dedup_key = 'p1'`)
    )?.id
    // Two live recommendations, as the post's counter says, one with a note; one taken back.
    await db.batch([
      db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
        values ('u-fan', 'u-fan', 'fan@x.test', 1, 0, 0),
          ('u-quiet', 'u-quiet', 'quiet@x.test', 1, 0, 0),
          ('u-gone', 'u-gone', 'gone@x.test', 1, 0, 0)`),
      db.run(sql`insert into profiles (user_id, handle, created_at, updated_at)
        values ('u-fan', 'fan', 0, 0), ('u-quiet', 'quiet', 0, 0), ('u-gone', 'gone', 0, 0)`),
      db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at,
          deleted_at)
        values ('u-fan', ${oldest}, 'lovely', 5, 5, null),
          ('u-quiet', ${oldest}, null, 6, 6, null),
          ('u-gone', ${oldest}, 'taken back', 7, 7, 8)`),
    ] as never)

    const res = (await (await api.request('/api/v1/dashboard', { as: reader })).json()) as {
      sites: { id: number; posts: { title: string }[]; totals: Record<string, number> }[]
      notes: { note: string }[]
    }
    const [one, two] = res.sites
    expect(one?.posts).toHaveLength(20)
    expect(one?.posts.map((p) => p.title)).not.toContain('Post on blog 1')
    // Its note is below the list, so the totals count it: twenty-two posts and every like.
    expect(res.notes.map((n) => n.note)).toEqual(['lovely'])
    expect(one?.totals).toEqual({ posts: 22, likes: 23, recommendations: 2, notes: 1 })
    expect(two).toMatchObject({
      id: 2,
      posts: [],
      totals: { posts: 0, likes: 0, recommendations: 0, notes: 0 },
    })
  })
})

describe('dashboard notes', () => {
  test("each blog keeps its own newest notes, so a busy blog never hides a quiet one's", async () => {
    await blog(1, 'listed', reader.userId)
    await blog(2, 'listed', reader.userId)
    const fan = await signedIn(api, 'fan@x.test')
    // Twenty-five newer notes on blog 1, each on a post of its own, and one older on blog 2.
    await db.batch([
      bumpSeq(db),
      ...Array.from({ length: 25 }, (_, i) =>
        db.run(sql`insert into articles (feed_id, dedup_key, title, fetched_at, sort_at, seq)
          values (1, ${`busy${i}`}, ${`Busy ${i}`}, 0, ${100 + i}, ${currentSeq})`),
      ),
    ] as never)
    await db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at)
      select ${fan.userId}, id, 'busy', 1000 + id, 1000 + id from articles
      where dedup_key like 'busy%'`)
    await db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at)
      select ${fan.userId}, id, 'quiet', 1, 1 from articles where dedup_key = 'p2'`)

    const res = (await (await api.request('/api/v1/dashboard', { as: reader })).json()) as {
      sites: { id: number; totals: { notes: number } }[]
      notes: { siteId: number; note: string; n?: number }[]
    }
    const of = (siteId: number) => res.notes.filter((n) => n.siteId === siteId)
    expect(of(1)).toHaveLength(20)
    expect(of(2).map((n) => n.note)).toEqual(['quiet'])
    expect(res.sites.map((s) => s.totals.notes)).toEqual([25, 1])
    expect(res.notes.every((n) => n.n === undefined)).toBe(true)
  })
})

describe('search', () => {
  test("finds public blogs, the member's private ones, and articles only in their feeds", async () => {
    await blog(1, 'listed', null, 'Gardening Notes')
    await blog(2, 'private', null, 'Garden Secrets')
    await blog(3, 'private', null, 'Gardeners Hidden')
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
      values (${reader.userId}, 2, 0, 0)`)
    const res = (await (await api.request('/api/v1/search?q=garden', { as: reader })).json()) as {
      sites: { id: number }[]
      articles: { feedId: number }[]
    }
    expect(res.sites.map((s) => s.id).sort()).toEqual([1, 2])
    const posts = (await (
      await api.request('/api/v1/search?q=post%20on', { as: reader })
    ).json()) as { articles: { feedId: number }[] }
    expect(posts.articles.map((a) => a.feedId)).toEqual([2])
  })

  test('a hit that matched its translation comes with it, in the language asked for', async () => {
    await blog(1, 'listed')
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
      values (${reader.userId}, 1, 0, 0)`)
    const article = await first<{ id: number }>(db, sql`select id from articles where feed_id = 1`)
    await db.run(sql`insert into article_titles (article_id, lang, feed_id, title, status, source_hash, updated_at)
      values (${article?.id}, 'zh-Hans', 1, '花园笔记', 'done', 'h', 0)`)
    const search = async (q: string) =>
      (await (
        await api.request(`/api/v1/search?q=${encodeURIComponent(q)}&lang=zh-Hans`, { as: reader })
      ).json()) as { articles: { title: string; translatedTitle: string | null }[] }
    expect((await search('花园')).articles).toMatchObject([
      { title: 'Post on blog 1', translatedTitle: '花园笔记' },
    ])
    expect((await search('Post on')).articles[0]?.translatedTitle).toBe('花园笔记')
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

  test('Discover pages past sixty blogs and says how many the filters match', async () => {
    // A bare `limit 60` dropped the newest blogs from All once the editorial list reached 110.
    const count = DISCOVER_PAGE + 5
    for (let id = 1; id <= count; id++) await blog(id, 'featured')
    type Page = { sites: { id: number }[]; total: number; page: number; pageSize: number }
    const read = async (query = '') =>
      (await (await get(`/api/v1/public/discover${query}`)).json()) as Page
    const one = await read()
    expect([one.total, one.page, one.pageSize, one.sites.length]).toEqual([
      count,
      1,
      DISCOVER_PAGE,
      DISCOVER_PAGE,
    ])
    const two = await read('?page=2')
    expect(two.page).toBe(2)
    expect(two.sites.map((s) => s.id)).toEqual([61, 62, 63, 64, 65])
    expect(new Set([...one.sites, ...two.sites].map((s) => s.id)).size).toBe(count)
    expect((await read('?page=3')).sites).toEqual([])
    for (const nonsense of ['?page=0', '?page=x', '?page=1.5', '?page=-2']) {
      expect((await read(nonsense)).page).toBe(1)
    }
  })

  test('no public answer says how a blog was listed (ADR 0041)', async () => {
    // Beside a held-back count, `listing` would tell a blog an operator listed from the review
    // queue (one member reads it) from an editorial pick nobody reads yet.
    await blog(1, 'listed')
    await blog(2, 'featured')
    const discover = (await (await get('/api/v1/public/discover')).json()) as {
      sites: Record<string, unknown>[]
    }
    expect(discover.sites).toHaveLength(2)
    for (const site of discover.sites) expect(site).not.toHaveProperty('listing')
    for (const id of [1, 2]) {
      const page = (await (await get(`/api/v1/public/sites/${id}`)).json()) as {
        site: Record<string, unknown>
      }
      expect(page.site.id).toBe(id)
      expect(page.site).not.toHaveProperty('listing')
    }
  })

  test('a reader count is public from three readers; below, it is neither shown nor ranked', async () => {
    for (const id of [1, 2, 3, 4]) await blog(id, 'listed')
    // An operator can list a blog one member reads (ADR 0041): 1, 2 and 0 readers must look alike.
    await db.run(sql`update sites set reader_count = case id
      when 1 then 1 when 2 then 2 when 3 then 0 else 3 end`)
    const discover = (await (await get('/api/v1/public/discover')).json()) as {
      sites: { id: number; readerCount: number | null }[]
    }
    expect(discover.sites.map((s) => [s.id, s.readerCount])).toEqual([
      [4, 3],
      [1, null],
      [2, null],
      [3, null],
    ])
    const page = async (id: number) =>
      (
        (await (await get(`/api/v1/public/sites/${id}`)).json()) as {
          site: { readerCount: unknown }
        }
      ).site.readerCount
    expect(await page(2)).toBeNull()
    expect(await page(4)).toBe(3)
    const found = (await (await api.request('/api/v1/search?q=blog', { as: reader })).json()) as {
      sites: { id: number; readerCount: number | null }[]
    }
    expect(found.sites[0]).toEqual(expect.objectContaining({ id: 4, readerCount: 3 }))
    expect(found.sites.filter((s) => s.id !== 4).map((s) => s.readerCount)).toEqual([
      null,
      null,
      null,
    ])
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

  test('a browser keeps a profile five minutes at most, a blog page and Discover a day', async () => {
    await put('/api/v1/profile', { handle: 'shown' })
    await blog(1, 'listed')
    const profile = await get('/api/v1/public/profiles/shown')
    expect(profile.headers.get('cache-control')).toBe(PROFILE_CACHE)
    // What Settings says beside the privacy switches: a change reaches the profile in minutes.
    const seconds = (name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(PROFILE_CACHE)?.[1])
    expect(seconds('max-age') + seconds('stale-while-revalidate')).toBeLessThanOrEqual(300)
    const site = await get('/api/v1/public/sites/1')
    expect(site.headers.get('cache-control')).toBe(PUBLIC_CACHE)
  })

  test('a blog shows its canonical feed, not a feed merged into it or its duplicate posts', async () => {
    await blog(1, 'listed')
    await db.batch([
      bumpSeq(db),
      db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, status, merged_into,
          created_at, updated_at, seq)
        values (7, 1, 'https://mirror.example/blog1', 'mirror.example', 0, 'paused', 1, 0, 0, ${currentSeq})`),
      db.run(sql`insert into articles (feed_id, dedup_key, title, fetched_at, sort_at, seq)
        values (7, 'mirror-p1', 'Post on blog 1', 0, 2, ${currentSeq})`),
    ] as never)
    const page = (await (await get('/api/v1/public/sites/1')).json()) as {
      feeds: { id: number }[]
      posts: unknown[]
    }
    expect(page.feeds.map((f) => f.id)).toEqual([1])
    expect(page.posts).toHaveLength(1)
    const discover = (await (await get('/api/v1/public/discover')).json()) as {
      sites: { feedId: number; latestAt: number }[]
    }
    expect(discover.sites[0]).toMatchObject({ feedId: 1, latestAt: 1 })
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
    await api.request('/api/v1/mutations', {
      body: {
        mutations: [
          { mid: 'show-subs-0001', at: 1, type: 'setPrivacy', publicSubscriptions: true },
        ],
      },
      as: reader,
    })
    const shown = (await (await get('/api/v1/public/profiles/shown')).json()) as {
      subscriptions: { id: number; listed: boolean }[]
    }
    expect(shown.subscriptions).toEqual([
      {
        id: 1,
        title: 'Blog 1',
        homeUrl: 'https://blog1.example',
        description: null,
        faviconKey: null,
        listed: true,
      },
    ] as never)
    expect((await get('/api/v1/public/profiles/nobody')).status).toBe(404)
    expect(JSON.stringify(shown)).not.toContain('@x.test')
  })

  test("a profile carries the member's picture only while their Gravatar is on (ADR 0032)", async () => {
    await put('/api/v1/profile', { handle: 'shown' })
    const page = async () => (await get('/api/v1/public/profiles/shown')).json()
    const avatar = async () =>
      ((await page()) as { profile: { avatar: string | null } }).profile.avatar
    expect(await avatar()).toBeNull()
    // Gravatar has a picture for them, as the check found (ADR 0033).
    await db.run(sql`update profiles set gravatar_found = 1 where user_id = ${reader.userId}`)
    await api.request('/api/v1/mutations', {
      body: { mutations: [{ mid: 'gravatar-on-0001', at: 42, type: 'setAvatar', gravatar: true }] },
      as: reader,
    })
    expect(await avatar()).toBe(`/avatar/${reader.userId}?v=1`)
    // The address it is fetched by is never in the page, nor its hash.
    expect(JSON.stringify(await page())).not.toContain('@x.test')
    expect(JSON.stringify(await page())).not.toContain('gravatar.com')
  })

  describe('the social side (ADR 0031)', () => {
    const OTHER = 'member-other-000001'
    /** Someone who never signs in here, following or followed. */
    async function person(id: string, handle: string, bio: string | null = null) {
      await db.batch([
        bumpSeq(db),
        db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
          values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
        db.run(sql`insert into profiles (user_id, handle, display_name, bio, created_at, updated_at, seq)
          values (${id}, ${handle}, ${`Name ${handle}`}, ${bio}, 0, 0, ${currentSeq})`),
      ] as never)
    }
    const mutate = (mutations: Record<string, unknown>[], as = reader) =>
      api.request('/api/v1/mutations', {
        body: {
          mutations: mutations.map((m, i) => ({
            mid: `social-${i}-${Math.random()}`,
            at: api.clock.now(),
            ...m,
          })),
        },
        as,
      })
    type Profile = {
      profile: { id: string }
      counts: Record<string, number | null>
      liked: { likedAt: number; listed: boolean; article: { id: number } }[] | null
      recommendations: { note: string | null; listed: boolean }[]
    }

    test('a profile counts follows and recommendations, and shows likes only once chosen', async () => {
      await put('/api/v1/profile', { handle: 'shown' })
      await person(OTHER, 'other')
      await blog(1, 'listed')
      await blog(2, 'private')
      await db.run(sql`insert into follows (follower_id, followee_id, created_at, updated_at)
        values (${OTHER}, ${reader.userId}, 0, 0)`)
      await mutate([
        { type: 'follow', userId: OTHER },
        { type: 'setLiked', articleId: 1, liked: true },
        { type: 'setLiked', articleId: 2, liked: true },
        { type: 'recommend', articleId: 1, note: 'read this' },
      ])
      const hidden = (await (await get('/api/v1/public/profiles/shown')).json()) as Profile
      expect(hidden.profile.id).toBe(reader.userId)
      expect(hidden.counts).toEqual({
        following: 1,
        followers: 1,
        recommendations: 1,
        liked: null,
        subscriptions: null,
      })
      expect(hidden.liked).toBeNull()
      expect(hidden.recommendations).toMatchObject([{ note: 'read this', listed: true }])

      await mutate([{ type: 'setPrivacy', publicLikes: true }])
      const shown = (await (await get('/api/v1/public/profiles/shown')).json()) as Profile
      expect(shown.counts.liked).toBe(2)
      // A post from a private blog shows, without a page to link to.
      expect(shown.liked?.map((l) => [l.article.id, l.listed]).sort()).toEqual([
        [1, true],
        [2, false],
      ])
      expect(JSON.stringify(shown)).not.toContain('@x.test')
    })

    test('an unfollow leaves the counts; a follow of a stranger is theirs to count', async () => {
      await put('/api/v1/profile', { handle: 'shown' })
      await person(OTHER, 'other')
      await mutate([{ type: 'follow', userId: OTHER }])
      await mutate([{ type: 'unfollow', userId: OTHER }])
      const mine = (await (await get('/api/v1/public/profiles/shown')).json()) as Profile
      expect(mine.counts.following).toBe(0)
      await mutate([{ type: 'follow', userId: OTHER }])
      const theirs = (await (await get('/api/v1/public/profiles/other')).json()) as Profile
      expect(theirs.counts.followers).toBe(1)
    })

    test("a blog's page names who writes it and what readers said of its posts", async () => {
      await put('/api/v1/profile', {
        handle: 'writer',
        displayName: 'The Writer',
        bio: 'I write here.',
      })
      await blog(1, 'listed', reader.userId)
      await person(OTHER, 'other')
      await db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at)
        values (${OTHER}, 1, 'lovely', 5, 5), (${reader.userId}, 1, null, 6, 6)`)
      const page = (await (await get('/api/v1/public/sites/1')).json()) as {
        site: { claimedBy: string; claimant: unknown; postsLast30d: number }
        notes: { note: string; person: { handle: string }; article: { id: number } }[]
      }
      expect(page.site.claimedBy).toBe('writer')
      expect(page.site.claimant).toEqual({
        handle: 'writer',
        displayName: 'The Writer',
        bio: 'I write here.',
        avatar: null,
      })
      // Only a recommendation with a note is a note.
      expect(page.notes).toMatchObject([
        { note: 'lovely', person: { handle: 'other', displayName: 'Name other' } },
      ])
      // Posts carry their titles in the launch languages, for each reader to pick theirs.
      await db.run(sql`insert into article_titles (article_id, feed_id, lang, title, status, source_hash, updated_at, seq)
        values (1, 1, 'zh-Hans', '博客一的文章', 'done', 'h', 0, 1)`)
      const titled = (await (await get('/api/v1/public/sites/1')).json()) as {
        posts: { titles: Record<string, string> }[]
      }
      expect(titled.posts[0]?.titles).toEqual({ 'zh-Hans': '博客一的文章' })
      expect(JSON.stringify(page)).not.toContain('@x.test')
    })
  })
})
