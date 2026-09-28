import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { ACTION_LIMITS, first } from '@tela/data'
import { sql } from 'drizzle-orm'
import { FixtureServer, rss } from '../../../packages/ingest/test/fixture-server'
import { createTestApi, signedIn, type TestApi } from './helpers'

let server: FixtureServer
let api: TestApi
let reader: { cookie: string; userId: string }

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(async () => {
  server.reset()
  api = await createTestApi()
  reader = await signedIn(api)
  server.text(
    '/feed.xml',
    rss({ title: 'Fixture Blog', link: server.url('/'), items: [{ guid: 'a', title: 'A' }] }),
  )
  server.set('/', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<html><head><link rel="alternate" type="application/rss+xml" href="${server.url('/feed.xml')}"></head><body>hi</body></html>`,
    )
  })
  server.set('/plain', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>no feeds here</body></html>')
  })
})

const post = (path: string, body: unknown) => api.request(path, { body, cookie: reader.cookie })
/** Discovery also tries well-known paths on the origin, so "no feed" means none anywhere. */
const noFeedAnywhere = () =>
  server.set('/feed.xml', (_req, res) => {
    res.writeHead(404)
    res.end()
  })
const count = async (table: string) =>
  (await first<{ n: number }>(api.db, sql.raw(`select count(*) as n from ${table}`)))?.n ?? 0

describe('discovery', () => {
  test("finds the feed a blog's home page declares, fetched and parsed", async () => {
    const res = await post('/api/v1/feeds/discover', { url: server.url('/') })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      feeds: [{ url: server.url('/feed.xml'), title: 'Fixture Blog', format: 'rss', itemCount: 1 }],
    })
    // Discovery writes nothing.
    expect(await count('feeds')).toBe(0)
  })

  test('says what went wrong, and is rate limited', async () => {
    expect((await post('/api/v1/feeds/discover', { url: 'not a url at all' })).status).toBe(400)
    noFeedAnywhere()
    const none = await post('/api/v1/feeds/discover', { url: server.url('/plain') })
    expect(await none.json()).toEqual({ feeds: [] })
    for (let i = 2; i < ACTION_LIMITS.discover.limit; i++) {
      await post('/api/v1/feeds/discover', { url: server.url('/plain') })
    }
    expect((await post('/api/v1/feeds/discover', { url: server.url('/') })).status).toBe(429)
  })
})

describe('adding a feed', () => {
  test('registers it once parsed, subscribes the member, and fetches it at once', async () => {
    const res = await post('/api/v1/feeds', { feedUrl: server.url('/feed.xml') })
    expect(res.status).toBe(200)
    const { feedId } = (await res.json()) as { feedId: number }
    expect(
      await first<{ feed_id: number }>(
        api.db,
        sql`select feed_id from subscriptions where user_id = ${reader.userId}`,
      ),
    ).toEqual({ feed_id: feedId })
    expect(api.jobs.sent).toMatchObject([
      { queue: 'fetch', body: { kind: 'feed.fetch', key: String(feedId) } },
    ])
    const feed = await first<{ added_by: string }>(
      api.db,
      sql`select added_by from feeds where id = ${feedId}`,
    )
    expect(feed?.added_by).toBe(reader.userId)
  })

  test('a URL that is not a feed becomes no feed row', async () => {
    noFeedAnywhere()
    const res = await post('/api/v1/feeds', { feedUrl: server.url('/plain') })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'not_a_feed' })
    expect(await count('feeds')).toBe(0)
  })

  test('a feed Tela already follows is not fetched again to be added', async () => {
    const other = await signedIn(api, 'other@x.test')
    await api.request('/api/v1/feeds', {
      body: { feedUrl: server.url('/feed.xml') },
      cookie: other.cookie,
    })
    const before = server.requestsFor('/feed.xml').length
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/feed.xml') })).status).toBe(200)
    expect(server.requestsFor('/feed.xml').length).toBe(before)
    expect(await count('subscriptions')).toBe(2)
  })

  test('an unreachable host finds no feed, and writes nothing', async () => {
    // Discovery treats a candidate it cannot fetch as not a feed.
    const res = await post('/api/v1/feeds', { feedUrl: 'http://127.0.0.1:9/feed.xml' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'not_a_feed' })
    expect(await count('feeds')).toBe(0)
  })
})

describe('OPML', () => {
  const opml = (urls: string[]) =>
    `<?xml version="1.0"?><opml version="2.0"><head><title>s</title></head><body>${urls
      .map((u) => `<outline text="x" xmlUrl="${u}"/>`)
      .join('')}</body></opml>`
  const importOpml = (text: string) =>
    api.app.request(`${'http://tela.test'}/api/v1/feeds/opml`, {
      method: 'POST',
      headers: { origin: 'http://tela.test', cookie: reader.cookie, 'content-type': 'text/x-opml' },
      body: text,
    })

  test('imports every feed without fetching, subscribes the member, and leaves them due', async () => {
    const res = await importOpml(
      opml(['https://a.example/feed', 'https://b.example/rss', 'https://a.example/feed']),
    )
    expect(await res.json()).toEqual({ feeds: 2, subscribed: 2 })
    expect(server.requests).toHaveLength(0)
    const due = await first<{ n: number }>(
      api.db,
      sql`select count(*) as n from feeds where next_fetch_at <= ${api.clock.now()}`,
    )
    expect(due?.n).toBe(2)
    expect(await api.db.all(sql`select home_url from sites order by home_url`)).toEqual([
      { home_url: 'https://a.example' },
      { home_url: 'https://b.example' },
    ])
    // Importing again adds nothing.
    expect(await (await importOpml(opml(['https://a.example/feed']))).json()).toEqual({
      feeds: 1,
      subscribed: 0,
    })
  })

  test('refuses what is not OPML, and what is too large', async () => {
    expect((await importOpml('<html>nope</html>')).status).toBe(400)
    expect((await importOpml('x'.repeat(1024 * 1024 + 1))).status).toBe(413)
  })

  test('exports what the member follows now, and nothing they left', async () => {
    await importOpml(opml(['https://a.example/feed', 'https://b.example/rss']))
    const b = await first<{ id: number }>(
      api.db,
      sql`select id from feeds where feed_url = 'https://b.example/rss'`,
    )
    await api.db.run(
      sql`update subscriptions set deleted_at = 1 where feed_id = ${b?.id} and user_id = ${reader.userId}`,
    )
    const res = await api.request('/api/v1/feeds/opml', { cookie: reader.cookie })
    expect(res.headers.get('content-type')).toContain('text/x-opml')
    const text = await res.text()
    expect(text).toContain('xmlUrl="https://a.example/feed"')
    expect(text).not.toContain('b.example')
  })
})
