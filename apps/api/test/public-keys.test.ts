/**
 * No public answer carries a content key (ADR 0066), for anyone: the key fetches the full post,
 * and a page cached for everyone, or walked by a script, must hand out none. The answers about
 * other members (the Following feed) carry none either. A member gets a post's key from their own
 * sync, or from `GET /api/v1/articles/:id`.
 *
 * Every GET route under `/api/v1/public` is found in Hono's own table, so a public route added
 * later is checked without being named here.
 */
import { beforeEach, expect, test } from 'bun:test'
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
