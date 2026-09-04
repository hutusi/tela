import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { likePattern, listDiscoverSites, searchArticles, subscribe } from '../src/queries'
import { articles, articleTranslations, feeds, sites } from '../src/schema'
import { resetDatabase, startTestDb, type TestDb } from '../src/testing'

let t: TestDb
const userA = '11111111-1111-4111-8111-111111111111'

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)
afterAll(async () => {
  await t?.stop()
})

async function site(values: Partial<typeof sites.$inferInsert> & { homeUrl: string }) {
  const [row] = await t.db.insert(sites).values(values).returning()
  const [feed] = await t.db
    .insert(feeds)
    .values({ siteId: row!.id, feedUrl: `${values.homeUrl}/feed`, title: `${values.title} feed` })
    .returning()
  return { site: row!, feed: feed! }
}

async function article(
  feedId: number,
  title: string,
  translated?: { lang: string; title: string },
) {
  const [row] = await t.db
    .insert(articles)
    .values({ feedId, dedupKey: title, title, url: `https://x.test/${encodeURIComponent(title)}` })
    .returning()
  if (translated) {
    await t.db.insert(articleTranslations).values({
      articleId: row!.id,
      targetLang: translated.lang,
      title: translated.title,
      status: 'done',
    })
  }
  return row!
}

let seeded: {
  julia: Awaited<ReturnType<typeof site>>
  hutusi: Awaited<ReturnType<typeof site>>
  other: Awaited<ReturnType<typeof site>>
}

beforeEach(async () => {
  await resetDatabase(t.db)
  await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
  seeded = {
    julia: await site({
      homeUrl: 'https://jvns.ca',
      title: 'Julia Evans',
      description: 'Programming zines and 100% honest debugging stories',
      listing: 'listed',
    }),
    hutusi: await site({ homeUrl: 'https://hutusi.com', title: '胡涂说', listing: 'private' }),
    other: await site({
      homeUrl: 'https://other.example',
      title: 'Private Other',
      listing: 'private',
    }),
  }
  await subscribe(t.db, userA, seeded.hutusi.feed.id)
})

describe('likePattern', () => {
  test('escapes LIKE metacharacters', () => {
    expect(likePattern('100%_\\x')).toBe('%100\\%\\_\\\\x%')
  })
})

describe('listDiscoverSites with a query', () => {
  test('matches name, host, and description; private sites only when subscribed', async () => {
    const byName = await listDiscoverSites(t.db, { query: 'julia' })
    expect(byName.map((s) => s.title)).toEqual(['Julia Evans'])
    const byHost = await listDiscoverSites(t.db, { query: 'jvns.ca' })
    expect(byHost.map((s) => s.title)).toEqual(['Julia Evans'])
    const byDescription = await listDiscoverSites(t.db, { query: 'zines' })
    expect(byDescription.map((s) => s.title)).toEqual(['Julia Evans'])
    // A site with several feeds (blog + podcast) is found by any of their titles.
    const byFeedTitle = await listDiscoverSites(t.db, { query: 'evans feed' })
    expect(byFeedTitle.map((s) => s.title)).toEqual(['Julia Evans'])

    expect(await listDiscoverSites(t.db, { query: '胡涂' })).toEqual([])
    const subscribed = await listDiscoverSites(t.db, {
      query: '胡涂',
      userId: userA,
      includeSubscribed: true,
    })
    expect(subscribed.map((s) => s.title)).toEqual(['胡涂说'])
    expect(subscribed[0]?.isSubscribed).toBe(true)
    expect(
      await listDiscoverSites(t.db, { query: 'Private', userId: userA, includeSubscribed: true }),
    ).toEqual([])
  })

  test('treats LIKE metacharacters literally and ignores blank queries', async () => {
    expect((await listDiscoverSites(t.db, { query: '100%' })).map((s) => s.title)).toEqual([
      'Julia Evans',
    ])
    expect((await listDiscoverSites(t.db, { query: '%' })).map((s) => s.title)).toEqual([
      'Julia Evans',
    ])
    expect((await listDiscoverSites(t.db, { query: '   ' })).map((s) => s.title)).toEqual([
      'Julia Evans',
    ])
  })
})

describe('searchArticles', () => {
  test('searches the subscriber’s posts by original or translated title', async () => {
    const k8s = await article(seeded.hutusi.feed.id, 'Kubernetes 入门', {
      lang: 'en',
      title: 'Getting started with Kubernetes',
    })
    await article(seeded.hutusi.feed.id, '写作的意义')
    await article(seeded.other.feed.id, 'Kubernetes secrets')

    const original = await searchArticles(t.db, {
      userId: userA,
      query: 'kubernetes',
      readingLang: 'en',
    })
    expect(original.map((h) => h.id)).toEqual([k8s.id])
    expect(original[0]).toMatchObject({
      feedId: seeded.hutusi.feed.id,
      translatedTitle: 'Getting started with Kubernetes',
      siteTitle: '胡涂说',
    })

    const translated = await searchArticles(t.db, {
      userId: userA,
      query: 'getting started',
      readingLang: 'en',
    })
    expect(translated.map((h) => h.id)).toEqual([k8s.id])
    expect(
      await searchArticles(t.db, {
        userId: userA,
        query: 'getting started',
        readingLang: 'zh-Hans',
      }),
    ).toEqual([])

    const cjk = await searchArticles(t.db, { userId: userA, query: '写作', readingLang: 'en' })
    expect(cjk.map((h) => h.title)).toEqual(['写作的意义'])
    expect(await searchArticles(t.db, { userId: userA, query: '', readingLang: 'en' })).toEqual([])
  })
})
