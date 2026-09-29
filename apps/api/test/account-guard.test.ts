/**
 * Every member call names the member (protocol 2). Tabs of one browser share the session cookie,
 * so once another tab signs in as someone else, this tab's requests carry that account's cookie
 * while its screen, rows and unsent changes are still the first account's. tela-api compares the
 * member a request names with the session's before any route runs, and a mismatch, a missing
 * name included, runs nothing. A shell older than protocol 2 cannot name anyone, so it is told to
 * upgrade: it knows no other 409, and it reloads into a shell that does name the member.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { CLIENT_HEADER, MEMBER_HEADER, type PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { FixtureServer, rss } from '../../../packages/ingest/test/fixture-server'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

/** Exactly what the deployed (cutover, cb096cb) shell sends: its version, and no member. */
const oldShell = { [CLIENT_HEADER]: '1' }
/** A current client that names no member. */
const nameless = { [MEMBER_HEADER]: undefined }

let server: FixtureServer
let api: TestApi
let db: TelaDb
/** The account the stale tab's rows belong to. */
let a: SignedIn
/** The account another tab signed in as, whose cookie every tab now sends. */
let b: SignedIn

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})

beforeEach(async () => {
  server.reset()
  server.text(
    '/feed.xml',
    rss({ title: 'Fixture Blog', link: server.url('/'), items: [{ guid: 'a', title: 'A' }] }),
  )
  server.set('/', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<html><head><link rel="alternate" type="application/rss+xml" href="${server.url('/feed.xml')}"></head></html>`,
    )
  })
  api = await createTestApi()
  db = api.db
  a = await signedIn(api, 'a@x.test')
  b = await signedIn(api, 'b@x.test')
  // Blog 1 is b's own, with a post that can be translated; blogs 2 and 3 nobody has claimed.
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, title, listing, claimed_by, created_at, updated_at, seq)
      values (1, 'https://blog1.example', 'Blog 1', 'listed', ${b.userId}, 0, 0, ${currentSeq}),
        (2, 'https://blog2.example', 'Blog 2', 'listed', null, 0, 0, ${currentSeq}),
        (3, 'https://blog3.example', 'Blog 3', 'listed', null, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (1, 1, 'https://blog1.example/feed', 'blog1.example', 0, 0, 0, ${currentSeq}),
        (2, 2, 'https://blog2.example/feed', 'blog2.example', 0, 0, 0, ${currentSeq}),
        (3, 3, 'https://blog3.example/feed', 'blog3.example', 0, 0, 0, ${currentSeq})`),
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, source_lang,
        current_version, content_key, seq)
      values (1, 1, 'k1', 'Blog post', 0, 0, 'ja', 1, 'ckey1', ${currentSeq})`),
    db.run(sql`insert into article_versions (article_id, version, provenance, content_key, norm_version,
        body_chars, created_at)
      values (1, 1, 'feed', 'ckey1', 1, 2000, 0)`),
    db.run(sql`insert into body_translations (content_key, lang, state, updated_at, seq)
      values ('ckey1', 'en', 'done', 0, ${currentSeq})`),
  ] as never)
})

const subsOf = (userId: string) =>
  db.all<{ feed_id: number }>(
    sql`select feed_id from subscriptions where user_id = ${userId} and deleted_at is null order by feed_id`,
  )

let mids = 0
const subscribe = (feedId: number) => ({
  mutations: [{ mid: `guard-mid-${++mids}-pad`, at: api.clock.now(), type: 'subscribe', feedId }],
})

/** Every row of every table, to show that a refused request wrote nothing anywhere. */
async function everything() {
  const tables = await db.all<{ name: string }>(sql`
    select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name
  `)
  const rows: Record<string, unknown[]> = {}
  for (const { name } of tables) rows[name] = await db.all(sql.raw(`select * from "${name}"`))
  return rows
}

describe('a shell cached before protocol 2', () => {
  test("its push of A's unsent change, on B's cookie, is told to upgrade and applies nothing", async () => {
    expect((await api.request('/api/v1/mutations', { body: subscribe(1), as: a })).status).toBe(200)

    // Another tab signed in as b. The stale tab, an old shell, still holds a's unsent change and
    // pushes it with the shared cookie, now b's.
    const stale = await api.request('/api/v1/mutations', {
      body: subscribe(2),
      cookie: b.cookie,
      headers: oldShell,
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'upgrade' })
    expect(await subsOf(b.userId)).toEqual([])
    expect(await subsOf(a.userId)).toEqual([{ feed_id: 1 }])
  })

  test("its delta pull from A's cursor, on B's cookie, is told to upgrade", async () => {
    await api.request('/api/v1/mutations', { body: subscribe(1), as: a })
    const snapshot = (await (
      await api.request('/api/v1/sync?cursor=0', { as: a })
    ).json()) as PullResponse
    expect(snapshot.rows.subscriptions.map((s) => s.feedId)).toEqual([1])
    await api.request('/api/v1/mutations', { body: subscribe(3), as: b })

    // Served, b's rows would merge into a's tables: a delta has no reset.
    const res = await api.request(`/api/v1/sync?cursor=${snapshot.cursor}`, {
      cookie: b.cookie,
      headers: oldShell,
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'upgrade' })
  })
})

describe('a current client', () => {
  test('naming no member is told the account changed, never to upgrade, and applies nothing', async () => {
    // Told to upgrade, it would reload into the same state and stop syncing. Told the account
    // changed, it forgets what it holds and starts over as the session's member.
    const push = await api.request('/api/v1/mutations', {
      body: subscribe(2),
      as: b,
      headers: nameless,
    })
    expect(push.status).toBe(409)
    expect(await push.json()).toEqual({ error: 'account_changed' })
    const pull = await api.request('/api/v1/sync?cursor=0', { as: b, headers: nameless })
    expect(pull.status).toBe(409)
    expect(await pull.json()).toEqual({ error: 'account_changed' })
    expect(await subsOf(b.userId)).toEqual([])
  })
})

describe('what a tab may ask whoever it is', () => {
  test('/api/v1/me answers whatever the tab names, so a stale tab learns who is signed in', async () => {
    const asked = [
      { cookie: b.cookie },
      { cookie: b.cookie, headers: oldShell },
      { as: b, headers: nameless },
      { as: b, headers: { [MEMBER_HEADER]: a.userId } },
    ]
    for (const init of asked) {
      const res = await api.request('/api/v1/me', init)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { id: string }).id).toBe(b.userId)
    }
  })

  test('the public routes answer with neither header, and with the wrong member named', async () => {
    expect((await api.request('/api/v1/public/discover')).status).toBe(200)
    expect((await api.request('/api/v1/public/sites/1')).status).toBe(200)
    const named = await api.request('/api/v1/public/discover', {
      as: b,
      headers: { [MEMBER_HEADER]: a.userId },
    })
    expect(named.status).toBe(200)
  })
})

type MemberRoute = {
  /** The route as tela-api registers it. */
  route: string
  path: string
  method?: string
  /** Built as the test runs, since some name the fixture server's address. */
  body?: () => unknown
  raw?: string
  /** What the request does when it runs: writes (a refused one must not), or only reads. */
  effect: 'writes' | 'reads'
}

const OPML = `<?xml version="1.0"?><opml version="2.0"><head><title>s</title></head><body>
  <outline text="x" xmlUrl="https://imported.example/feed"/></body></opml>`

/** Every authenticated /api/v1 route but /me, each as a request that does something for b. */
const MEMBER_ROUTES: MemberRoute[] = [
  { route: 'GET /api/v1/sync', path: '/api/v1/sync?cursor=0', effect: 'reads' },
  {
    route: 'POST /api/v1/mutations',
    path: '/api/v1/mutations',
    body: () => subscribe(2),
    effect: 'writes',
  },
  {
    route: 'POST /api/v1/feeds/discover',
    path: '/api/v1/feeds/discover',
    body: () => ({ url: server.url('/') }),
    effect: 'writes', // its rate limit; discovery itself writes nothing
  },
  {
    route: 'POST /api/v1/feeds',
    path: '/api/v1/feeds',
    body: () => ({ feedUrl: server.url('/feed.xml') }),
    effect: 'writes',
  },
  { route: 'POST /api/v1/feeds/opml', path: '/api/v1/feeds/opml', raw: OPML, effect: 'writes' },
  { route: 'GET /api/v1/feeds/opml', path: '/api/v1/feeds/opml', effect: 'reads' },
  {
    route: 'PUT /api/v1/profile',
    path: '/api/v1/profile',
    method: 'PUT',
    body: () => ({ handle: 'taken_over', bio: 'not mine' }),
    effect: 'writes',
  },
  {
    route: 'POST /api/v1/translations',
    path: '/api/v1/translations',
    body: () => ({ articleId: 1, lang: 'zh-Hans' }),
    effect: 'writes',
  },
  {
    route: 'GET /api/v1/translations/:contentKey/:lang',
    path: '/api/v1/translations/ckey1/en',
    effect: 'reads',
  },
  { route: 'GET /api/v1/dashboard', path: '/api/v1/dashboard', effect: 'reads' },
  { route: 'GET /api/v1/search', path: '/api/v1/search?q=blog', effect: 'reads' },
  {
    route: 'POST /api/v1/claims',
    path: '/api/v1/claims',
    body: () => ({ url: server.url('/') }),
    effect: 'writes',
  },
  { route: 'GET /api/v1/claims/:siteId', path: '/api/v1/claims/2', effect: 'reads' },
  {
    route: 'POST /api/v1/claims/:siteId/verify',
    path: '/api/v1/claims/2/verify',
    body: () => ({}),
    effect: 'writes',
  },
  {
    route: 'PUT /api/v1/sites/:siteId/topics',
    path: '/api/v1/sites/1/topics',
    method: 'PUT',
    body: () => ({ topics: ['tech'] }),
    effect: 'writes',
  },
  {
    route: 'PUT /api/v1/sites/:siteId/translation',
    path: '/api/v1/sites/1/translation',
    method: 'PUT',
    body: () => ({ optOut: true }),
    effect: 'writes',
  },
]

describe('every member route', () => {
  test('is in the table below', () => {
    const registered = api.app.routes
      .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/v1/'))
      .filter((r) => !r.path.startsWith('/api/v1/public/') && r.path !== '/api/v1/me')
      .map((r) => `${r.method} ${r.path}`)
    expect(MEMBER_ROUTES.map((r) => r.route).sort()).toEqual(registered.sort())
  })

  for (const entry of MEMBER_ROUTES) {
    test(`${entry.route} runs only for a current client naming the session's member`, async () => {
      type Init = { as?: SignedIn; cookie?: string; headers?: Record<string, string | undefined> }
      const send = (init: Init) =>
        api.request(entry.path, {
          ...(entry.method ? { method: entry.method } : {}),
          ...(entry.body ? { body: entry.body() } : {}),
          ...(entry.raw === undefined ? {} : { raw: entry.raw }),
          ...init,
        })
      const before = await everything()

      // No session is refused before anything else.
      expect((await send({ headers: b.headers })).status).toBe(401)
      // An old shell is told to upgrade, even one naming the right member.
      for (const headers of [oldShell, { ...oldShell, [MEMBER_HEADER]: b.userId }]) {
        const old = await send({ cookie: b.cookie, headers })
        expect(old.status).toBe(409)
        expect(await old.json()).toEqual({ error: 'upgrade' })
      }
      // A current client naming nobody, or a's tab on b's cookie, is told the account changed.
      for (const headers of [nameless, { [MEMBER_HEADER]: a.userId }]) {
        const stale = await send({ as: b, headers })
        expect(stale.status).toBe(409)
        expect(await stale.json()).toEqual({ error: 'account_changed' })
      }
      // None of them wrote a row, spent a rate limit, queued work or fetched anything.
      expect(await everything()).toEqual(before)
      expect(api.jobs.sent).toEqual([])
      expect(server.requests).toEqual([])

      // Naming b, the same request runs, so the refusals above refused something real.
      expect((await send({ as: b })).status).toBe(200)
      if (entry.effect === 'writes') expect(await everything()).not.toEqual(before)
    })
  }
})

describe('signing out', () => {
  // Whether the member still has a session: the row, since a signed cookie cache answers for a
  // few minutes to a cookie a browser would have dropped on the sign-out's Set-Cookie.
  const sessions = async (who: SignedIn) =>
    (
      await db.all<{ n: number }>(
        sql`select count(*) as n from session where user_id = ${who.userId}`,
      )
    )[0]?.n
  const signOut = (headers: Record<string, string | undefined>) =>
    api.request('/api/auth/sign-out', { cookie: b.cookie, headers, body: {} })

  test("a stale tab naming the account it still holds does not end the other account's session", async () => {
    const res = await signOut({ [CLIENT_HEADER]: '2', [MEMBER_HEADER]: a.userId })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'account_changed' })
    expect(await sessions(b)).toBe(1)
  })

  test('naming the member it is signs out, in the same request that checked', async () => {
    expect((await signOut({ [CLIENT_HEADER]: '2', [MEMBER_HEADER]: b.userId })).status).toBe(200)
    expect(await sessions(b)).toBe(0)
  })

  test('a current client naming no one is refused like one naming someone else', async () => {
    const res = await signOut({ [CLIENT_HEADER]: '2', [MEMBER_HEADER]: undefined })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'account_changed' })
    expect(await sessions(b)).toBe(1)
  })

  test('a shell before protocol 2 names no one, and signs out as it always did', async () => {
    expect((await signOut(oldShell)).status).toBe(200)
    expect(await sessions(b)).toBe(0)
  })
})
