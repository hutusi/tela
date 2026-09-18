import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { listDiscoverSites } from '../src/queries/discover'
import {
  countTotals,
  getArticle,
  getReadingRevision,
  listArticles,
  listSubscriptions,
  markAllRead,
  markExtractRequested,
  markRead,
  readingRevision,
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

  test('markExtractRequested wins one window per article and never after a final outcome', async () => {
    const id = s.byTitle.Fresh as number
    expect(await markExtractRequested(t.db, id)).toBe(true)
    expect(await markExtractRequested(t.db, id)).toBe(false)
    await t.db.execute(
      sql`update articles set extract_requested_at = now() - interval '11 minutes' where id = ${id}`,
    )
    expect(await markExtractRequested(t.db, id)).toBe(true)
    await t.db.execute(
      sql`update articles set extract_requested_at = now() - interval '11 minutes', extract_checked_at = now() where id = ${id}`,
    )
    expect(await markExtractRequested(t.db, id)).toBe(false)
    expect(await markExtractRequested(t.db, 999_999)).toBe(false)
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

describe('getArticle carries the reader pane in one row', () => {
  test('sums the body length in SQL, skipped blocks excluded', async () => {
    const id = s.byTitle.Fresh as number
    await t.db
      .update(articleContents)
      .set({
        blocks: [
          { id: 'b1', hash: 'h1', tag: 'p', chars: 400 },
          { id: 'b2', hash: 'h2', tag: 'p', chars: 250 },
          { id: 'b3', hash: 'h3', tag: 'figcaption', chars: 900, skip: true },
        ],
      })
      .where(eq(articleContents.articleId, id))
    expect((await getArticle(t.db, userA, id))?.bodyChars).toBe(650)
  })

  test('is zero when the article has no content row at all', async () => {
    const id = s.byTitle.Fresh as number
    await t.db.delete(articleContents).where(eq(articleContents.articleId, id))
    const detail = await getArticle(t.db, userA, id)
    expect(detail?.bodyChars).toBe(0)
    expect(detail?.html).toBe('')
  })

  test('brings back the translation for the asked-for language, and only that one', async () => {
    const id = s.byTitle.Fresh as number
    await t.db.execute(
      sql`insert into article_translations
            (article_id, target_lang, status, content_hash, title, html, failed_block_ids)
          values (${id}, 'zh-Hans', 'partial', 'h1', '译名', '<p>译文</p>', '{b7}')`,
    )
    expect(await getArticle(t.db, userA, id).then((a) => a?.translation)).toBeNull()
    const zh = await getArticle(t.db, userA, id, { translateTo: 'zh-Hans' })
    expect(zh?.translation).toEqual({
      status: 'partial',
      contentHash: 'h1',
      attempt: expect.any(String),
      title: '译名',
      html: '<p>译文</p>',
      failedBlocks: 1,
    })
    expect(zh?.translatedTitle).toBe('译名')
    expect((await getArticle(t.db, userA, id, { translateTo: 'en' }))?.translation).toBeNull()
  })

  test('brings back the reader own recommendation, note or not', async () => {
    const id = s.byTitle.Fresh as number
    expect((await getArticle(t.db, userA, id))?.recommendation).toBeNull()
    await t.db.execute(
      sql`insert into recommendations (user_id, article_id, note) values (${userA}, ${id}, null)`,
    )
    // A recommendation with no note is still a recommendation: presence comes from the row, not
    // from the note, which a left join reports as null either way.
    expect((await getArticle(t.db, userA, id))?.recommendation).toEqual({ note: null })
    expect((await getArticle(t.db, userB, id))?.recommendation).toBeNull()
    expect((await getArticle(t.db, null, id))?.recommendation).toBeNull()
  })
})

describe('readingRevision', () => {
  const base = { contentHash: 'abc', extractCheckedAt: null, translation: null }
  const ATTEMPT = '11111111-1111-4111-8111-111111111111'
  const OTHER_ATTEMPT = '22222222-2222-4222-8222-222222222222'

  test('changes when the body is replaced', () => {
    expect(readingRevision(base)).not.toBe(readingRevision({ ...base, contentHash: 'def' }))
  })

  test('changes when extraction concludes', () => {
    expect(readingRevision(base)).not.toBe(
      readingRevision({ ...base, extractCheckedAt: new Date() }),
    )
  })

  test('stays stable while a translation moves through non-terminal states', () => {
    const at = (status: 'pending' | 'requested' | 'running') =>
      readingRevision({ ...base, translation: { status, contentHash: 'abc', attempt: ATTEMPT } })
    const tags = [readingRevision(base), at('pending'), at('requested'), at('running')]
    expect(new Set(tags).size).toBe(1)
  })

  test('changes only when a fresh translation reaches a terminal state', () => {
    const waiting = readingRevision(base)
    for (const status of ['done', 'partial', 'failed'] as const) {
      expect(
        readingRevision({ ...base, translation: { status, contentHash: 'abc', attempt: ATTEMPT } }),
      ).not.toBe(waiting)
    }
  })

  test('changes when a retry fails the same way, so the reader gets the button back', () => {
    // failed → requested → failed lands on the same status and hash it started from. Without the
    // attempt the revision is identical, the tab polls until its budget runs out, and the retry
    // button never comes back.
    const first = readingRevision({
      ...base,
      translation: { status: 'failed', contentHash: 'abc', attempt: ATTEMPT },
    })
    const retried = readingRevision({
      ...base,
      translation: { status: 'failed', contentHash: 'abc', attempt: OTHER_ATTEMPT },
    })
    expect(retried).not.toBe(first)
  })

  test('does not churn on the attempt while a request is still waiting', () => {
    const one = readingRevision({
      ...base,
      translation: { status: 'requested', contentHash: 'abc', attempt: ATTEMPT },
    })
    const two = readingRevision({
      ...base,
      translation: { status: 'running', contentHash: 'abc', attempt: OTHER_ATTEMPT },
    })
    expect(one).toBe(two)
  })

  test('treats a terminal translation for an old body as still waiting', () => {
    const stale = readingRevision({
      ...base,
      translation: { status: 'done', contentHash: 'old', attempt: ATTEMPT },
    })
    expect(stale).toBe(readingRevision(base))
  })

  test('wakes when an irreplaceable stale running attempt finishes', () => {
    const running = readingRevision({
      ...base,
      translation: { status: 'running', contentHash: 'old', attempt: ATTEMPT },
    })
    const failed = readingRevision({
      ...base,
      translation: { status: 'failed', contentHash: 'old', attempt: ATTEMPT },
    })
    expect(running).not.toBe(readingRevision(base))
    expect(failed).toBe(readingRevision(base))
    expect(failed).not.toBe(running)
  })
})

describe('getReadingRevision', () => {
  test('is null for an article that does not exist', async () => {
    expect(await getReadingRevision(t.db, 999_999, 'en')).toBeNull()
  })

  test('is stable until something the reader is waiting on moves', async () => {
    const id = s.byTitle.Fresh as number
    const before = await getReadingRevision(t.db, id, 'zh-Hans')
    expect(before).not.toBeNull()
    expect(await getReadingRevision(t.db, id, 'zh-Hans')).toBe(before as string)

    await t.db.update(articles).set({ extractCheckedAt: new Date() }).where(eq(articles.id, id))
    expect(await getReadingRevision(t.db, id, 'zh-Hans')).not.toBe(before as string)
  })

  test('changes when a retry lands on the same terminal status', async () => {
    const id = s.byTitle.Fresh as number
    const hash = (await getArticle(t.db, userA, id))?.contentHash
    await t.db.execute(
      sql`insert into article_translations (article_id, target_lang, status, content_hash)
          values (${id}, 'zh-Hans', 'failed', ${hash})`,
    )
    const failed = await getReadingRevision(t.db, id, 'zh-Hans')
    // What a retry does: a fresh attempt on the same row, which then fails the same way.
    await t.db.execute(
      sql`update article_translations set status = 'requested', attempt = gen_random_uuid()
          where article_id = ${id} and target_lang = 'zh-Hans'`,
    )
    await t.db.execute(
      sql`update article_translations set status = 'failed'
          where article_id = ${id} and target_lang = 'zh-Hans'`,
    )
    expect(await getReadingRevision(t.db, id, 'zh-Hans')).not.toBe(failed as string)
  })

  test('follows the translation row for the asked-for language only', async () => {
    const id = s.byTitle.Fresh as number
    await t.db.update(articles).set({ contentHash: 'abc' }).where(eq(articles.id, id))
    const beforeZh = await getReadingRevision(t.db, id, 'zh-Hans')
    const beforeEn = await getReadingRevision(t.db, id, 'en')
    await t.db.execute(
      sql`insert into article_translations (article_id, target_lang, status, content_hash)
          values (${id}, 'zh-Hans', 'running', 'abc')`,
    )
    expect(await getReadingRevision(t.db, id, 'zh-Hans')).toBe(beforeZh as string)
    expect(await getReadingRevision(t.db, id, 'en')).toBe(beforeEn as string)
    await t.db.execute(
      sql`update article_translations set status = 'done' where article_id = ${id} and target_lang = 'zh-Hans'`,
    )
    expect(await getReadingRevision(t.db, id, 'zh-Hans')).not.toBe(beforeZh as string)
  })
})

describe('community listing', () => {
  const userC = '33333333-3333-4333-8333-333333333333'

  async function readers(n: number) {
    await t.db.execute(sql`insert into auth.users (id, email) values (${userC}, 'c@x.test')`)
    const users = [userA, userB, userC].slice(0, n)
    for (const u of users) await subscribe(t.db, u, s.feed.id)
  }

  async function listingOf(): Promise<string | undefined> {
    const [site] = await t.db.select().from(sites).where(eq(sites.id, s.site.id))
    return site?.listing
  }

  test('the third distinct reader lists a site nobody claimed; the second does not', async () => {
    await readers(2)
    expect(await listingOf()).toBe('private')
    await subscribe(t.db, userC, s.feed.id)
    expect(await listingOf()).toBe('listed')
    expect((await listDiscoverSites(t.db)).map((x) => x.title)).toContain('Blog')
  })

  test('distinct readers, not distinct subscriptions: one member on both feeds is one reader', async () => {
    await subscribe(t.db, userA, s.feed.id)
    await subscribe(t.db, userA, s.other.id)
    await subscribe(t.db, userB, s.feed.id)
    expect(await listingOf()).toBe('private')
  })

  test('promotion is one-way: unsubscribing below the threshold keeps the site listed', async () => {
    await readers(3)
    expect(await listingOf()).toBe('listed')
    await unsubscribe(t.db, userC, s.feed.id)
    await unsubscribe(t.db, userB, s.feed.id)
    expect(await listingOf()).toBe('listed')
  })

  test('an editorial pick and an operator rejection are both left alone', async () => {
    for (const listing of ['featured', 'rejected'] as const) {
      await resetDatabase(t.db)
      s = await seed()
      await t.db.update(sites).set({ listing }).where(eq(sites.id, s.site.id))
      await readers(3)
      expect(await listingOf()).toBe(listing)
    }
  })
})
