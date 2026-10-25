import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { ACTION_LIMITS, duePendingFeeds, first } from '@tela/data'
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

  test('a feed too large to read is said to be so, and becomes no feed row', async () => {
    server.text(
      '/archive.xml',
      `<?xml version="1.0"?><rss version="2.0"><channel><title>All</title><!-- ${'x'.repeat(11 * 1024 * 1024)} --></channel></rss>`,
    )
    noFeedAnywhere()
    const res = await post('/api/v1/feeds/discover', { url: server.url('/archive.xml') })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'feed_too_large' })
    const add = await post('/api/v1/feeds', { feedUrl: server.url('/archive.xml') })
    expect(add.status).toBe(422)
    expect(await add.json()).toEqual({ error: 'feed_too_large' })
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

  test('an address that never answers is said to be unreachable, and writes nothing', async () => {
    // Not that it has no feed: the add and claim pages then say they could not reach it.
    const found = await post('/api/v1/feeds/discover', { url: 'http://127.0.0.1:9/' })
    expect(found.status).toBe(422)
    expect(await found.json()).toEqual({ error: 'unreachable' })
    const res = await post('/api/v1/feeds', { feedUrl: 'http://127.0.0.1:9/feed.xml' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'unreachable' })
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
    expect(await res.json()).toMatchObject({
      feeds: 2,
      subscribed: 2,
      added: 2,
      waiting: 0,
      over: 0,
      folders: 0,
      filed: 0,
    })
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
    expect(await (await importOpml(opml(['https://a.example/feed']))).json()).toMatchObject({
      feeds: 1,
      subscribed: 0,
      added: 0,
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
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="tela-subscriptions.opml"',
    )
    const text = await res.text()
    expect(text).toContain('xmlUrl="https://a.example/feed"')
    expect(text).not.toContain('b.example')
    // The head as it always was: its title and when it was made, nobody's name.
    expect(text).toContain(
      `  <head>\n    <title>Tela subscriptions</title>\n    <dateCreated>${new Date(api.clock.now()).toUTCString()}</dateCreated>\n  </head>`,
    )
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
    expect(await importOpml(`${body}${folder('Again', ['a'])}`)).toMatchObject({
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

  test('what an import made carries no clock: a device behind the server renames and moves it', async () => {
    await importOpml(`${folder('Tech', ['a', 'b'])}${blog('c')}`)
    const tech = (await pull(0)).rows.folders.find((f) => f.name === 'Tech')?.id
    // A device whose clock is a minute behind the server's, just after the import.
    const behind = api.clock.now() - 60_000
    await push([
      { type: 'putFolder', id: tech, name: 'Code', at: behind },
      { type: 'fileFeed', feedId: await feedId('a'), folderId: null, at: behind },
      { type: 'fileFeed', feedId: await feedId('c'), folderId: tech, at: behind },
    ])
    expect(await folderNames()).toEqual(['Code'])
    expect(await filed()).toEqual({ a: null, b: 'Code', c: 'Code' })
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
    expect(await importRaw(text, other)).toMatchObject({
      feeds: 5,
      subscribed: 5,
      folders: 2,
      filed: 3,
    })
    expect(await filed(other)).toEqual({ a: 'Tech', b: 'Tech', c: 'Cities & <Towns>' })
  })
})

/** A runtime setting as the console's `setting.set` leaves one (ADR 0056). */
const setting = (key: string, value: unknown) =>
  api.db.run(sql`
    insert into settings (key, value, updated_at) values (${key}, json(${JSON.stringify(value)}), 0)
    on conflict (key) do update set value = excluded.value
  `)
const makeAdmin = (who: SignedIn) =>
  api.db.run(sql`update profiles set is_admin = 1 where user_id = ${who.userId}`)
/** A feed of its own at `path`, on the fixture's one origin. */
const serveFeed = (path: string) =>
  server.text(
    path,
    rss({ title: path, link: server.url('/'), items: [{ guid: path, title: path }] }),
  )
const DAY = 86_400_000
/** The fixture clock's day ends at midnight UTC: when a day's allowance comes back. */
const NEXT_DAY = Date.UTC(2026, 8, 29)

describe('new feeds per day (ADR 0063)', () => {
  test('only a feed new to Tela counts, and past the day one is refused until midnight', async () => {
    await setting('member.feedsPerDay', 1)
    for (const path of ['/one.xml', '/two.xml', '/three.xml']) serveFeed(path)
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/one.xml') })).status).toBe(200)
    const refused = await post('/api/v1/feeds', { feedUrl: server.url('/two.xml') })
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'feed_limit', limit: 1, resetsAt: NEXT_DAY })
    expect(await count('feeds')).toBe(1)
    // Someone else adds it on their own day; for the reader it is then a feed Tela has, and free.
    const other = await signedIn(api, 'other@x.test')
    const theirs = await api.request('/api/v1/feeds', {
      body: { feedUrl: server.url('/two.xml') },
      as: other,
    })
    expect(theirs.status).toBe(200)
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/two.xml') })).status).toBe(200)
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/three.xml') })).status).toBe(429)
    // The next UTC day, the allowance is back.
    api.clock.set(NEXT_DAY)
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/three.xml') })).status).toBe(200)
    expect(
      await api.db.all(sql`
        select f.feed_url from subscriptions s join feeds f on f.id = s.feed_id
        where s.user_id = ${reader.userId} order by f.id
      `),
    ).toEqual(['/one.xml', '/two.xml', '/three.xml'].map((p) => ({ feed_url: server.url(p) })))
  })

  test('a limit of 0 adds nothing new, and an admin is not held to it', async () => {
    await setting('member.feedsPerDay', 0)
    serveFeed('/one.xml')
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/one.xml') })).status).toBe(429)
    await makeAdmin(reader)
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/one.xml') })).status).toBe(200)
  })

  test('no limit (null) holds nobody back', async () => {
    await setting('member.feedsPerDay', null)
    for (const path of ['/one.xml', '/two.xml']) {
      serveFeed(path)
      expect((await post('/api/v1/feeds', { feedUrl: server.url(path) })).status).toBe(200)
    }
  })
})

describe('the subscription cap (ADR 0063)', () => {
  test('a member who holds the most is refused before anything is fetched or added', async () => {
    await setting('member.maxSubscriptions', 1)
    for (const path of ['/one.xml', '/two.xml']) serveFeed(path)
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/one.xml') })).status).toBe(200)
    const refused = await post('/api/v1/feeds', { feedUrl: server.url('/two.xml') })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'subscription_limit', limit: 1 })
    expect(server.requestsFor('/two.xml')).toEqual([])
    expect(await count('feeds')).toBe(1)
    // An admin holds as many as they like.
    await makeAdmin(reader)
    expect((await post('/api/v1/feeds', { feedUrl: server.url('/two.xml') })).status).toBe(200)
  })
})

describe('an import past the day (ADR 0063)', () => {
  const doc = (urls: string[]) =>
    `<?xml version="1.0"?><opml version="2.0"><head><title>s</title></head><body>${urls
      .map((u) => `<outline text="x" xmlUrl="${u}"/>`)
      .join('')}</body></opml>`
  const importAs = async (urls: string[], as = reader) => {
    const res = await api.request('/api/v1/feeds/opml', {
      raw: doc(urls),
      as,
      headers: { 'content-type': 'text/x-opml' },
    })
    expect(res.status).toBe(200)
    return res.json()
  }
  const url = (name: string) => `https://${name}.example/feed`
  const waiting = async (as = reader) =>
    (
      await api.db.all<{ feed_url: string }>(
        sql`select feed_url from pending_feeds where user_id = ${as.userId} order by feed_url`,
      )
    ).map((r) => r.feed_url)

  test('subscribes what Tela has, adds the day’s new ones, and the rest wait', async () => {
    const other = await signedIn(api, 'other@x.test')
    await importAs([url('known')], other)
    await setting('member.feedsPerDay', 2)
    const names = ['known', 'n1', 'n2', 'n3', 'n4']
    expect(await importAs(names.map(url))).toEqual({
      feeds: 3,
      subscribed: 3,
      added: 2,
      waiting: 2,
      over: 0,
      perDay: 2,
      maxSubscriptions: 300,
      resetsAt: NEXT_DAY,
      folders: 0,
      filed: 0,
    })
    expect(await waiting()).toEqual([url('n3'), url('n4')])
    // The two added count against the day; a feed Tela has never waits.
    expect(await count('feeds')).toBe(3)
    // The same file again adds nothing twice, and keeps one wait per feed.
    expect(await importAs(names.map(url))).toMatchObject({ subscribed: 0, added: 0, waiting: 2 })
    expect(await waiting()).toEqual([url('n3'), url('n4')])
  })

  test('past the subscription cap a feed is left out, and what waits fits the cap', async () => {
    await setting('member.feedsPerDay', 1)
    await setting('member.maxSubscriptions', 3)
    expect(await importAs(['a', 'b', 'c', 'd', 'e'].map(url))).toMatchObject({
      feeds: 1,
      subscribed: 1,
      added: 1,
      waiting: 2,
      over: 2,
      maxSubscriptions: 3,
    })
    expect(await waiting()).toEqual([url('b'), url('c')])
  })

  test('an admin’s import adds every feed at once', async () => {
    await setting('member.feedsPerDay', 1)
    await makeAdmin(reader)
    expect(await importAs(['a', 'b', 'c'].map(url))).toMatchObject({
      added: 3,
      waiting: 0,
      perDay: null,
      maxSubscriptions: null,
    })
  })

  test('a day later, what waits is due for member.pendingFeeds', async () => {
    await setting('member.feedsPerDay', 1)
    await importAs(['a', 'b'].map(url))
    const due = (now: number) => api.db.all<{ key: string }>(duePendingFeeds(now))
    // The day's allowance is spent: nothing a run could add.
    expect(await due(api.clock.now())).toEqual([])
    expect(await due(api.clock.now() + DAY)).toMatchObject([{ key: reader.userId }])
  })
})
