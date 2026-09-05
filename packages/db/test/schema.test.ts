import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import {
  articles,
  feeds,
  llmUsage,
  profiles,
  recommendations,
  sites,
  subscriptions,
} from '../src/schema'
import { asUser, startTestDb, type TestDb } from './harness'

let t: TestDb

/** Drizzle wraps Postgres errors; the constraint or policy name lives on the cause. */
async function pgError(p: PromiseLike<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause
    return cause?.message ?? (err as Error).message
  }
}
const userA = '11111111-1111-4111-8111-111111111111'
const userB = '22222222-2222-4222-8222-222222222222'

beforeAll(async () => {
  t = await startTestDb()
  await t.db.execute(
    sql`insert into auth.users (id, email, raw_user_meta_data) values
      (${userA}, 'a@example.com', '{"full_name":"Ada"}'::jsonb),
      (${userB}, 'b@example.com', '{}'::jsonb)`,
  )
}, 120_000)

afterAll(async () => {
  await t?.stop()
})

describe('migrations', () => {
  test('create the expected tables', async () => {
    const rows = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    )
    const names = rows.map((r) => r.table_name)
    for (const expected of [
      'profiles',
      'sites',
      'feeds',
      'articles',
      'article_contents',
      'translations',
      'article_translations',
      'subscriptions',
      'user_article_states',
      'recommendations',
      'site_claims',
      'llm_usage',
    ]) {
      expect(names).toContain(expected)
    }
  })

  test('every public table has RLS enabled', async () => {
    const rows = await t.db.execute<{ relname: string; relrowsecurity: boolean }>(
      sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '__drizzle_migrations'`,
    )
    const off = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)
    expect(off).toEqual([])
  })

  test('no policy grants a write: the Data API path is read-only', async () => {
    const rows = await t.db.execute<{ policyname: string; cmd: string }>(
      sql`select policyname, cmd from pg_policies where schemaname = 'public' and cmd <> 'SELECT'`,
    )
    expect([...rows]).toEqual([])
  })
})

describe('profiles trigger', () => {
  test('creates a profile for each auth user with a valid handle', async () => {
    const rows = await t.db.select().from(profiles).orderBy(profiles.handle)
    expect(rows).toHaveLength(2)
    for (const p of rows) {
      expect(p.handle).toMatch(/^[a-z0-9_]{3,30}$/)
    }
    const ada = rows.find((p) => p.id === userA)
    expect(ada?.displayName).toBe('Ada')
  })
})

describe('row level security', () => {
  let feedId: number
  let listedArticleId: number
  let privateSiteId: number
  let privateFeedId: number
  let privateArticleId: number

  beforeAll(async () => {
    const [site] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://example.com', title: 'Example', listing: 'listed' })
      .returning({ id: sites.id })
    const [feed] = await t.db
      .insert(feeds)
      .values({ siteId: site!.id, feedUrl: 'https://example.com/feed.xml' })
      .returning({ id: feeds.id })
    feedId = feed!.id
    const [listedArticle] = await t.db
      .insert(articles)
      .values({ feedId, dedupKey: 'listed-1', title: 'Listed post' })
      .returning({ id: articles.id })
    listedArticleId = listedArticle!.id
    const [privateSite] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://private.example', title: 'Private' })
      .returning({ id: sites.id })
    privateSiteId = privateSite!.id
    const [privateFeed] = await t.db
      .insert(feeds)
      .values({ siteId: privateSiteId, feedUrl: 'https://private.example/feed.xml' })
      .returning({ id: feeds.id })
    privateFeedId = privateFeed!.id
    const [privateArticle] = await t.db
      .insert(articles)
      .values({ feedId: privateFeedId, dedupKey: 'private-1', title: 'Private post' })
      .returning({ id: articles.id })
    privateArticleId = privateArticle!.id
    await t.db.insert(subscriptions).values([
      { userId: userA, feedId },
      { userId: userB, feedId },
    ])
  })

  test('a user sees only their own subscriptions', async () => {
    const mine = await asUser(t.db, 'authenticated', userA, (tx) => tx.select().from(subscriptions))
    expect(mine.map((s) => s.userId)).toEqual([userA])
  })

  test('a user cannot insert a subscription for someone else', async () => {
    const err = await pgError(
      asUser(t.db, 'authenticated', userA, (tx) =>
        tx.insert(subscriptions).values({ userId: userB, feedId }).onConflictDoNothing(),
      ),
    )
    expect(err).toMatch(/row-level security/)
  })

  test('user tables are read-only through the Data API, even for their owner', async () => {
    const insert = await pgError(
      asUser(t.db, 'authenticated', userA, (tx) =>
        tx.insert(subscriptions).values({ userId: userA, feedId: privateFeedId }),
      ),
    )
    expect(insert).toMatch(/row-level security/)
    await asUser(t.db, 'authenticated', userA, (tx) =>
      tx.delete(subscriptions).where(eq(subscriptions.userId, userA)),
    )
    const kept = await t.db.select().from(subscriptions).where(eq(subscriptions.userId, userA))
    expect(kept).toHaveLength(1)
    const recommend = await pgError(
      asUser(t.db, 'authenticated', userA, (tx) =>
        tx.insert(recommendations).values({ userId: userA, articleId: listedArticleId }),
      ),
    )
    expect(recommend).toMatch(/row-level security/)
  })

  test('anonymous users cannot see private sites, their feeds, or their articles; members can', async () => {
    const anonSites = await asUser(t.db, 'anon', null, (tx) =>
      tx.select({ id: sites.id }).from(sites),
    )
    expect(anonSites.map((s) => s.id)).not.toContain(privateSiteId)
    const anonFeeds = await asUser(t.db, 'anon', null, (tx) =>
      tx.select({ id: feeds.id }).from(feeds),
    )
    expect(anonFeeds.map((f) => f.id)).toContain(feedId)
    expect(anonFeeds.map((f) => f.id)).not.toContain(privateFeedId)
    const anonArticles = await asUser(t.db, 'anon', null, (tx) =>
      tx.select({ id: articles.id }).from(articles),
    )
    expect(anonArticles.map((a) => a.id)).toEqual([listedArticleId])
    const memberArticles = await asUser(t.db, 'authenticated', userA, (tx) =>
      tx.select({ id: articles.id }).from(articles),
    )
    expect(memberArticles.map((a) => a.id).sort()).toEqual(
      [listedArticleId, privateArticleId].sort(),
    )
  })

  test('anonymous users can read sites and feeds but not subscriptions', async () => {
    const publicSites = await asUser(t.db, 'anon', null, (tx) => tx.select().from(sites))
    expect(publicSites.length).toBeGreaterThan(0)
    const subs = await asUser(t.db, 'anon', null, (tx) => tx.select().from(subscriptions))
    expect(subs).toEqual([])
  })

  test('llm_usage is invisible to authenticated users', async () => {
    await t.db.insert(llmUsage).values({ job: 'test', model: 'mock' })
    const rows = await asUser(t.db, 'authenticated', userA, (tx) => tx.select().from(llmUsage))
    expect([...rows]).toEqual([])
  })

  test('profiles cannot be written through the Data API, so is_admin is out of reach', async () => {
    await asUser(t.db, 'authenticated', userA, (tx) =>
      tx.update(profiles).set({ bio: 'hello', isAdmin: true }).where(eq(profiles.id, userA)),
    )
    await asUser(t.db, 'authenticated', userA, (tx) =>
      tx.update(profiles).set({ bio: 'nope' }).where(eq(profiles.id, userB)),
    )
    const rows = await t.db.select().from(profiles).orderBy(profiles.handle)
    for (const p of rows) {
      expect(p.bio).toBeNull()
      expect(p.isAdmin).toBe(false)
    }
  })
})

describe('constraints', () => {
  test('recommendation notes are capped at 500 characters', async () => {
    const [site] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://notes.example' })
      .returning({ id: sites.id })
    const [feed] = await t.db
      .insert(feeds)
      .values({ siteId: site!.id, feedUrl: 'https://notes.example/feed' })
      .returning({ id: feeds.id })
    const [article] = await t.db.execute<{ id: number }>(
      sql`insert into articles (feed_id, dedup_key, title) values (${feed!.id}, 'k1', 'T') returning id`,
    )
    const err = await pgError(
      t.db
        .insert(recommendations)
        .values({ userId: userA, articleId: article!.id, note: 'x'.repeat(501) }),
    )
    expect(err).toMatch(/recommendations_note_length/)
    await t.db
      .insert(recommendations)
      .values({ userId: userA, articleId: article!.id, note: 'x'.repeat(500) })
  })

  test('handles must be lowercase slugs', async () => {
    const err = await pgError(
      t.db.update(profiles).set({ handle: 'Bad Handle' }).where(eq(profiles.id, userA)),
    )
    expect(err).toMatch(/profiles_handle_format/)
  })
})
