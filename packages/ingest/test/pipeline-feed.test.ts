import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { objectKeys } from '@tela/content'
import { claimDue, first, type Lease, subscribe, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { createHttpClient } from '../src/http'
import { type IngestContext, ingestFeed, registerFeed } from '../src/pipeline'
import { MAX_INTERVAL_SEC } from '../src/schedule'
import { FixtureServer, longHtml, rss } from './fixture-server'

const NOW = Date.UTC(2026, 8, 4, 10)
const MIN = 60_000
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})

let server: FixtureServer
let db: TelaDb
let blobs: ReturnType<typeof memoryBlobs>
let clock: ReturnType<typeof fakeClock>

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(async () => {
  server.reset()
  db = (await createTestDb()).db
  blobs = memoryBlobs()
  clock = fakeClock(NOW)
})

const ctx = (extra: Partial<IngestContext> = {}): IngestContext => ({
  db,
  blobs,
  http,
  clock,
  random: () => 0.5,
  ...extra,
})

function threeItems(extra: Partial<{ content: string; link: string }> = {}) {
  return rss({
    link: extra.link ?? server.url('/'),
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

async function addFeed(path: string, extra: { homeUrl?: string; actorId?: string } = {}) {
  return registerFeed(db, { feedUrl: server.url(path), ...extra, now: clock.now() })
}

async function claim(feedId: number, owner = 'w1'): Promise<Lease> {
  const got = await claimDue(db, {
    kind: 'feed.fetch',
    owner,
    now: clock.now(),
    ttlMs: 2 * MIN,
    limit: 1,
    due: sql`select ${feedId} as key, null as host, 0 as ord`,
  })
  if (got.length !== 1) throw new Error(`could not claim feed ${feedId}`)
  return { kind: 'feed.fetch', key: String(feedId), owner }
}

async function fetchOnce(feedId: number, extra: Partial<IngestContext> = {}) {
  return ingestFeed(ctx(extra), await claim(feedId))
}

async function addUser(id: string) {
  await addTestUser(db, id)
}

const row = <T>(q: ReturnType<typeof sql>) => first<T>(db, q)
const rows = <T>(q: ReturnType<typeof sql>) => db.all<T>(q)

describe('ingestFeed', () => {
  test('stores articles as version 1 with content objects, learns metadata, and schedules', async () => {
    server.text('/feed.xml', threeItems(), { headers: { etag: '"a"' } })
    const { feedId, siteId, created } = await addFeed('/feed.xml')
    expect(created).toBe(true)

    const result = await fetchOnce(feedId)
    expect(result).toMatchObject({ status: 'fetched', items: 3, updatedArticleIds: [] })
    expect(result.status === 'fetched' ? result.newArticleIds : []).toHaveLength(3)

    const articles = await rows<{
      id: number
      dedup_key: string
      source_lang: string
      reading_minutes: number
      content_key: string
      current_version: number
      extract_state: string
      title_hash: string
      url_host: string
    }>(sql`select * from articles where feed_id = ${feedId} order by dedup_key`)
    expect(articles.map((a) => a.dedup_key)).toEqual(['g:post-1', 'g:post-2', 'g:post-3'])
    const first = articles[0]!
    expect(first.source_lang).toBe('en')
    expect(first.reading_minutes).toBe(1)
    expect(first.current_version).toBe(1)
    expect(first.extract_state).toBe('none')
    expect(first.title_hash).toHaveLength(16)
    expect(first.url_host).toBe('127.0.0.1')

    const object = JSON.parse(
      await (await blobs.get(objectKeys.content(first.content_key)))!.text(),
    )
    expect(object.format).toBe(1)
    expect(object.blocks.length).toBeGreaterThan(0)
    const version = await row<{ provenance: string; raw_key: string; body_chars: number }>(
      sql`select * from article_versions where article_id = ${first.id}`,
    )
    expect(version?.provenance).toBe('feed')
    expect(await blobs.get(version!.raw_key)).not.toBeNull()

    const feed = await row<Record<string, unknown>>(sql`select * from feeds where id = ${feedId}`)
    expect(feed).toMatchObject({
      format: 'rss',
      title: 'Test Blog',
      etag: '"a"',
      content_mode: 'full',
      error_count: 0,
      last_fetched_at: NOW,
      // 3 items in the last week → base 28h, clamped to 24h; the 90-minute ttl floor is lower.
      fetch_interval_sec: 24 * 3600,
      next_fetch_at: NOW + 24 * 3600 * 1000,
      last_item_at: Date.UTC(2026, 8, 3, 8),
    })
    const site = await row<{ title: string; primary_lang: string }>(
      sql`select * from sites where id = ${siteId}`,
    )
    expect(site).toMatchObject({ title: 'Test Blog', primary_lang: 'en' })
  })

  test('stamps every row it writes with one sync sequence value', async () => {
    server.text('/feed.xml', threeItems())
    const { feedId } = await addFeed('/feed.xml')
    const before = await row<{ v: number }>(sql`select v from counters where k = 'seq'`)
    await fetchOnce(feedId)
    const seqs = await rows<{ seq: number }>(
      sql`select distinct seq from articles union select seq from feeds where id = ${feedId}`,
    )
    expect(seqs).toEqual([{ seq: (before?.v ?? 0) + 1 }])
  })

  test('is idempotent: an unchanged body or a 304 adds nothing and backs off', async () => {
    server.text('/feed.xml', threeItems(), { headers: { etag: '"a"' } })
    const { feedId } = await addFeed('/feed.xml')
    await fetchOnce(feedId)
    const versionsBefore = await row<{ n: number }>(sql`select count(*) as n from article_versions`)
    const objectsBefore = blobs.size

    clock.advance(MIN)
    expect(await fetchOnce(feedId)).toEqual({ status: 'unchanged' })
    server.text('/feed.xml', '', { status: 304 })
    clock.advance(MIN)
    expect(await fetchOnce(feedId)).toEqual({ status: 'unchanged' })

    expect(await row<{ n: number }>(sql`select count(*) as n from article_versions`)).toEqual(
      versionsBefore!,
    )
    expect(blobs.size).toBe(objectsBefore)
    const feed = await row<{ fetch_interval_sec: number }>(
      sql`select fetch_interval_sec from feeds where id = ${feedId}`,
    )
    expect(feed?.fetch_interval_sec).toBeLessThanOrEqual(MAX_INTERVAL_SEC)
  })

  test('a changed item adds version 2 and makes it current; version 1 stays', async () => {
    server.text('/feed.xml', threeItems())
    const { feedId } = await addFeed('/feed.xml')
    await fetchOnce(feedId)
    server.text('/feed.xml', threeItems({ content: longHtml(6) }))
    clock.advance(MIN)
    const result = await fetchOnce(feedId)
    expect(result.status === 'fetched' ? result.updatedArticleIds : []).toHaveLength(3)
    const versions = await rows<{ version: number }>(
      sql`select version from article_versions where article_id = 1 order by version`,
    )
    expect(versions.map((v) => v.version)).toEqual([1, 2])
    const article = await row<{ current_version: number; content_key: string }>(
      sql`select current_version, content_key from articles where id = 1`,
    )
    const v2 = await row<{ content_key: string }>(
      sql`select content_key from article_versions where article_id = 1 and version = 2`,
    )
    expect(article?.current_version).toBe(2)
    expect(article?.content_key).toBe(v2!.content_key)
  })

  test('a changed summary never replaces its extraction (the regression ADR 0022 fixes)', async () => {
    const summaries = (text: string) =>
      rss({
        link: server.url('/'),
        items: [1, 2, 3].map((n) => ({
          guid: `s-${n}`,
          link: server.url(`/posts/${n}`),
          title: `Post ${n}`,
          description: `${text} ${n}`,
          date: `Thu, 0${n} Sep 2026 08:00:00 GMT`,
        })),
      })
    server.text('/feed.xml', summaries('A short summary'))
    const { feedId } = await addFeed('/feed.xml')
    await fetchOnce(feedId)
    const learned = await row<{ content_mode: string }>(
      sql`select content_mode from feeds where id = ${feedId}`,
    )
    expect(learned?.content_mode).toBe('summary')
    // Summary feeds are extracted eagerly: every new article is due at once.
    const due = await rows<{ extract_state: string }>(sql`select extract_state from articles`)
    expect(due.every((a) => a.extract_state === 'due')).toBe(true)

    // Pretend extraction ran on article 1: a longer readability version, now current.
    await db.run(sql`
      insert into article_versions (article_id, version, provenance, content_key, norm_version,
        body_chars, excerpt, word_count, reading_minutes, created_at)
      values (1, 2, 'readability', 'extracted-key', 1, 9000, 'Full text', 1500, 7, ${NOW})
    `)
    await db.run(
      sql`update articles set current_version = 2, content_key = 'extracted-key', extract_state = 'done' where id = 1`,
    )

    // The feed edits its summary.
    server.text('/feed.xml', summaries('An edited summary'))
    clock.advance(MIN)
    await fetchOnce(feedId)
    const article = await row<{
      current_version: number
      content_key: string
      extract_state: string
      excerpt: string
    }>(sql`select current_version, content_key, extract_state, excerpt from articles where id = 1`)
    expect(article).toMatchObject({
      current_version: 2,
      content_key: 'extracted-key',
      excerpt: 'Full text',
    })
    // The new summary is kept as version 3 and asks for a fresh extraction.
    expect(article?.extract_state).toBe('due')
    const v3 = await row<{ provenance: string }>(
      sql`select provenance from article_versions where article_id = 1 and version = 3`,
    )
    expect(v3?.provenance).toBe('feed')
  })

  test('keeps only the newest 200 items of an oversized feed, within D1 limits', async () => {
    const items = Array.from({ length: 230 }, (_, i) => ({
      guid: `bulk-${i}`,
      link: server.url(`/bulk/${i}`),
      title: `Bulk ${i}`,
      description: `Item ${i}`,
      content: longHtml(2),
      date: new Date(NOW - i * 3600_000).toUTCString(),
    }))
    server.text('/feed.xml', rss({ link: server.url('/'), items }))
    const { feedId } = await addFeed('/feed.xml')
    const result = await fetchOnce(feedId)
    expect(result).toMatchObject({ status: 'fetched', items: 230, itemsSkipped: 30 })
    expect(await row<{ n: number }>(sql`select count(*) as n from articles`)).toEqual({ n: 200 })
    // The newest are kept: bulk-0 .. bulk-199.
    expect(
      await row(sql`select 1 as x from articles where dedup_key = 'g:bulk-229'`),
    ).toBeUndefined()
  })

  test('adopts a permanent redirect as the feed URL', async () => {
    server.text('/new.xml', threeItems())
    server.redirect('/old.xml', '/new.xml', 301)
    const { feedId } = await addFeed('/old.xml')
    await fetchOnce(feedId)
    const feed = await row<{ feed_url: string }>(
      sql`select feed_url from feeds where id = ${feedId}`,
    )
    expect(feed?.feed_url).toBe(server.url('/new.xml'))
  })

  test('a permanent redirect onto a feed that exists and nobody follows here stores nothing', async () => {
    server.text('/new.xml', threeItems())
    server.redirect('/old.xml', '/new.xml', 301)
    const target = await addFeed('/new.xml')
    const alias = await addFeed('/old.xml')
    expect(await fetchOnce(alias.feedId)).toEqual({
      status: 'skipped',
      reason: 'duplicate',
      duplicateOf: target.feedId,
    })
    expect(await row<{ n: number }>(sql`select count(*) as n from articles`)).toEqual({ n: 0 })
  })

  test('an alias someone reads keeps working, and keeps its own URL', async () => {
    await addUser('u1')
    server.text('/new.xml', threeItems())
    server.redirect('/old.xml', '/new.xml', 301)
    await addFeed('/new.xml')
    const alias = await addFeed('/old.xml')
    await subscribe(db, 'u1', alias.feedId, clock.now())
    expect(await fetchOnce(alias.feedId)).toMatchObject({ status: 'fetched' })
    const feed = await row<{ feed_url: string }>(
      sql`select feed_url from feeds where id = ${alias.feedId}`,
    )
    expect(feed?.feed_url).toBe(server.url('/old.xml'))
  })

  test('honours Retry-After on 429, counts timeouts, and marks a 410 feed dead', async () => {
    server.text('/feed.xml', 'slow down', { status: 429, headers: { 'retry-after': '3600' } })
    const { feedId } = await addFeed('/feed.xml')
    expect(await fetchOnce(feedId)).toMatchObject({ status: 'error', kind: 'http_429' })
    const limited = await row<{ next_fetch_at: number; error_count: number }>(
      sql`select next_fetch_at, error_count from feeds where id = ${feedId}`,
    )
    expect(limited).toEqual({ next_fetch_at: NOW + 3600_000, error_count: 1 })

    server.set('/feed.xml', async () => {
      await new Promise((r) => setTimeout(r, 1000))
    })
    clock.advance(2 * 3600_000)
    expect(await fetchOnce(feedId)).toMatchObject({ status: 'error', kind: 'timeout' })
    const timedOut = await row<{ timeout_streak: number }>(
      sql`select timeout_streak from feeds where id = ${feedId}`,
    )
    expect(timedOut?.timeout_streak).toBe(1)

    server.text('/feed.xml', 'gone', { status: 410 })
    clock.advance(24 * 3600_000)
    expect(await fetchOnce(feedId)).toMatchObject({ status: 'dead' })
    clock.advance(MIN)
    expect(await fetchOnce(feedId)).toEqual({ status: 'skipped', reason: 'feed is dead' })
  })

  test('records parse errors without storing anything', async () => {
    server.text('/feed.xml', '<html>not a feed</html>')
    const { feedId } = await addFeed('/feed.xml')
    expect(await fetchOnce(feedId)).toMatchObject({ status: 'error', kind: 'parse' })
    expect(await row<{ n: number }>(sql`select count(*) as n from articles`)).toEqual({ n: 0 })
  })

  test('dedups on the link without guids, and on title+date without links', async () => {
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [
          {
            link: server.url('/a?utm_source=x'),
            title: 'A',
            description: 'a',
            content: longHtml(1),
          },
          {
            title: 'No link',
            description: 'b',
            content: longHtml(1),
            date: 'Thu, 04 Sep 2026 08:00:00 GMT',
          },
        ],
      }),
    )
    const { feedId } = await addFeed('/feed.xml')
    await fetchOnce(feedId)
    const keys = await rows<{ dedup_key: string }>(sql`select dedup_key from articles order by id`)
    // Link normalization upgrades to https and drops tracking parameters (ADR 0009).
    expect(keys[0]?.dedup_key).toBe(`u:${server.url('/a').replace('http:', 'https:')}`)
    expect(keys[1]?.dedup_key).toStartWith('h:')
  })
})

describe('leases', () => {
  test('a stale holder whose lease was taken over writes nothing at all', async () => {
    server.text('/feed.xml', threeItems())
    const { feedId } = await addFeed('/feed.xml')
    const stale = await claim(feedId, 'stalled')
    // The stalled worker's lease runs out; another worker takes the feed over.
    clock.advance(3 * MIN)
    await claim(feedId, 'fresh')
    expect(await ingestFeed(ctx(), stale)).toEqual({ status: 'lost' })
    expect(await row<{ n: number }>(sql`select count(*) as n from articles`)).toEqual({ n: 0 })
    const lease = await row<{ owner: string }>(sql`select owner from leases`)
    expect(lease?.owner).toBe('fresh')
  })

  test('only one of two workers can claim a feed, so its articles are stored once', async () => {
    server.text('/feed.xml', threeItems())
    const { feedId } = await addFeed('/feed.xml')
    const first = await claim(feedId, 'a')
    await expect(claim(feedId, 'b')).rejects.toThrow(/could not claim/)
    await ingestFeed(ctx(), first)
    expect(await row<{ n: number }>(sql`select count(*) as n from articles`)).toEqual({ n: 3 })
  })

  test('a WebSub ping that lands during a fetch is not lost', async () => {
    const body = threeItems()
    const { feedId } = await addFeed('/feed.xml')
    // The hub pings while this fetch's request is in flight.
    server.set('/feed.xml', async (_req, res) => {
      clock.advance(1000)
      await db.run(sql`update feeds set refetch_requested_at = ${clock.now()} where id = ${feedId}`)
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
      res.end(body)
    })
    await ingestFeed(ctx(), await claim(feedId))
    const feed = await row<{ refetch_requested_at: number | null }>(
      sql`select refetch_requested_at from feeds where id = ${feedId}`,
    )
    expect(feed?.refetch_requested_at).toBe(NOW + 1000)
    // A ping from before the next fetch starts is answered by it.
    server.text('/feed.xml', body)
    clock.advance(MIN)
    await fetchOnce(feedId)
    const answered = await row<{ refetch_requested_at: number | null }>(
      sql`select refetch_requested_at from feeds where id = ${feedId}`,
    )
    expect(answered?.refetch_requested_at).toBeNull()
  })
})

describe('sites', () => {
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
  const siteOf = async (feedId: number) =>
    row<{ id: number; home_url: string; reader_count: number }>(
      sql`select s.id, s.home_url, s.reader_count from sites s join feeds f on f.site_id = s.id where f.id = ${feedId}`,
    )

  test('a feed hosted elsewhere renames its placeholder to the home it declares', async () => {
    server.text('/feed.xml', declaringHome('https://blog.example/'))
    const { feedId } = await addFeed('/feed.xml')
    expect((await siteOf(feedId))?.home_url).toBe(server.origin)
    expect(await fetchOnce(feedId)).toMatchObject({ siteHome: 'renamed' })
    expect((await siteOf(feedId))?.home_url).toBe('https://blog.example')
    clock.advance(MIN)
    server.text('/feed.xml', declaringHome('https://blog.example/', '/other'))
    expect(await fetchOnce(feedId)).toMatchObject({ siteHome: 'kept' })
  })

  test('joins an unclaimed site for that home, and leaves a claimed one alone', async () => {
    await addUser('owner')
    await db.run(
      sql`insert into sites (home_url, created_at, updated_at) values ('https://blog.example', 1, 1)`,
    )
    server.text('/feed.xml', declaringHome('https://blog.example/'))
    const hosted = await addFeed('/feed.xml')
    expect(await fetchOnce(hosted.feedId)).toMatchObject({ siteHome: 'joined' })
    expect((await siteOf(hosted.feedId))?.home_url).toBe('https://blog.example')
    expect(await row(sql`select id from sites where id = ${hosted.siteId}`)).toBeUndefined()

    await db.run(sql`
      insert into sites (home_url, claimed_by, listing, created_at, updated_at)
      values ('https://claimed.example', 'owner', 'listed', 1, 1)
    `)
    server.text('/imposter.xml', declaringHome('https://claimed.example/', '/imposter.xml'))
    const imposter = await addFeed('/imposter.xml')
    expect(await fetchOnce(imposter.feedId)).toMatchObject({ siteHome: 'blocked' })
    expect((await siteOf(imposter.feedId))?.id).toBe(imposter.siteId)
  })

  test('feeds sharing a placeholder split off one at a time, and readers follow the feed', async () => {
    await addUser('a')
    await addUser('b')
    server.text('/a.xml', declaringHome('https://a.example/', '/a.xml'))
    server.text('/b.xml', declaringHome('https://b.example/', '/b.xml'))
    const a = await addFeed('/a.xml')
    const b = await addFeed('/b.xml')
    expect(a.siteId).toBe(b.siteId)
    await subscribe(db, 'a', a.feedId, NOW)
    await subscribe(db, 'b', b.feedId, NOW)
    await subscribe(db, 'b', a.feedId, NOW)
    expect((await siteOf(a.feedId))?.reader_count).toBe(2)

    expect(await fetchOnce(a.feedId)).toMatchObject({ siteHome: 'split' })
    expect(await siteOf(a.feedId)).toMatchObject({ home_url: 'https://a.example', reader_count: 2 })
    expect(await siteOf(b.feedId)).toMatchObject({ home_url: server.origin, reader_count: 1 })
    clock.advance(MIN)
    expect(await fetchOnce(b.feedId)).toMatchObject({ siteHome: 'renamed' })
    expect((await siteOf(b.feedId))?.home_url).toBe('https://b.example')
  })

  test('a URL on a claimed site that redirects elsewhere cannot put posts under that site', async () => {
    await addUser('owner')
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
              title: 'Evil',
              description: 'x',
              content: longHtml(2),
            },
          ],
        }),
      )
      server.redirect('/feed.xml', attacker.url('/feed.xml'), 302)
      const { feedId, siteId } = await addFeed('/feed.xml')
      await db.run(sql`update sites set claimed_by = 'owner' where id = ${siteId}`)
      expect(await fetchOnce(feedId)).toMatchObject({ status: 'fetched', siteHome: 'detached' })
      const site = await siteOf(feedId)
      expect(site?.home_url).toBe(attacker.origin)
      expect(site?.id).not.toBe(siteId)
    } finally {
      await attacker.stop()
    }
  })

  test('learns the site language from its articles, not the declared tag', async () => {
    server.text(
      '/feed.xml',
      rss({
        // The fixture declares <language>en</language>; the articles are Chinese.
        link: server.url('/'),
        items: [1, 2, 3].map((n) => ({
          guid: `zh-${n}`,
          link: server.url(`/zh/${n}`),
          title: `第${n}篇`,
          description: '中文摘要',
          content: '<p>这是一篇用中文写成的文章，内容足够长，可以被识别为简体中文。</p>'.repeat(3),
        })),
      }),
    )
    const { feedId } = await addFeed('/feed.xml')
    await fetchOnce(feedId)
    const site = await row<{ primary_lang: string }>(
      sql`select s.primary_lang from sites s join feeds f on f.site_id = s.id where f.id = ${feedId}`,
    )
    expect(site?.primary_lang).toBe('zh-Hans')
  })
})
