/**
 * No public answer carries a content key (ADR 0066), for anyone: the key fetches the full post,
 * and a page cached for everyone, or walked by a script, must hand out none. The answers about
 * other members (the Following feed) carry none either. A member gets a post's key from their own
 * sync, or from `GET /api/v1/articles/:id`.
 *
 * Every GET route under `/api/v1/public` is found in Hono's own table, so a public route added
 * later is checked without being named here.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

const SECRET = 'secret-content-key'
const ROLL = 'rollAAAAAAAA'

let api: TestApi
let db: TelaDb
let writer: SignedIn
let viewer: SignedIn

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  writer = await signedIn(api, 'writer@x.test')
  viewer = await signedIn(api, 'viewer@x.test')
  const now = api.clock.now()
  const old = now - 30 * 86_400_000
  await db.batch([
    bumpSeq(db),
    // A week and more old, showing what they read and like: on every public page there is.
    db.run(sql`update profiles set handle = 'writer', created_at = ${old}, public_likes = 1,
        public_subscriptions = 1, seq = ${currentSeq}
      where user_id = ${writer.userId}`),
    ...[1, 2, 3].map((id) =>
      db.run(sql`insert into sites (id, home_url, title, listing, review, claimed_by, created_at,
          updated_at, seq)
        values (${id}, ${`https://blog${id}.example`}, ${`Blog ${id}`}, 'listed', 'listed',
          ${id === 1 ? writer.userId : null}, ${old}, 0, ${currentSeq})`),
    ),
    ...[1, 2, 3].map((id) =>
      db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
          updated_at, seq)
        values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0, 0, 0,
          ${currentSeq})`),
    ),
    ...[1, 2, 3].map((id) =>
      db.run(sql`insert into articles (id, feed_id, dedup_key, title, url, fetched_at, sort_at,
          source_lang, content_key, seq)
        values (${id}, ${id}, ${`k${id}`}, ${`Post ${id}`}, ${`https://blog${id}.example/${id}`},
          ${now}, ${now - id * 1000}, 'en', ${`${SECRET}-${id}`}, ${currentSeq})`),
    ),
    db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, seq)
      values (${writer.userId}, 1, ${now}, ${now}, ${currentSeq})`),
    db.run(sql`insert into user_article_states (user_id, article_id, read_at, liked_at,
        liked_updated_at, seq)
      values (${writer.userId}, 2, ${now}, ${now}, ${now}, ${currentSeq})`),
    // Recommended by two, so it is the writer's early find too.
    db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at,
        seq)
      values (${writer.userId}, 1, 'Worth it', ${now - 2000}, ${now - 2000}, ${currentSeq}),
        (${viewer.userId}, 1, null, ${now - 1000}, ${now - 1000}, ${currentSeq})`),
    db.run(sql`update articles set recommend_count = 2 where id = 1`),
    db.run(sql`insert into blogrolls (id, user_id, name, description, is_public, public_version,
        public_since, created_at, updated_at, seq)
      values (${ROLL}, ${writer.userId}, 'Mine', '', 1, 1, 1, 1, 1, ${currentSeq})`),
    ...[1, 2, 3].map((id) =>
      db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, note_at, added_at,
          updated_at, seq)
        values (${ROLL}, ${id}, ${writer.userId}, 0, ${id}, ${id}, ${currentSeq})`),
    ),
    db.run(sql`insert into follows (follower_id, followee_id, created_at, updated_at, seq)
      values (${viewer.userId}, ${writer.userId}, ${now}, ${now}, ${currentSeq})`),
  ] as never)
})

/** Each route's parameters, by name: the rows above. */
const PARAMS: Record<string, () => string> = {
  userId: () => writer.userId,
  siteId: () => '1',
  handle: () => 'writer',
  id: () => ROLL,
  kind: () => 'sites',
}

function publicPaths(): string[] {
  const paths = new Set<string>()
  for (const route of api.app.routes) {
    if (route.method !== 'GET' || !route.path.startsWith('/api/v1/public')) continue
    paths.add(
      route.path.replace(/:(\w+)/g, (_, name: string) => {
        const value = PARAMS[name]
        if (!value) throw new Error(`no value for :${name} in ${route.path}`)
        return value()
      }),
    )
  }
  return [...paths]
}

test('no public answer carries a content key, whoever asks', async () => {
  const paths = publicPaths()
  expect(paths.length).toBeGreaterThan(10)
  for (const path of paths) {
    for (const as of [undefined, viewer]) {
      const res = await api.request(path, as ? { as } : {})
      // A member with no picture is a 404 at their avatar; nothing else here may fail.
      expect(res.status, path).toBeLessThan(path.includes('/avatars/') ? 500 : 400)
      const text = await res.text()
      expect(text.includes('contentKey'), `${path} names a content key`).toBe(false)
      expect(text.includes(SECRET), `${path} carries a content key`).toBe(false)
    }
  }
})

test('the answers checked do carry the posts, without their keys', async () => {
  const json = async <T>(path: string) => (await (await api.request(path)).json()) as T
  const articles = await json<{ posts: { article: { id: number } }[] }>(
    '/api/v1/public/discover/articles',
  )
  expect(articles.posts.map((p) => p.article.id)).toEqual([1, 2, 3])
  const site = await json<{ posts: { id: number }[] }>('/api/v1/public/sites/1')
  expect(site.posts.map((p) => p.id)).toEqual([1])
  const profile = await json<{ recommendations: unknown[]; liked: unknown[] }>(
    '/api/v1/public/profiles/writer',
  )
  expect([profile.recommendations.length, profile.liked.length]).toEqual([1, 1])
  const week = await json<{ recommended: unknown[] }>('/api/v1/public/discover/week')
  expect(week.recommended.length).toBe(1)
  const front = await json<{ edition: { posts: unknown[] } }>('/api/v1/public/front')
  expect(front.edition.posts.length).toBe(3)
})

test('nor does the Following feed, which shows other members’ posts', async () => {
  const res = await api.request('/api/v1/following', { as: viewer })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text.includes('Post 1')).toBe(true)
  expect(text.includes('contentKey') || text.includes(SECRET)).toBe(false)
})

describe('a post by id', () => {
  test('gives a member the row their device holds, content key and all, with its feed and blog', async () => {
    const res = await api.request('/api/v1/articles/2', { as: viewer })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const held = (await res.json()) as {
      article: Record<string, unknown>
      feed: Record<string, unknown>
      site: Record<string, unknown>
    }
    expect(held.article).toMatchObject({ id: 2, feedId: 2, contentKey: `${SECRET}-2` })
    expect(held.feed).toMatchObject({ id: 2, siteId: 2, feedUrl: 'https://blog2.example/feed' })
    expect(held.site).toMatchObject({ id: 2, owned: false, claimed: false })
    expect(held.site.translationOptOut).toBe(false)
    // The blog's claimant holds it as their own.
    const own = await api.request('/api/v1/articles/1', { as: writer })
    expect(((await own.json()) as { site: { owned: boolean } }).site.owned).toBe(true)
  })

  describe('of a blog a member added privately', () => {
    // Ids are sequential, so a post anyone may open by id is every post Tela holds: a private
    // blog's too, with its feed's address, which may carry a token of its writer's.
    beforeEach(async () => {
      const now = api.clock.now()
      await db.batch([
        bumpSeq(db),
        ...[4, 5].map((id) =>
          db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at, seq)
            values (${id}, ${`https://private${id}.example`}, ${`Private ${id}`}, 'private', 0, 0,
              ${currentSeq})`),
        ),
        ...[4, 5].map((id) =>
          db.run(sql`insert into feeds (id, site_id, feed_url, host, last_error, next_fetch_at,
              created_at, updated_at, seq)
            values (${id}, ${id}, ${`https://private${id}.example/feed?token=s3cret`},
              ${`private${id}.example`}, 'http 500', 0, 0, 0, ${currentSeq})`),
        ),
        ...[4, 5].map((id) =>
          db.run(sql`insert into articles (id, feed_id, dedup_key, title, url, fetched_at, sort_at,
              source_lang, content_key, extract_state, seq)
            values (${id}, ${id}, ${`k${id}`}, ${`Private post ${id}`},
              ${`https://private${id}.example/${id}`}, ${now}, ${now}, 'en', ${`${SECRET}-${id}`},
              'due', ${currentSeq})`),
        ),
        // Blog 5 is in the writer's public blogroll, whose page names it to anyone.
        db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, note_at, added_at,
            updated_at, seq)
          values (${ROLL}, 5, ${writer.userId}, 0, 5, 5, ${currentSeq})`),
      ] as never)
    })

    const open = (id: number, as: SignedIn) => api.request(`/api/v1/articles/${id}`, { as })

    test('is not found for a member who neither follows it nor keeps the post', async () => {
      const res = await open(4, viewer)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('s3cret')
    })

    test('is the subscriber’s, whole, as their own sync sends it', async () => {
      await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, seq)
        values (${viewer.userId}, 4, 0, 0, 1)`)
      const res = await open(4, viewer)
      expect(res.status).toBe(200)
      const held = (await res.json()) as {
        article: Record<string, unknown>
        feed: Record<string, unknown>
      }
      expect(held.article).toMatchObject({ id: 4, contentKey: `${SECRET}-4`, extractState: 'due' })
      expect(held.feed).toMatchObject({ id: 4, lastError: 'http 500' })
    })

    test('is a keeper’s: a post liked, recommended or highlighted', async () => {
      const now = api.clock.now()
      await db.run(sql`insert into user_article_states (user_id, article_id, read_at, liked_at,
          liked_updated_at, seq)
        values (${viewer.userId}, 4, ${now}, ${now}, ${now}, 1)`)
      expect((await open(4, viewer)).status).toBe(200)
      await db.run(sql`update user_article_states set liked_at = null where article_id = 4`)
      expect((await open(4, viewer)).status).toBe(404)
      await db.run(sql`insert into recommendations (user_id, article_id, created_at, updated_at,
          seq)
        values (${viewer.userId}, 4, ${now}, ${now}, 1)`)
      expect((await open(4, viewer)).status).toBe(200)
    })

    test('is anyone’s once a public blogroll names its blog, without what only a follower sees', async () => {
      const res = await open(5, viewer)
      expect(res.status).toBe(200)
      const held = (await res.json()) as {
        article: Record<string, unknown>
        feed: Record<string, unknown>
      }
      expect(held.article).toMatchObject({ id: 5, contentKey: `${SECRET}-5`, extractState: 'none' })
      expect(held.feed).toMatchObject({ id: 5, lastError: null })
      // Made private, or its owner suspended, the blogroll names it to nobody.
      await db.run(sql`update blogrolls set is_public = 0 where id = ${ROLL}`)
      expect((await open(5, viewer)).status).toBe(404)
    })

    test('is anyone’s once a profile shows it: recommended, or liked by one who shows likes', async () => {
      const now = api.clock.now()
      await db.run(sql`insert into user_article_states (user_id, article_id, read_at, liked_at,
          liked_updated_at, seq)
        values (${writer.userId}, 4, ${now}, ${now}, ${now}, 1)`)
      expect((await open(4, viewer)).status).toBe(200)
      await db.run(sql`update profiles set public_likes = 0 where user_id = ${writer.userId}`)
      expect((await open(4, viewer)).status).toBe(404)
      await db.run(sql`insert into recommendations (user_id, article_id, created_at, updated_at,
          seq)
        values (${writer.userId}, 4, ${now}, ${now}, 1)`)
      const held = (await (await open(4, viewer)).json()) as { feed: Record<string, unknown> }
      expect(held.feed.lastError).toBe(null)
      // Not a suspended member's (ADR 0059).
      await db.run(sql`update profiles set suspended_at = 1 where user_id = ${writer.userId}`)
      expect((await open(4, viewer)).status).toBe(404)
    })

    test('a listed blog’s post is anyone’s, without what only a follower sees', async () => {
      await db.run(sql`update feeds set last_error = 'http 500' where id = 3`)
      await db.run(sql`update articles set extract_state = 'failed' where id = 3`)
      const held = (await (await open(3, viewer)).json()) as {
        article: Record<string, unknown>
        feed: Record<string, unknown>
      }
      expect(held.article.extractState).toBe('none')
      expect(held.feed.lastError).toBe(null)
    })
  })

  test('is nothing for a post Tela does not hold, and only for a member in good standing', async () => {
    for (const id of ['99', 'abc', '0', '-1']) {
      expect((await api.request(`/api/v1/articles/${id}`, { as: viewer })).status).toBe(404)
    }
    expect((await api.request('/api/v1/articles/1')).status).toBe(401)
    // Suspended, whatever copy of the session the cookie still carries (ADR 0059).
    await db.run(sql`update profiles set suspended_at = 1 where user_id = ${viewer.userId}`)
    expect((await api.request('/api/v1/articles/1', { as: viewer })).status).toBe(401)
  })
})
