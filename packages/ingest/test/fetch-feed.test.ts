import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { parseFeedText } from '@tela/content'
import { articleContents, articles, feeds, sites } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { eq } from 'drizzle-orm'
import { ensureFeed } from '../src/ensure-feed'
import { fetchFeed } from '../src/fetch-feed'
import { createHttpClient } from '../src/http'
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
