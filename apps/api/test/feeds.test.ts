import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { ACTION_LIMITS, first } from '@tela/data'
import { MAX_FOLDERS } from '@tela/shared'
import type { PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { FixtureServer, rss } from '../../../packages/ingest/test/fixture-server'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let server: FixtureServer
let api: TestApi
let reader: SignedIn

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

const post = (path: string, body: unknown) => api.request(path, { body, as: reader })
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
    // Time passes while tela-jobs fetches the feed, as it does over a real RPC.
    const body = rss({
      title: 'Fixture Blog',
      link: server.url('/'),
      items: [{ guid: 'a', title: 'A' }],
    })
    server.set('/feed.xml', (_req, res) => {
      api.clock.advance(250)
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(body)
    })
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
    await api.request('/api/v1/feeds', { body: { feedUrl: server.url('/feed.xml') }, as: other })
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
    api.request('/api/v1/feeds/opml', {
      raw: text,
      as: reader,
      headers: { 'content-type': 'text/x-opml' },
    })

  test('imports every feed without fetching, subscribes the member, and leaves them due', async () => {
    const res = await importOpml(
      opml(['https://a.example/feed', 'https://b.example/rss', 'https://a.example/feed']),
    )
    expect(await res.json()).toEqual({ feeds: 2, subscribed: 2, folders: 0, filed: 0 })
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
      folders: 0,
      filed: 0,
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
    const res = await api.request('/api/v1/feeds/opml', { as: reader })
    expect(res.headers.get('content-type')).toContain('text/x-opml')
    const text = await res.text()
    expect(text).toContain('xmlUrl="https://a.example/feed"')
    expect(text).not.toContain('b.example')
  })
})

describe('OPML folders (ADR 0048)', () => {
  const doc = (body: string) =>
    `<?xml version="1.0"?><opml version="2.0"><head><title>s</title></head><body>${body}</body></opml>`
  const blog = (name: string) => `<outline text="${name}" xmlUrl="https://${name}.example/feed"/>`
  const folder = (name: string, blogs: string[]) =>
    `<outline text="${name}">${blogs.map(blog).join('')}</outline>`
  const importRaw = async (text: string, as = reader) => {
    const res = await api.request('/api/v1/feeds/opml', {
      raw: text,
      as,
      headers: { 'content-type': 'text/x-opml' },
    })
    expect(res.status).toBe(200)
    return res.json()
  }
  const importOpml = (body: string) => importRaw(doc(body))
  const feedId = async (name: string) =>
    (
      await first<{ id: number }>(
        api.db,
        sql`select id from feeds where feed_url = ${`https://${name}.example/feed`}`,
      )
    )?.id ?? 0
  /** The blogs the member has a filing for, each by the name of its live folder; null is none. */
  const filed = async (as = reader) =>
    Object.fromEntries(
      (
        await api.db.all<{ host: string; folder: string | null }>(sql`
          select f.host, d.name as folder from feed_folders ff join feeds f on f.id = ff.feed_id
          left join folders d on d.id = ff.folder_id and d.deleted_at is null
          where ff.user_id = ${as.userId}
        `)
      ).map((r) => [r.host.replace('.example', ''), r.folder]),
    )
  const folderNames = async () =>
    (
      await api.db.all<{ name: string }>(
        sql`select name from folders where user_id = ${reader.userId} and deleted_at is null`,
      )
    )
      .map((r) => r.name)
      .sort()
  let mids = 0
  const push = async (mutations: Record<string, unknown>[]) => {
    const res = await api.request('/api/v1/mutations', {
      body: {
        mutations: mutations.map((m) => ({
          mid: `mid-${++mids}-folders`,
          at: api.clock.now(),
          ...m,
        })),
      },
      as: reader,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { rejected: unknown[] }).rejected).toEqual([])
  }
  const pull = async (cursor: number) => {
    const res = await api.request(`/api/v1/sync?cursor=${cursor}`, { as: reader })
    expect(res.status).toBe(200)
    return (await res.json()) as PullResponse
  }

  test('files each blog in the folder the file names, making the folders it needs', async () => {
    const before = await pull(0)
    const body = `${folder('Tech', ['a', 'b'])}${folder('  Cities ', ['c'])}${blog('d')}`
    // A blog listed twice stays in the first folder, and one left holding nothing is not made.
    expect(await importOpml(`${body}${folder('Again', ['a'])}`)).toEqual({
      feeds: 4,
      subscribed: 4,
      folders: 2,
      filed: 3,
    })
    expect(await folderNames()).toEqual(['Cities', 'Tech'])
    expect(await filed()).toEqual({ a: 'Tech', b: 'Tech', c: 'Cities' })
    // The device learns of both in its next pull, as it would of a folder made on another device.
    const delta = await pull(before.cursor)
    expect(delta.rows.folders.map((f) => f.name).sort()).toEqual(['Cities', 'Tech'])
    const tech = delta.rows.folders.find((f) => f.name === 'Tech')?.id
    expect(tech).toMatch(/^[A-Za-z0-9-]{8,64}$/)
    expect(
      delta.rows.feedFolders
        .filter((f) => f.folderId === tech)
        .map((f) => f.feedId)
        .sort(),
    ).toEqual([await feedId('a'), await feedId('b')].sort())
  })

  test('files into a folder of the same name, case aside, rather than make a second', async () => {
    await push([{ type: 'putFolder', id: 'folder-cities', name: 'cities' }])
    expect(await importOpml(folder('Cities', ['c']))).toMatchObject({ folders: 0, filed: 1 })
    expect(await folderNames()).toEqual(['cities'])
    expect(
      await first<{ folder_id: string | null }>(
        api.db,
        sql`select folder_id from feed_folders where feed_id = ${await feedId('c')}`,
      ),
    ).toEqual({ folder_id: 'folder-cities' })
    // Accents are not case: Café is a folder of its own.
    await importOpml(`${folder('Café', ['e'])}${folder('CAFE', ['f'])}${folder('cafe', ['g'])}`)
    expect(await folderNames()).toEqual(['CAFE', 'Café', 'cities'])
    expect(await filed()).toMatchObject({ e: 'Café', f: 'CAFE', g: 'CAFE' })
  })

  test('never moves a blog the member filed; one in no folder, or a deleted one, is filed', async () => {
    await importOpml(`${blog('a')}${blog('b')}${blog('c')}`)
    const [a, b, c] = [await feedId('a'), await feedId('b'), await feedId('c')]
    await push([
      { type: 'putFolder', id: 'folder-mine', name: 'Mine' },
      { type: 'putFolder', id: 'folder-gone', name: 'Gone' },
      { type: 'fileFeed', feedId: a, folderId: 'folder-mine' },
      { type: 'fileFeed', feedId: b, folderId: 'folder-gone' },
      { type: 'fileFeed', feedId: c, folderId: 'folder-mine' },
    ])
    api.clock.advance(10)
    await push([{ type: 'fileFeed', feedId: c, folderId: null }])
    // A filing still naming a folder that is gone: deleteFolder unfiles its blogs, but a filing
    // read as filed only while its folder lives cannot be misled by one it missed.
    await api.db.run(
      sql`update folders set deleted_at = ${api.clock.now()} where id = 'folder-gone'`,
    )
    api.clock.advance(10)
    expect(await importOpml(folder('Tech', ['a', 'b', 'c']))).toMatchObject({
      folders: 1,
      filed: 2,
    })
    expect(await filed()).toEqual({ a: 'Mine', b: 'Tech', c: 'Tech' })
    // A folder whose every blog is filed already is not made.
    expect(await importOpml(folder('Other', ['a']))).toMatchObject({ folders: 0, filed: 0 })
    expect(await folderNames()).toEqual(['Mine', 'Tech'])
  })

  test('makes no folder past MAX_FOLDERS: its blogs stay in none, and one the member has fills', async () => {
    const ids = JSON.stringify(Array.from({ length: MAX_FOLDERS - 1 }, (_, i) => i))
    await api.db.run(sql`
      insert into folders (id, user_id, name, created_at, updated_at)
      select 'folder-n' || value, ${reader.userId}, 'F' || value, 0, 0 from json_each(${ids})
    `)
    const body = `${folder('New one', ['a'])}${folder('New two', ['b'])}${folder('f7', ['c'])}`
    expect(await importOpml(body)).toMatchObject({ feeds: 3, folders: 1, filed: 2 })
    expect(await filed()).toEqual({ a: 'New one', c: 'F7' })
    expect(await folderNames()).toHaveLength(MAX_FOLDERS)
  })

  test('an export keeps each live folder, and importing it elsewhere puts the blogs back', async () => {
    const tech = folder('Tech', ['b', 'a'])
    await importOpml(
      `${tech}${folder('Cities & <Towns>', ['c'])}${folder('Gone', ['g'])}${blog('d')}`,
    )
    const gone = await first<{ id: string }>(
      api.db,
      sql`select id from folders where name = 'Gone'`,
    )
    await push([{ type: 'deleteFolder', id: gone?.id }])
    const text = await (await api.request('/api/v1/feeds/opml', { as: reader })).text()
    // Folders by name, each with its blogs by title, then the blogs in none: a deleted folder's
    // blogs among them.
    const outlines = [...text.matchAll(/<outline (?:type="rss" )?text="([^"]+)"/g)].map((m) => m[1])
    expect(outlines).toEqual([
      'Cities &amp; &lt;Towns&gt;',
      'https://c.example',
      'Tech',
      'https://a.example',
      'https://b.example',
      'https://d.example',
      'https://g.example',
    ])
    expect(text).not.toContain('Gone')
    const other = await signedIn(api, 'other@x.test')
    expect(await importRaw(text, other)).toEqual({
      feeds: 5,
      subscribed: 5,
      folders: 2,
      filed: 3,
    })
    expect(await filed(other)).toEqual({ a: 'Tech', b: 'Tech', c: 'Cities & <Towns>' })
  })
})
