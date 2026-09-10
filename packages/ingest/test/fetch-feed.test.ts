import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { parseFeedText, sha256Hex } from '@tela/content'
import { articleContents, articles, feeds, sites, subscribe } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { eq, sql } from 'drizzle-orm'
import { ensureFeed } from '../src/ensure-feed'
import { fetchFeed } from '../src/fetch-feed'
import { createHttpClient } from '../src/http'
import { MAX_INTERVAL_SEC } from '../src/schedule'
import { FixtureServer, longHtml, rss } from './fixture-server'

let t: TestDb
let server: FixtureServer
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})
const NOW = new Date('2026-09-04T10:00:00Z')
const opts = { now: () => NOW, random: () => 0.5 }

beforeAll(async () => {
  t = await startTestDb()
  server = await FixtureServer.start()
}, 120_000)

afterAll(async () => {
  await server.stop()
  await t?.stop()
})

beforeEach(async () => {
  server.reset()
  await resetDatabase(t.db)
})

function threeItems(extra: Partial<{ content: string }> = {}) {
  return rss({
    link: server.url('/'),
    ttl: 90,
    items: [1, 2, 3].map((n) => ({
      guid: `post-${n}`,
      link: server.url(`/posts/${n}`),
      title: `Post ${n}`,
      description: `Summary ${n}`,
      content: extra.content ?? longHtml(4),
      date: `Thu, 0${n} Sep 2026 08:00:00 GMT`,
    })),
  })
}

async function feedRow(id: number) {
  const [row] = await t.db.select().from(feeds).where(eq(feeds.id, id))
  if (!row) throw new Error('feed missing')
  return row
}

describe('fetchFeed', () => {
  test('stores articles, learns metadata, and schedules the next fetch', async () => {
    server.text('/feed.xml', threeItems(), { headers: { etag: '"a"' } })
    const { feedId, siteId, created } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    expect(created).toBe(true)

    const result = await fetchFeed(t.db, http, feedId, opts)
    expect(result).toMatchObject({
      status: 'fetched',
      newArticles: 3,
      updatedArticles: 0,
      items: 3,
    })
    expect(result.status === 'fetched' ? result.newArticleIds : []).toHaveLength(3)

    const rows = await t.db.select().from(articles).where(eq(articles.feedId, feedId))
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.dedupKey).sort()).toEqual(['g:post-1', 'g:post-2', 'g:post-3'])
    expect(rows[0]?.sourceLang).toBe('en')
    expect(rows[0]?.readingMinutes).toBe(1)
    const [contents] = await t.db
      .select()
      .from(articleContents)
      .where(eq(articleContents.articleId, rows[0]?.id as number))
    expect(contents?.html).toContain('data-tb="')
    expect(contents?.blocks.length).toBeGreaterThan(0)

    const feed = await feedRow(feedId)
    expect(feed.format).toBe('rss')
    expect(feed.title).toBe('Test Blog')
    expect(feed.etag).toBe('"a"')
    expect(feed.contentMode).toBe('full')
    expect(feed.errorCount).toBe(0)
    expect(feed.lastFetchedAt?.toISOString()).toBe(NOW.toISOString())
    // 3 items in the last week → base 28h, clamped to 24h; ttl floor 90 min is lower.
    expect(feed.fetchIntervalSec).toBe(24 * 3600)
    expect(feed.nextFetchAt?.getTime()).toBe(NOW.getTime() + 24 * 3600 * 1000)
    expect(feed.lastItemAt?.toISOString()).toBe('2026-09-03T08:00:00.000Z')

    const [site] = await t.db.select().from(sites).where(eq(sites.id, siteId))
    expect(site?.title).toBe('Test Blog')
    expect(site?.primaryLang).toBe('en')
  })

  test("onArticleStored runs inside each stored article's transaction, and only for changes", async () => {
    server.text('/feed.xml', threeItems())
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    const seen: Array<{ id: number; kind: string }> = []
    const result = await fetchFeed(t.db, http, feedId, {
      ...opts,
      onArticleStored: async (tx, article) => {
        // Visible on the transaction handle, not yet to anyone else.
        const inTx = await tx
          .select({ id: articles.id })
          .from(articles)
          .where(eq(articles.id, article.id))
        const outside = await t.db
          .select({ id: articles.id })
          .from(articles)
          .where(eq(articles.id, article.id))
        expect(inTx.map((r) => r.id)).toEqual([article.id])
        expect(outside).toEqual([])
        seen.push({ id: article.id, kind: article.kind })
      },
    })
    expect(result.status).toBe('fetched')
    expect(seen.map((s) => s.kind)).toEqual(['inserted', 'inserted', 'inserted'])

    // A fourth item: the three unchanged ones do not call the hook again.
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        ttl: 90,
        items: [1, 2, 3, 4].map((n) => ({
          guid: `post-${n}`,
          link: server.url(`/posts/${n}`),
          title: `Post ${n}`,
          description: `Summary ${n}`,
          content: longHtml(4),
          date: `Thu, 0${n} Sep 2026 08:00:00 GMT`,
        })),
      }),
    )
    seen.length = 0
    await fetchFeed(t.db, http, feedId, {
      ...opts,
      onArticleStored: async (_tx, article) => {
        seen.push({ id: article.id, kind: article.kind })
      },
    })
    expect(seen.map((s) => s.kind)).toEqual(['inserted'])
  })

  test('a throwing onArticleStored rolls that article back and leaves the fetch to be retried', async () => {
    server.text('/feed.xml', threeItems())
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    let calls = 0
    await expect(
      fetchFeed(t.db, http, feedId, {
        ...opts,
        onArticleStored: async () => {
          calls += 1
          if (calls === 2) throw new Error('queue down')
        },
      }),
    ).rejects.toThrow('queue down')
    // The first article committed with its hook; the second rolled back; the third never ran.
    expect(await t.db.select().from(articles).where(eq(articles.feedId, feedId))).toHaveLength(1)
    expect((await feedRow(feedId)).lastBodyHash).toBeNull()
    // The retry stores the rest, because the fetch was never recorded as done.
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({
      status: 'fetched',
      newArticles: 2,
    })
  })

  function declaringHome(home: string, path = '/feed.xml') {
    return rss({
      link: home,
      items: [
        {
          guid: `${path}-1`,
          link: `${home}posts/1`,
          title: 'Hosted elsewhere',
          description: 'Summary',
          content: longHtml(4),
          date: 'Thu, 04 Sep 2026 08:00:00 GMT',
        },
      ],
    })
  }

  test('a feed hosted elsewhere moves its site to the home it declares', async () => {
    server.text('/feed.xml', declaringHome('https://blog.example/'))
    const { feedId, siteId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    const [before] = await t.db.select().from(sites).where(eq(sites.id, siteId))
    expect(before?.homeUrl).toBe(server.origin)
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({
      status: 'fetched',
      siteHome: 'renamed',
    })
    const [after] = await t.db.select().from(sites).where(eq(sites.id, siteId))
    expect(after?.homeUrl).toBe('https://blog.example')
    // Already right: the next fetch keeps it.
    server.text('/feed.xml', declaringHome('https://blog.example/', '/feed2.xml'))
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({ siteHome: 'kept' })
    // A site created from discovery's declared home starts out right and is kept as well.
    server.text('/other.xml', declaringHome('https://other.example/'))
    const other = await ensureFeed(t.db, {
      feedUrl: server.url('/other.xml'),
      homeUrl: 'https://other.example/',
    })
    expect(await fetchFeed(t.db, http, other.feedId, opts)).toMatchObject({ siteHome: 'kept' })
  })

  test('joins an existing unclaimed site for that home, and leaves a claimed one alone', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    // An unclaimed site already exists for the declared home (with its own feed).
    const [home] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://blog.example', title: 'Blog' })
      .returning({ id: sites.id })
    await t.db.insert(feeds).values({ siteId: home!.id, feedUrl: 'https://blog.example/rss' })
    server.text('/feed.xml', declaringHome('https://blog.example/'))
    const hosted = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    expect(await fetchFeed(t.db, http, hosted.feedId, opts)).toMatchObject({ siteHome: 'joined' })
    const [moved] = await t.db.select().from(feeds).where(eq(feeds.id, hosted.feedId))
    expect(moved?.siteId).toBe(home!.id)
    expect(await t.db.select().from(sites).where(eq(sites.id, hosted.siteId))).toEqual([])

    // A site claimed by a member does not get feeds from other hosts attached to it.
    const [claimed] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://claimed.example', claimedBy: userA, listing: 'listed' })
      .returning({ id: sites.id })
    server.text('/imposter.xml', declaringHome('https://claimed.example/', '/imposter.xml'))
    const imposter = await ensureFeed(t.db, { feedUrl: server.url('/imposter.xml') })
    expect(await fetchFeed(t.db, http, imposter.feedId, opts)).toMatchObject({
      siteHome: 'blocked',
    })
    const [still] = await t.db.select().from(feeds).where(eq(feeds.id, imposter.feedId))
    expect(still?.siteId).toBe(imposter.siteId)
    expect(still?.siteId).not.toBe(claimed!.id)
  })

  test('feeds sharing a placeholder split off one at a time; the last one renames it', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    const userB = '22222222-2222-4222-8222-222222222222'
    await t.db.execute(
      sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
    )
    server.text('/a.xml', declaringHome('https://a.example/', '/a.xml'))
    server.text('/b.xml', declaringHome('https://b.example/', '/b.xml'))
    const a = await ensureFeed(t.db, { feedUrl: server.url('/a.xml') })
    const b = await ensureFeed(t.db, { feedUrl: server.url('/b.xml') })
    expect(a.siteId).toBe(b.siteId)
    await subscribe(t.db, userA, a.feedId)
    await subscribe(t.db, userB, b.feedId)
    await subscribe(t.db, userB, a.feedId)
    expect((await t.db.select().from(sites).where(eq(sites.id, a.siteId)))[0]?.readerCount).toBe(2)

    // a moves to its own site; b stays on the placeholder, which keeps the feed host's origin.
    expect(await fetchFeed(t.db, http, a.feedId, opts)).toMatchObject({ siteHome: 'split' })
    const [aRow] = await t.db.select().from(feeds).where(eq(feeds.id, a.feedId))
    const [aSite] = await t.db
      .select()
      .from(sites)
      .where(eq(sites.id, aRow?.siteId as number))
    expect(aSite?.homeUrl).toBe('https://a.example')
    const [bRow] = await t.db.select().from(feeds).where(eq(feeds.id, b.feedId))
    expect(bRow?.siteId).toBe(b.siteId)
    const [placeholder] = await t.db.select().from(sites).where(eq(sites.id, b.siteId))
    expect(placeholder?.homeUrl).toBe(server.origin)
    // Reader counts follow the feed: a's two readers on its new site, b's one on the placeholder.
    expect(aSite?.readerCount).toBe(2)
    expect(placeholder?.readerCount).toBe(1)

    // b is now alone on the placeholder, so its fetch renames it.
    expect(await fetchFeed(t.db, http, b.feedId, opts)).toMatchObject({ siteHome: 'renamed' })
    const [renamed] = await t.db.select().from(sites).where(eq(sites.id, b.siteId))
    expect(renamed?.homeUrl).toBe('https://b.example')
  })

  test('a URL on a claimed site that redirects elsewhere cannot put posts under that site', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    const attacker = await FixtureServer.start()
    try {
      attacker.text(
        '/feed.xml',
        rss({
          link: attacker.url('/'),
          items: [
            {
              guid: 'evil-1',
              link: attacker.url('/p/1'),
              title: 'Evil post',
              description: 'x',
              content: longHtml(2),
            },
          ],
        }),
      )
      server.redirect('/redirect', attacker.url('/feed.xml'), 302)
      const [victim] = await t.db
        .insert(sites)
        .values({ homeUrl: server.origin, claimedBy: userA, listing: 'listed' })
        .returning({ id: sites.id })

      // A reader subscribes to the redirecting URL: keyed by origin, it lands on the victim's site.
      const hostile = await ensureFeed(t.db, { feedUrl: server.url('/redirect') })
      expect(hostile.siteId).toBe(victim!.id)
      // The fetch sees where the feed really came from and moves it before storing a post.
      expect(await fetchFeed(t.db, http, hostile.feedId, opts)).toMatchObject({
        status: 'fetched',
        newArticles: 1,
        siteHome: 'detached',
      })
      const [moved] = await t.db.select().from(feeds).where(eq(feeds.id, hostile.feedId))
      expect(moved?.servedOrigin).toBe(attacker.origin)
      expect(moved?.siteId).not.toBe(victim!.id)
      const [home] = await t.db
        .select()
        .from(sites)
        .where(eq(sites.id, moved?.siteId as number))
      expect(home?.homeUrl).toBe(attacker.origin)
      const underVictim = await t.db
        .select({ id: articles.id })
        .from(articles)
        .innerJoin(feeds, eq(feeds.id, articles.feedId))
        .where(eq(feeds.siteId, victim!.id))
      expect(underVictim).toEqual([])

      // A feed from before provenance: no served origin, and a body hash that makes the fetch

      // short-circuit as unchanged. The served origin is still learned and enforced.

      server.redirect('/legacy', attacker.url('/feed.xml'), 302)

      const attackerBody = await (await fetch(attacker.url('/feed.xml'))).text()

      const [legacy] = await t.db

        .insert(feeds)

        .values({
          siteId: victim!.id,

          feedUrl: server.url('/legacy'),

          lastBodyHash: await sha256Hex(attackerBody),

          nextFetchAt: new Date(),
        })

        .returning({ id: feeds.id })

      expect(await fetchFeed(t.db, http, legacy!.id, opts)).toEqual({ status: 'unchanged' })

      const [legacyRow] = await t.db.select().from(feeds).where(eq(feeds.id, legacy!.id))

      expect(legacyRow?.servedOrigin).toBe(attacker.origin)

      expect(legacyRow?.siteId).not.toBe(victim!.id)

      // The owner adding a redirecting URL of their own is vouched: the feed stays on their site.
      server.redirect('/mine', attacker.url('/feed.xml'), 302)
      const mine = await ensureFeed(t.db, { feedUrl: server.url('/mine'), actorId: userA })
      const out = await fetchFeed(t.db, http, mine.feedId, opts)
      expect(out).toMatchObject({ status: 'fetched', newArticles: 1 })
      expect(out.status === 'fetched' ? out.siteHome : '').not.toBe('detached')
      const [kept] = await t.db.select().from(feeds).where(eq(feeds.id, mine.feedId))
      expect(kept?.siteId).toBe(victim!.id)
    } finally {
      await attacker.stop()
    }
  })

  test('a redirect that does not end in a feed never moves the feed', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    const elsewhere = await FixtureServer.start()
    try {
      const [victim] = await t.db
        .insert(sites)
        .values({ homeUrl: server.origin, claimedBy: userA, listing: 'listed' })
        .returning({ id: sites.id })
      server.redirect('/broken', elsewhere.url('/target'), 302)
      const hostile = await ensureFeed(t.db, { feedUrl: server.url('/broken') })

      // An outage at the destination: nothing is learned, nothing moves.
      elsewhere.text('/target', 'down', { status: 503 })
      expect(await fetchFeed(t.db, http, hostile.feedId, opts)).toMatchObject({ status: 'error' })
      let [row] = await t.db.select().from(feeds).where(eq(feeds.id, hostile.feedId))
      expect(row).toMatchObject({ siteId: victim!.id, servedOrigin: null })

      // A login page instead of a feed: same.
      elsewhere.text('/target', '<html><body>Sign in</body></html>', {
        headers: { 'content-type': 'text/html' },
      })
      expect(await fetchFeed(t.db, http, hostile.feedId, opts)).toMatchObject({
        status: 'error',
        kind: 'parse',
      })
      ;[row] = await t.db.select().from(feeds).where(eq(feeds.id, hostile.feedId))
      expect(row).toMatchObject({ siteId: victim!.id, servedOrigin: null })

      // Only a real feed at the destination proves where the feed lives.
      elsewhere.text('/target', declaringHome(`${elsewhere.origin}/`))
      expect(await fetchFeed(t.db, http, hostile.feedId, opts)).toMatchObject({
        status: 'fetched',
        siteHome: 'detached',
      })
      ;[row] = await t.db.select().from(feeds).where(eq(feeds.id, hostile.feedId))
      expect(row?.servedOrigin).toBe(elsewhere.origin)
      expect(row?.siteId).not.toBe(victim!.id)
    } finally {
      await elsewhere.stop()
    }
  })

  test('a claimed placeholder is never renamed or split', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    server.text('/feed.xml', declaringHome('https://elsewhere.example/'))
    const mine = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    await t.db.update(sites).set({ claimedBy: userA }).where(eq(sites.id, mine.siteId))
    expect(await fetchFeed(t.db, http, mine.feedId, opts)).toMatchObject({ siteHome: 'blocked' })
    const [site] = await t.db.select().from(sites).where(eq(sites.id, mine.siteId))
    expect(site?.homeUrl).toBe(server.origin)
    const [row] = await t.db.select().from(feeds).where(eq(feeds.id, mine.feedId))
    expect(row?.siteId).toBe(mine.siteId)
  })

  test('keeps only the newest items of an oversized feed', async () => {
    const items = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        guid: `p${i}`,
        link: server.url(`/p/${i}`),
        title: `Post ${i}`,
        description: `Summary ${i}`,
        content: longHtml(1),
        date: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toUTCString(),
      }))
    server.text('/feed.xml', rss({ link: server.url('/'), items: items(250) }))
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({
      status: 'fetched',
      newArticles: 200,
      items: 250,
      itemsSkipped: 50,
    })
    const titles = (await t.db.select().from(articles).where(eq(articles.feedId, feedId))).map(
      (a) => a.title,
    )
    expect(titles).toHaveLength(200)
    expect(titles).toContain('Post 249')
    expect(titles).toContain('Post 50')
    expect(titles).not.toContain('Post 49')

    // One newer item appears: only it is stored; the old tail stays out.
    server.text('/feed.xml', rss({ link: server.url('/'), items: items(251) }))
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({
      status: 'fetched',
      newArticles: 1,
      itemsSkipped: 51,
    })
  })

  test('is idempotent: unchanged bodies and 304s add nothing and back off', async () => {
    server.cached('/feed.xml', threeItems(), '"v1"')
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    await fetchFeed(t.db, http, feedId, opts)
    const before = await feedRow(feedId)

    // Second fetch: server answers 304 because the etag matches.
    expect(await fetchFeed(t.db, http, feedId, opts)).toEqual({ status: 'unchanged' })
    expect(server.requestsFor('/feed.xml').at(-1)?.headers['if-none-match']).toBe('"v1"')

    // Third fetch with the etag cleared: same body → hash short-circuit.
    await t.db.update(feeds).set({ etag: null }).where(eq(feeds.id, feedId))
    expect(await fetchFeed(t.db, http, feedId, opts)).toEqual({ status: 'unchanged' })

    const rows = await t.db.select().from(articles).where(eq(articles.feedId, feedId))
    expect(rows).toHaveLength(3)
    const after = await feedRow(feedId)
    expect(after.fetchIntervalSec).toBeGreaterThanOrEqual(before.fetchIntervalSec)
  })

  test('keeps jitter out of the stored interval, so it cannot ratchet past the cap', async () => {
    // random() === 1 is the top of the ±10% spread. Jitter used to be written to
    // fetch_interval_sec and read back as the next currentSec, so it compounded on every
    // backoff step and pushed the column past MAX_INTERVAL_SEC instead of settling on it.
    const jittery = { now: () => NOW, random: () => 1 }
    server.cached('/feed.xml', threeItems(), '"v1"')
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    await fetchFeed(t.db, http, feedId, jittery)

    for (let i = 0; i < 5; i++) {
      expect(await fetchFeed(t.db, http, feedId, jittery)).toEqual({ status: 'unchanged' })
      expect((await feedRow(feedId)).fetchIntervalSec).toBeLessThanOrEqual(MAX_INTERVAL_SEC)
    }

    const feed = await feedRow(feedId)
    expect(feed.fetchIntervalSec).toBe(MAX_INTERVAL_SEC)
    // The wake-up still carries the jitter the column no longer keeps.
    expect(feed.nextFetchAt?.getTime()).toBe(NOW.getTime() + MAX_INTERVAL_SEC * 1.1 * 1000)
  })

  test('updates changed articles and bumps the content version', async () => {
    server.text('/feed.xml', threeItems())
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    await fetchFeed(t.db, http, feedId, opts)

    server.text('/feed.xml', threeItems({ content: `${longHtml(4)}<p>An edit was made here.</p>` }))
    const result = await fetchFeed(t.db, http, feedId, opts)
    expect(result).toMatchObject({ status: 'fetched', newArticles: 0, updatedArticles: 3 })
    const rows = await t.db.select().from(articles).where(eq(articles.feedId, feedId))
    expect(rows.every((r) => r.contentVersion === 2)).toBe(true)
  })

  test('adopts permanent redirects', async () => {
    server.redirect('/old.xml', '/new.xml', 301)
    server.text('/new.xml', threeItems())
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/old.xml') })
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({ status: 'fetched' })
    expect((await feedRow(feedId)).feedUrl).toBe(server.url('/new.xml'))
  })

  test('honors Retry-After on 429', async () => {
    server.text('/feed.xml', 'slow down', { status: 429, headers: { 'retry-after': '120' } })
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({
      status: 'error',
      kind: 'http_429',
    })
    const feed = await feedRow(feedId)
    expect(feed.errorCount).toBe(1)
    expect(feed.nextFetchAt?.getTime()).toBe(NOW.getTime() + 120_000)
  })

  test('counts timeouts toward the streak and resets on success', async () => {
    server.delay('/feed.xml', 900)
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({
      status: 'error',
      kind: 'timeout',
    })
    let feed = await feedRow(feedId)
    expect(feed.timeoutStreak).toBe(1)
    expect(feed.errorCount).toBe(1)
    expect(feed.nextFetchAt?.getTime()).toBe(NOW.getTime() + 2 * 3600 * 1000)

    server.text('/feed.xml', threeItems())
    await t.db.update(feeds).set({ nextFetchAt: NOW }).where(eq(feeds.id, feedId))
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({ status: 'fetched' })
    feed = await feedRow(feedId)
    expect(feed.timeoutStreak).toBe(0)
    expect(feed.errorCount).toBe(0)
  })

  test('marks 410 feeds dead and skips them afterwards', async () => {
    server.text('/feed.xml', 'gone', { status: 410 })
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({ status: 'dead' })
    expect((await feedRow(feedId)).status).toBe('dead')
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({ status: 'skipped' })
  })

  test('records parse errors', async () => {
    server.text('/feed.xml', '<html><body>not a feed</body></html>', {
      headers: { 'content-type': 'text/html' },
    })
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    expect(await fetchFeed(t.db, http, feedId, opts)).toMatchObject({
      status: 'error',
      kind: 'parse',
    })
    expect((await feedRow(feedId)).lastError).toMatch(/^parse:/)
  })

  test('learns summary-only feeds', async () => {
    const body = rss({
      link: server.url('/'),
      items: [1, 2, 3].map((n) => ({
        guid: `s-${n}`,
        link: server.url(`/p/${n}`),
        title: `Short ${n}`,
        description: `<p>Just a teaser for post ${n}. Read more…</p>`,
      })),
    })
    server.text('/feed.xml', body)
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    await fetchFeed(t.db, http, feedId, opts)
    expect((await feedRow(feedId)).contentMode).toBe('summary')
  })

  test('uses the link when a feed has no guids, and title hashes when it has no links', async () => {
    const body = rss({
      link: server.url('/'),
      items: [
        {
          link: `${server.url('/p/1')}?utm_source=rss`,
          title: 'One',
          description: '<p>Body one.</p>',
        },
        { title: 'Two', description: '<p>Body two.</p>', date: 'Thu, 03 Sep 2026 08:00:00 GMT' },
      ],
    })
    server.text('/feed.xml', body)
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    await fetchFeed(t.db, http, feedId, opts)
    const keys = (await t.db.select({ k: articles.dedupKey }).from(articles)).map((r) => r.k).sort()
    expect(keys[0]).toMatch(/^h:/)
    expect(keys[1]).toBe(`u:${server.url('/p/1').replace('http://', 'https://')}`)
  })
})

describe('site language', () => {
  test('follows the detected article language and normalizes declared tags', async () => {
    // Declares en-US; the articles are English either way.
    server.text(
      '/a.xml',
      threeItems().replace('<language>en</language>', '<language>en-US</language>'),
    )
    const a = await ensureFeed(t.db, { feedUrl: server.url('/a.xml') })
    await fetchFeed(t.db, http, a.feedId, opts)
    let [site] = await t.db.select().from(sites).where(eq(sites.id, a.siteId))
    expect(site?.primaryLang).toBe('en')

    // Declares zh, but the posts are English: what readers see wins. Its own home link gives
    // it its own site, so the first feed's articles do not count here.
    const bXml = threeItems()
      .replace(server.url('/'), 'https://b.example/')
      .replace('<language>en</language>', '<language>zh</language>')
    server.text('/b.xml', bXml)
    const b = await ensureFeed(t.db, {
      feedUrl: server.url('/b.xml'),
      parsed: await parseFeedText(bXml, server.url('/b.xml')),
    })
    await fetchFeed(t.db, http, b.feedId, opts)
    ;[site] = await t.db.select().from(sites).where(eq(sites.id, b.siteId))
    expect(site?.primaryLang).toBe('en')

    // No articles yet: the declared tag, normalized.
    const cXml = rss({ link: 'https://c.example/', items: [] }).replace(
      '<language>en</language>',
      '<language>zh-CN</language>',
    )
    server.text('/c.xml', cXml)
    const c = await ensureFeed(t.db, {
      feedUrl: server.url('/c.xml'),
      parsed: await parseFeedText(cXml, server.url('/c.xml')),
    })
    await fetchFeed(t.db, http, c.feedId, opts)
    ;[site] = await t.db.select().from(sites).where(eq(sites.id, c.siteId))
    expect(site?.primaryLang).toBe('zh-Hans')
  })
})
