import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { feeds, llmUsage, profiles, recommendations, sites, subscriptions } from '../src/schema'
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

  beforeAll(async () => {
    const [site] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://example.com', title: 'Example' })
      .returning({ id: sites.id })
    const [feed] = await t.db
      .insert(feeds)
      .values({ siteId: site!.id, feedUrl: 'https://example.com/feed.xml' })
      .returning({ id: feeds.id })
    feedId = feed!.id
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

  test('anonymous users can read sites and feeds but not subscriptions', async () => {
    const publicSites = await asUser(t.db, 'anon', null, (tx) => tx.select().from(sites))
    expect(publicSites.length).toBeGreaterThan(0)
    const subs = await asUser(t.db, 'anon', null, (tx) => tx.select().from(subscriptions))
    expect(subs).toEqual([])
  })

  test('llm_usage is invisible to authenticated users', async () => {
    await t.db.insert(llmUsage).values({ job: 'test', model: 'mock' })
    const rows = await asUser(t.db, 'authenticated', userA, (tx) => tx.select().from(llmUsage))
    expect(rows).toEqual([])
  })

  test('a user can update only their own profile', async () => {
    await asUser(t.db, 'authenticated', userA, (tx) =>
      tx.update(profiles).set({ bio: 'hello' }).where(eq(profiles.id, userA)),
    )
    await asUser(t.db, 'authenticated', userA, (tx) =>
      tx.update(profiles).set({ bio: 'nope' }).where(eq(profiles.id, userB)),
    )
    const [b] = await t.db.select().from(profiles).where(eq(profiles.id, userB))
    expect(b?.bio).toBeNull()
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
