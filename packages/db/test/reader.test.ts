import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import {
  countTotals,
  getArticle,
  listArticles,
  listSubscriptions,
  markAllRead,
  markRead,
  subscribe,
  toggleLike,
  unsubscribe,
} from '../src/queries/reader'
import { articleContents, articles, feeds, sites, userArticleStates } from '../src/schema'
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
  const [site] = await t.db
    .insert(sites)
    .values({ homeUrl: 'https://blog.example', title: 'Blog' })
    .returning()
  const [feed] = await t.db
    .insert(feeds)
    .values({ siteId: site!.id, feedUrl: 'https://blog.example/feed.xml', title: 'Blog Feed' })
    .returning()
  const [other] = await t.db
    .insert(feeds)
    .values({ siteId: site!.id, feedUrl: 'https://blog.example/other.xml', title: 'Other' })
    .returning()
  const now = Date.now()
  const rows = await t.db
    .insert(articles)
    .values([
      {
        feedId: feed!.id,
        dedupKey: 'a1',
        title: 'Old',
        publishedAt: new Date(now - 3 * 86400_000),
        fetchedAt: new Date(now - 3 * 86400_000),
      },
      {
        feedId: feed!.id,
        dedupKey: 'a2',
        title: 'Yesterday',
        publishedAt: new Date(now - 30 * 3600_000),
        fetchedAt: new Date(now - 30 * 3600_000),
      },
      {
        feedId: feed!.id,
        dedupKey: 'a3',
        title: 'Fresh',
        publishedAt: new Date(now - 3600_000),
        fetchedAt: new Date(now - 3600_000),
      },
      {
        feedId: feed!.id,
        dedupKey: 'a4',
        title: 'Ancient',
        publishedAt: new Date(now - 60 * 86400_000),
        fetchedAt: new Date(now - 60 * 86400_000),
      },
      {
        feedId: other!.id,
        dedupKey: 'o1',
        title: 'Other post',
        publishedAt: new Date(now - 7200_000),
        fetchedAt: new Date(now - 7200_000),
      },
    ])
    .returning({ id: articles.id, title: articles.title })
  await t.db
    .insert(articleContents)
    .values(
      rows.map((r) => ({ articleId: r.id, html: `<p data-tb="x">${r.title}</p>`, blocks: [] })),
    )
  return {
    feed: feed!,
    other: other!,
    site: site!,
    byTitle: Object.fromEntries(rows.map((r) => [r.title, r.id])),
  }
}

let s: Awaited<ReturnType<typeof seed>>

beforeEach(async () => {
  await resetDatabase(t.db)
  s = await seed()
})

describe('reader queries', () => {
  test('subscribing counts recent articles as unread, bounded by the horizon', async () => {
    expect(await subscribe(t.db, userA, s.feed.id)).toEqual({ created: true })
    expect(await subscribe(t.db, userA, s.feed.id)).toEqual({ created: false })
    const subs = await listSubscriptions(t.db, userA)
    expect(subs).toHaveLength(1)
    expect(subs[0]?.title).toBe('Blog Feed')
    expect(typeof subs[0]?.feedId).toBe('number')
    expect(subs[0]?.feedId).toBe(s.feed.id)
    expect(subs[0]?.lastFetchedAt).toBeNull()
    expect(subs[0]?.unread).toBe(3) // Ancient is beyond the 30-day horizon
    expect(await countTotals(t.db, userA)).toEqual({ all: 3, today: 1, liked: 0 })
    expect(await listSubscriptions(t.db, userB)).toEqual([])
  })

  test('lists only subscribed feeds, newest first, with filters', async () => {
    await subscribe(t.db, userA, s.feed.id)
    const all = await listArticles(t.db, userA)
    expect(all.map((a) => a.title)).toEqual(['Fresh', 'Yesterday', 'Old', 'Ancient'])
    expect(all[0]?.isRead).toBe(false)
    expect(all[3]?.isRead).toBe(true) // beyond the horizon reads as read
    expect(all[0]?.feedTitle).toBe('Blog Feed')
    expect((await listArticles(t.db, userA, { filter: 'today' })).map((a) => a.title)).toEqual([
      'Fresh',
    ])
    expect(await listArticles(t.db, userA, { feedId: s.other.id })).toEqual([])
    await subscribe(t.db, userA, s.other.id)
    expect((await listArticles(t.db, userA, { feedId: s.other.id })).map((a) => a.title)).toEqual([
      'Other post',
    ])
  })

  test('paginates with a keyset cursor', async () => {
    await subscribe(t.db, userA, s.feed.id)
    const first = await listArticles(t.db, userA, { limit: 2 })
    const last = first[1] as NonNullable<(typeof first)[1]>
    const next = await listArticles(t.db, userA, {
      limit: 2,
      before: { at: last.publishedAt ?? last.fetchedAt, id: last.id },
    })
    expect(first.map((a) => a.title)).toEqual(['Fresh', 'Yesterday'])
    expect(next.map((a) => a.title)).toEqual(['Old', 'Ancient'])
  })

  test('markRead is idempotent and shows in lists and detail', async () => {
    await subscribe(t.db, userA, s.feed.id)
    await markRead(t.db, userA, s.byTitle.Fresh as number)
    await markRead(t.db, userA, s.byTitle.Fresh as number)
    const fresh = (await listArticles(t.db, userA)).find((a) => a.title === 'Fresh')
    expect(fresh?.isRead).toBe(true)
    expect((await countTotals(t.db, userA)).all).toBe(2)
    const detail = await getArticle(t.db, userA, s.byTitle.Fresh as number)
    expect(detail).toMatchObject({
      contentMode: 'unknown',
      extractedFrom: 'feed',
      extractCheckedAt: null,
    })
    expect(detail?.isRead).toBe(true)
    expect(detail?.html).toContain('Fresh')
    expect(detail?.isSubscribed).toBe(true)
    // another user is unaffected
    await subscribe(t.db, userB, s.feed.id)
    expect((await countTotals(t.db, userB)).all).toBe(3)
  })

  test('markAllRead moves the watermark and compacts read rows but keeps likes', async () => {
    await subscribe(t.db, userA, s.feed.id)
    await subscribe(t.db, userA, s.other.id)
    await markRead(t.db, userA, s.byTitle.Old as number)
    await toggleLike(t.db, userA, s.byTitle.Yesterday as number)
    await markAllRead(t.db, userA, s.feed.id)

    expect((await listSubscriptions(t.db, userA)).map((x) => [x.title, x.unread])).toEqual([
      ['Blog Feed', 0],
      ['Other', 1],
    ])
    const states = await t.db.select().from(userArticleStates)
    expect(states).toHaveLength(1)
    expect(states[0]?.articleId).toBe(s.byTitle.Yesterday as number)
    expect(states[0]?.likedAt).not.toBeNull()

    await markAllRead(t.db, userA)
    expect((await countTotals(t.db, userA)).all).toBe(0)
    // A new article after the watermark is unread again.
    await t.db.insert(articles).values({ feedId: s.feed.id, dedupKey: 'a5', title: 'Newer' })
    expect((await countTotals(t.db, userA)).all).toBe(1)
  })

  test('toggleLike keeps the counter in step and marks the article read', async () => {
    await subscribe(t.db, userA, s.feed.id)
    const id = s.byTitle.Fresh as number
    expect(await toggleLike(t.db, userA, id)).toEqual({ liked: true, likeCount: 1 })
    expect(await toggleLike(t.db, userB, id)).toEqual({ liked: true, likeCount: 2 })
    expect(await toggleLike(t.db, userA, id)).toEqual({ liked: false, likeCount: 1 })
    expect((await countTotals(t.db, userA)).liked).toBe(0)
    expect((await countTotals(t.db, userB)).liked).toBe(1)
    expect((await listArticles(t.db, userA)).find((a) => a.id === id)?.isRead).toBe(true)
    expect((await listArticles(t.db, userA, { filter: 'liked' })).length).toBe(0)
  })

  test('concurrent toggles keep like_count equal to the number of likes', async () => {
    const id = s.byTitle.Fresh as number
    // Three toggles by one reader end liked; two by another end unliked. Whatever the
    // interleaving, the counter must match the rows.
    await Promise.all([
      toggleLike(t.db, userA, id),
      toggleLike(t.db, userA, id),
      toggleLike(t.db, userA, id),
    ])
    await Promise.all([toggleLike(t.db, userB, id), toggleLike(t.db, userB, id)])
    const [likes] = await t.db.execute<{ count: string }>(
      sql`select count(*)::text as count from user_article_states where article_id = ${id} and liked_at is not null`,
    )
    const [article] = await t.db
      .select({ likeCount: articles.likeCount })
      .from(articles)
      .where(eq(articles.id, id))
    expect(Number(likes?.count)).toBe(1)
    expect(article?.likeCount).toBe(1)
  })

  test('unsubscribe removes the feed from lists but keeps article access', async () => {
    await subscribe(t.db, userA, s.feed.id)
    await unsubscribe(t.db, userA, s.feed.id)
    expect(await listSubscriptions(t.db, userA)).toEqual([])
    expect(await listArticles(t.db, userA)).toEqual([])
    const detail = await getArticle(t.db, userA, s.byTitle.Fresh as number)
    expect(detail?.isSubscribed).toBe(false)
    expect(detail?.title).toBe('Fresh')
    expect(await getArticle(t.db, null, s.byTitle.Fresh as number)).not.toBeNull()
  })
})
