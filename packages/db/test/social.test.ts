import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import {
  exportSubscriptionsOpml,
  getDashboard,
  getPublicProfile,
  getRecommendation,
  isValidHandle,
  recommend,
  setTranslationOptOut,
  subscribe,
  unrecommend,
  updateProfile,
} from '../src/queries'
import { articles, feeds, profiles, sites } from '../src/schema'
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

async function seed() {
  await t.db.execute(
    sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
  )
  await updateProfile(t.db, userA, { handle: 'ada', displayName: 'Ada' })
  await updateProfile(t.db, userB, { handle: 'bob' })
  const [site] = await t.db
    .insert(sites)
    .values({ homeUrl: 'https://blog.example', title: 'Blog', claimedBy: userB, listing: 'listed' })
    .returning()
  const [feed] = await t.db
    .insert(feeds)
    .values({ siteId: site!.id, feedUrl: 'https://blog.example/feed', title: 'Blog Feed' })
    .returning()
  const [article] = await t.db
    .insert(articles)
    .values({
      feedId: feed!.id,
      dedupKey: 'a1',
      title: 'A post',
      url: 'https://blog.example/p/1',
      publishedAt: new Date(),
    })
    .returning()
  return { site: site!, feed: feed!, article: article! }
}

let s: Awaited<ReturnType<typeof seed>>

beforeEach(async () => {
  await resetDatabase(t.db)
  s = await seed()
})

describe('handles and profiles', () => {
  test('validates handles and rejects duplicates', async () => {
    expect(isValidHandle('ada_1')).toBe(true)
    expect(isValidHandle('Ada')).toBe(false)
    expect(isValidHandle('ab')).toBe(false)
    expect(isValidHandle('settings')).toBe(false)
    expect(await updateProfile(t.db, userA, { handle: 'Settings' })).toBe('invalid_handle')
    expect(await updateProfile(t.db, userA, { handle: 'bob' })).toBe('handle_taken')
    expect(await updateProfile(t.db, userA, { handle: 'ADA' })).toBe('ok')
    expect(await updateProfile(t.db, userA, { bio: '  hello  ', displayName: '' })).toBe('ok')
    const [p] = await t.db.select().from(profiles).where(eq(profiles.id, userA))
    expect(p?.handle).toBe('ada')
    expect(p?.bio).toBe('hello')
    expect(p?.displayName).toBeNull()
  })
})

describe('recommendations', () => {
  test('recommend, update the note, unrecommend; counts stay in step', async () => {
    expect(await getRecommendation(t.db, userA, s.article.id)).toBeNull()
    const first = await recommend(t.db, userA, s.article.id, '  Great read  ')
    expect(first).toEqual({ recommendCount: 1, created: true })
    expect((await getRecommendation(t.db, userA, s.article.id))?.note).toBe('Great read')
    const again = await recommend(t.db, userA, s.article.id, 'x'.repeat(600))
    expect(again.created).toBe(false)
    expect(again.recommendCount).toBe(1)
    expect((await getRecommendation(t.db, userA, s.article.id))?.note).toHaveLength(500)
    await recommend(t.db, userB, s.article.id, null)
    expect((await unrecommend(t.db, userA, s.article.id)).recommendCount).toBe(1)
    expect((await unrecommend(t.db, userA, s.article.id)).recommendCount).toBe(1)
    const [a] = await t.db.select().from(articles).where(eq(articles.id, s.article.id))
    expect(a?.recommendCount).toBe(1)
  })

  test('public profile lists recommendations and honors the subscriptions setting', async () => {
    await recommend(t.db, userA, s.article.id, 'Read this')
    await subscribe(t.db, userA, s.feed.id)
    let profile = await getPublicProfile(t.db, 'ADA')
    expect(profile?.profile.displayName).toBe('Ada')
    expect(profile?.recommendations).toHaveLength(1)
    expect(profile?.recommendations[0]?.article.title).toBe('A post')
    expect(profile?.recommendations[0]?.site.title).toBe('Blog')
    expect(profile?.subscriptions).toBeNull()
    await updateProfile(t.db, userA, { publicSubscriptions: true })
    profile = await getPublicProfile(t.db, 'ada')
    expect(profile?.subscriptions?.map((x) => x.title)).toEqual(['Blog Feed'])
    expect(await getPublicProfile(t.db, 'nobody')).toBeNull()
    const bob = await getPublicProfile(t.db, 'bob')
    expect(bob?.claimedSites.map((x) => x.title)).toEqual(['Blog'])
  })
})

describe('dashboard', () => {
  test('shows the owner their sites, posts with counts, and notes from readers', async () => {
    await subscribe(t.db, userA, s.feed.id)
    await recommend(t.db, userA, s.article.id, 'Loved the ending')
    const empty = await getDashboard(t.db, userA)
    expect(empty).toEqual({ sites: [], notes: [] })
    const dash = await getDashboard(t.db, userB)
    expect(dash.sites).toHaveLength(1)
    expect(dash.sites[0]?.readerCount).toBe(1)
    expect(dash.sites[0]?.posts[0]).toMatchObject({
      title: 'A post',
      likeCount: 0,
      recommendCount: 1,
    })
    expect(dash.notes[0]).toMatchObject({
      note: 'Loved the ending',
      recommender: { handle: 'ada' },
    })
  })

  test('only the owner can opt a site out of translation', async () => {
    expect(await setTranslationOptOut(t.db, s.site.id, userA, true)).toBe(false)
    expect(await setTranslationOptOut(t.db, s.site.id, userB, true)).toBe(true)
    const [site] = await t.db.select().from(sites).where(eq(sites.id, s.site.id))
    expect(site?.translationOptOut).toBe(true)
  })
})

describe('opml export', () => {
  test('lists subscriptions with escaped values', async () => {
    await t.db.update(feeds).set({ title: 'Tom & "Jerry" <blog>' }).where(eq(feeds.id, s.feed.id))
    await subscribe(t.db, userA, s.feed.id)
    const opml = await exportSubscriptionsOpml(t.db, userA)
    expect(opml).toContain('<opml version="2.0">')
    expect(opml).toContain('xmlUrl="https://blog.example/feed"')
    expect(opml).toContain('text="Tom &amp; &quot;Jerry&quot; &lt;blog&gt;"')
    expect(await exportSubscriptionsOpml(t.db, userB)).not.toContain('<outline')
  })
})
