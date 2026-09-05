import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { detachUnvouchedFeeds, feedIsVouched, subscribe } from '../src/queries'
import { feeds, sites } from '../src/schema'
import { resetDatabase, startTestDb, type TestDb } from '../src/testing'

let t: TestDb
const userA = '11111111-1111-4111-8111-111111111111'
const userB = '22222222-2222-4222-8222-222222222222'

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)

afterAll(async () => {
  await t?.stop()
})

beforeEach(async () => {
  await resetDatabase(t.db)
  await t.db.execute(
    sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
  )
})

describe('feedIsVouched', () => {
  const site = {
    homeUrl: 'https://blog.example',
    claimedBy: userA,
    declaredFeedUrls: ['https://feeds.example/blog'],
  }
  const feed = (feedUrl: string, servedOrigin: string | null, addedBy: string | null = null) => ({
    feedUrl,
    servedOrigin,
    addedBy,
  })

  test('an unclaimed site vouches for anything', () => {
    expect(
      feedIsVouched(feed('https://elsewhere.example/feed', 'https://elsewhere.example'), {
        ...site,
        claimedBy: null,
      }),
    ).toBe(true)
  })

  test('a claimed site vouches by served origin, by declaration, or by the claimant', () => {
    expect(feedIsVouched(feed('https://blog.example/feed', 'https://blog.example'), site)).toBe(
      true,
    )
    // Never fetched: the URL's origin proves nothing (it may redirect anywhere).
    expect(feedIsVouched(feed('https://blog.example/feed', null), site)).toBe(false)
    expect(feedIsVouched(feed('https://feeds.example/blog', 'https://feeds.example'), site)).toBe(
      true,
    )
    expect(
      feedIsVouched(feed('https://other.example/x', 'https://other.example', userA), site),
    ).toBe(true)
  })

  test('a URL on the site that was served from elsewhere is not vouched', () => {
    expect(
      feedIsVouched(feed('https://blog.example/redirect', 'https://attacker.example'), site),
    ).toBe(false)
    expect(
      feedIsVouched(feed('https://other.example/x', 'https://other.example', userB), site),
    ).toBe(false)
    expect(feedIsVouched(feed('https://feeds.example/other', 'https://feeds.example'), site)).toBe(
      false,
    )
  })
})

describe('detachUnvouchedFeeds', () => {
  test('moves squatters to the origin that serves them and keeps everything vouched', async () => {
    const [site] = await t.db
      .insert(sites)
      .values({
        homeUrl: 'https://blog.example',
        claimedBy: userA,
        listing: 'listed',
        declaredFeedUrls: ['https://feeds.example/blog'],
      })
      .returning({ id: sites.id })
    const siteId = site!.id
    const rows = await t.db
      .insert(feeds)
      .values([
        { siteId, feedUrl: 'https://blog.example/feed', servedOrigin: 'https://blog.example' },
        { siteId, feedUrl: 'https://feeds.example/blog', servedOrigin: 'https://feeds.example' },
        {
          siteId,
          feedUrl: 'https://other.example/x',
          servedOrigin: 'https://other.example',
          addedBy: userA,
        },
        {
          siteId,
          feedUrl: 'https://attacker.example/feed',
          servedOrigin: 'https://attacker.example',
          addedBy: userB,
        },
      ])
      .returning({ id: feeds.id, feedUrl: feeds.feedUrl })
    const squatter = rows.find((r) => r.feedUrl.startsWith('https://attacker'))!
    await subscribe(t.db, userA, rows[0]!.id)
    await subscribe(t.db, userB, squatter.id)
    expect((await t.db.select().from(sites).where(eq(sites.id, siteId)))[0]?.readerCount).toBe(2)

    expect(await t.db.transaction((tx) => detachUnvouchedFeeds(tx, siteId))).toBe(1)

    const remaining = await t.db
      .select({ feedUrl: feeds.feedUrl })
      .from(feeds)
      .where(eq(feeds.siteId, siteId))
    expect(remaining.map((r) => r.feedUrl).sort()).toEqual([
      'https://blog.example/feed',
      'https://feeds.example/blog',
      'https://other.example/x',
    ])
    const [moved] = await t.db.select().from(feeds).where(eq(feeds.id, squatter.id))
    const [home] = await t.db
      .select()
      .from(sites)
      .where(eq(sites.id, moved?.siteId as number))
    expect(home?.homeUrl).toBe('https://attacker.example')
    expect(home?.readerCount).toBe(1)
    expect((await t.db.select().from(sites).where(eq(sites.id, siteId)))[0]?.readerCount).toBe(1)
    // Running it again changes nothing.
    expect(await t.db.transaction((tx) => detachUnvouchedFeeds(tx, siteId))).toBe(0)
  })
})
