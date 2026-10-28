import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, first, importFeedUrls, type Lease, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { claimReason } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { type GitHub, GitHubUnavailable } from '../src/github'
import { createHttpClient, type HttpClient } from '../src/http'
import {
  createIngest,
  dueAssets,
  dueClaims,
  type IngestContext,
  ingestFeed,
  notFoundProbe,
  registerFeed,
  siteAssetsJob,
  VERIFICATION_META,
  verifyClaimJob,
  websubSubscribeJob,
} from '../src/pipeline'
import { FixtureServer, longHtml, rss } from './fixture-server'

const NOW = Date.UTC(2026, 8, 4, 10)
const MIN = 60_000
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

let server: FixtureServer
let db: TelaDb
let assets: ReturnType<typeof memoryBlobs>
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
  assets = memoryBlobs()
  clock = fakeClock(NOW)
})

const ctx = (extra: Partial<IngestContext> = {}): IngestContext => ({
  db,
  blobs: memoryBlobs(),
  assets,
  http,
  clock,
  random: () => 0.5,
  publicUrl: 'https://tela.test',
  allowPrivateHosts: true,
  ...extra,
})

async function claim(kind: Lease['kind'], key: number, owner = 'w1'): Promise<Lease> {
  const got = await claimDue(db, {
    kind,
    owner,
    now: clock.now(),
    ttlMs: 2 * MIN,
    limit: 1,
    due: sql`select ${key} as key, null as host, 0 as ord`,
  })
  if (got.length !== 1) throw new Error(`could not claim ${kind} ${key}`)
  return { kind, key: String(key), owner }
}

function serveHtml(path: string, html: string) {
  server.set(path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
}

async function addUser(id: string, handle: string) {
  await addTestUser(db, id)
  await db.run(
    sql`insert into profiles (user_id, handle, created_at, updated_at) values (${id}, ${handle}, 1, 1)`,
  )
}

async function siteFor(path: string) {
  server.text(
    path,
    rss({
      link: server.url('/'),
      items: [
        { guid: 'a', link: server.url('/a'), title: 'A', description: 'a', content: longHtml(3) },
      ],
    }),
  )
  const { feedId, siteId } = await registerFeed(db, { feedUrl: server.url(path), now: clock.now() })
  await ingestFeed(ctx(), await claim('feed.fetch', feedId))
  return { feedId, siteId }
}

describe('siteAssetsJob', () => {
  test('stores the best raster icon the home page declares, and stamps the site once', async () => {
    const { siteId } = await siteFor('/feed.xml')
    serveHtml(
      '/',
      '<html><head><link rel="icon" href="/logo.svg"><link rel="icon" sizes="64x64" href="/icon.png"></head></html>',
    )
    server.set('/icon.png', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    })
    const due = await claimDue(db, {
      kind: 'site.assets',
      owner: 'x',
      now: clock.now(),
      ttlMs: MIN,
      limit: 5,
      due: dueAssets(),
    })
    expect(due.map((d) => d.key)).toEqual([String(siteId)])
    await db.run(sql`delete from leases`)

    expect(await siteAssetsJob(ctx(), await claim('site.assets', siteId))).toEqual({
      status: 'done',
      favicon: true,
      homePage: true,
    })
    const site = await first<{ favicon_key: string; assets_checked_at: number }>(
      db,
      sql`select favicon_key, assets_checked_at from sites where id = ${siteId}`,
    )
    expect(site?.favicon_key).toMatch(new RegExp(`^sites/${siteId}/favicon-.+\\.png$`))
    expect(site?.assets_checked_at).toBe(NOW)
    expect((await assets.head(site!.favicon_key))?.contentType).toBe('image/png')
    // Checked: no longer due.
    const again = await claimDue(db, {
      kind: 'site.assets',
      owner: 'y',
      now: clock.now(),
      ttlMs: MIN,
      limit: 5,
      due: dueAssets(),
    })
    expect(again).toHaveLength(0)
  })

  test('never stores an SVG, and stamps the site even when it finds nothing', async () => {
    const { siteId } = await siteFor('/feed.xml')
    serveHtml('/', '<html><head><link rel="icon" href="/only.svg"></head></html>')
    server.set('/favicon.ico', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      res.end('<svg/>')
    })
    expect(await siteAssetsJob(ctx(), await claim('site.assets', siteId))).toEqual({
      status: 'done',
      favicon: false,
      homePage: true,
    })
    expect(assets.size).toBe(0)
  })

  /** A home page declaring an icon, and `/favicon.ico` beside it, both PNGs. */
  function iconsBothWays() {
    serveHtml('/', '<html><head><link rel="icon" sizes="64x64" href="/icon.png"></head></html>')
    for (const path of ['/icon.png', '/favicon.ico']) {
      server.set(path, (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(PNG)
      })
    }
  }

  test("on a feed-only blog, tries /favicon.ico alone: its pages and robots.txt aren't asked", async () => {
    const { siteId } = await siteFor('/feed.xml')
    await db.run(sql`update sites set feed_only = 1 where id = ${siteId}`)
    iconsBothWays()
    server.requests.length = 0
    expect(await siteAssetsJob(ctx(), await claim('site.assets', siteId))).toEqual({
      status: 'done',
      favicon: true,
      homePage: false,
    })
    expect(server.requests.map((r) => r.path)).toEqual(['/favicon.ico'])
    expect(await first(db, sql`select origin from robots_rules`)).toBeUndefined()
  })

  test('asks robots.txt before the home page, and keeps what it said for the next page', async () => {
    const { siteId } = await siteFor('/feed.xml')
    iconsBothWays()
    server.text('/robots.txt', 'User-agent: *\nAllow: /\n\nUser-agent: Tela\nDisallow: /$\n', {
      headers: { 'content-type': 'text/plain' },
    })
    server.requests.length = 0
    expect(await siteAssetsJob(ctx(), await claim('site.assets', siteId))).toEqual({
      status: 'done',
      favicon: true,
      homePage: false,
    })
    // Refused the home page, it still tries the icon a browser would ask for.
    expect(server.requests.map((r) => r.path)).toEqual(['/robots.txt', '/favicon.ico'])
    expect(
      await first<Record<string, unknown>>(
        db,
        sql`select origin, status, body, fetched_at from robots_rules`,
      ),
    ).toEqual({
      origin: server.origin,
      status: 200,
      body: 'User-agent: Tela\nDisallow: /$\n',
      fetched_at: NOW,
    })
  })

  test('a home page redirected on its own origin is judged by the path it landed on', async () => {
    const { siteId } = await siteFor('/feed.xml')
    iconsBothWays()
    server.redirect('/', server.url('/private/'))
    serveHtml(
      '/private/',
      '<html><head><link rel="icon" sizes="64x64" href="/icon.png"></head></html>',
    )
    server.text('/robots.txt', 'User-agent: Tela\nDisallow: /private/\n', {
      headers: { 'content-type': 'text/plain' },
    })
    server.requests.length = 0
    expect(await siteAssetsJob(ctx(), await claim('site.assets', siteId))).toEqual({
      status: 'done',
      favicon: true,
      homePage: false,
    })
    // Refused where it landed, the page's icons are not looked for, and robots.txt is read once.
    expect(server.requests.map((r) => r.path)).toEqual([
      '/robots.txt',
      '/',
      '/private/',
      '/favicon.ico',
    ])
  })

  test('a home page redirected to another origin asks that origin too', async () => {
    const other = await FixtureServer.start()
    try {
      const { siteId } = await siteFor('/feed.xml')
      iconsBothWays()
      server.redirect('/', other.url('/'))
      other.set('/', (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><head><link rel="icon" sizes="64x64" href="/moved.png"></head></html>')
      })
      other.set('/robots.txt', (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('User-agent: Tela\nDisallow: /\n')
      })
      expect(await siteAssetsJob(ctx(), await claim('site.assets', siteId))).toEqual({
        status: 'done',
        favicon: true,
        homePage: false,
      })
      // Refused where it landed, the page's icons are not looked for: the blog's own icon is.
      expect(other.requests.map((r) => r.path)).toEqual(['/', '/robots.txt'])
      expect(server.requestsFor('/favicon.ico')).toHaveLength(1)
      expect(await db.all(sql`select origin from robots_rules order by origin`)).toHaveLength(2)
    } finally {
      await other.stop()
    }
  })

  test('reads robots.txt from where the blog is fetched, which extraction shares', async () => {
    const { feedId, siteId } = await siteFor('/feed.xml')
    await db.run(sql`update feeds set fetch_region = 'cn' where id = ${feedId}`)
    iconsBothWays()
    const asked: { path: string; region: string | undefined }[] = []
    const spy: HttpClient = {
      get: (url, options) => {
        asked.push({ path: new URL(url).pathname, region: options?.region })
        return http.get(url, options)
      },
    }
    await siteAssetsJob(ctx({ http: spy }), await claim('site.assets', siteId))
    expect(asked.find((a) => a.path === '/robots.txt')).toEqual({
      path: '/robots.txt',
      region: 'cn',
    })
  })
})

describe('discovery on a feed-only blog (ADR 0061)', () => {
  test('answers from the feeds Tela keeps, and asks the blog nothing', async () => {
    const { feedId, siteId } = await siteFor('/feed.xml')
    serveHtml('/posts/a', `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`)
    const ingest = createIngest({ db, http, now: () => clock.now() })
    // Before the switch, a post's address is fetched to find the feed it declares.
    server.requests.length = 0
    expect(await ingest.discover({ url: server.url('/posts/a') })).toMatchObject({
      feeds: [{ url: server.url('/feed.xml') }],
    })
    expect(server.requests.length).toBeGreaterThan(0)

    await db.run(sql`update sites set feed_only = 1 where id = ${siteId}`)
    server.requests.length = 0
    expect(await ingest.discover({ url: server.url('/posts/a') })).toEqual({
      feeds: [
        {
          url: server.url('/feed.xml'),
          title: 'Test Blog',
          format: 'rss',
          itemCount: 1,
          homeUrl: server.origin,
        },
      ],
    })
    // A feed address Tela does not know on the same blog is the blog's own feed, unfetched.
    expect(await ingest.addFeed({ feedUrl: server.url('/other.xml'), actorId: null })).toEqual({
      feedId,
      siteId,
      created: false,
    })
    expect(await ingest.startClaim({ url: server.url('/'), actorId: 'u1' })).toEqual({
      feedId,
      siteId,
    })
    expect(server.requests).toHaveLength(0)

    // A blog with no feed left to offer has none, and is still not asked.
    await db.run(sql`update feeds set status = 'dead' where id = ${feedId}`)
    expect(await ingest.discover({ url: server.url('/') })).toEqual({ error: 'not_a_feed' })
    expect(server.requests).toHaveLength(0)
  })
})

describe('discovery on a blog in Discover with no feed of its own (ADR 0068)', () => {
  const ELSEWHERE = 'https://feeds.example/lab-engineering.xml'

  /** A blog at the fixture's origin read through a feed kept on another host, as a lab's is. */
  async function keptElsewhere() {
    serveHtml('/engineering', '<html><body><a href="/engineering/a">A post</a></body></html>')
    return registerFeed(db, { feedUrl: ELSEWHERE, homeUrl: server.url('/engineering'), now: NOW })
  }

  test('offers the feeds its public page shows, only once it is listed', async () => {
    const { siteId } = await keptElsewhere()
    const ingest = createIngest({ db, http, now: () => clock.now() })
    const page = server.url('/engineering')
    // Private, it is one member's choice of feed, and a feed address can carry a secret.
    expect(await ingest.discover({ url: page })).toEqual({ feeds: [] })

    await db.run(sql`update sites set listing = 'listed' where id = ${siteId}`)
    const offered = {
      feeds: [
        {
          url: ELSEWHERE,
          title: null,
          format: 'rss' as const,
          itemCount: 0,
          homeUrl: server.origin,
        },
      ],
    }
    expect(await ingest.discover({ url: page })).toEqual(offered)
    await db.run(sql`update sites set listing = 'featured' where id = ${siteId}`)
    expect(await ingest.discover({ url: server.url('/') })).toEqual(offered)

    // A claim still needs the blog's own feed: one kept elsewhere is no proof of the blog.
    expect(await ingest.startClaim({ url: page, actorId: 'u1' })).toEqual({ error: 'not_a_feed' })
  })

  test('answers a page with a feed of its own as before, and never offers a dead feed', async () => {
    const { feedId, siteId } = await keptElsewhere()
    await db.run(sql`update sites set listing = 'listed' where id = ${siteId}`)
    const ingest = createIngest({ db, http, now: () => clock.now() })

    await db.run(sql`update feeds set status = 'dead' where id = ${feedId}`)
    expect(await ingest.discover({ url: server.url('/engineering') })).toEqual({ feeds: [] })

    await db.run(sql`update feeds set status = 'active' where id = ${feedId}`)
    server.text('/own.xml', rss({ link: server.url('/'), items: [] }))
    serveHtml('/news', `<link rel="alternate" type="application/rss+xml" href="/own.xml">`)
    const found = await ingest.discover({ url: server.url('/news') })
    expect(found).toMatchObject({ feeds: [{ url: server.url('/own.xml') }] })
    expect('feeds' in found && found.feeds).toHaveLength(1)
  })
})

describe('verifyClaimJob', () => {
  async function pendingClaim(siteId: number, userId: string, token = 'tok-123') {
    await db.run(sql`
      insert into site_claims (site_id, user_id, method, token, created_at)
      values (${siteId}, ${userId}, 'meta', ${token}, ${NOW})
    `)
    return (await first<{ id: number }>(
      db,
      sql`select id from site_claims order by id desc limit 1`,
    ))!.id
  }

  test('a meta token verifies: the site is claimed and listed, and a squatter feed moves off it', async () => {
    await addUser('owner', 'owner')
    const { siteId, feedId } = await siteFor('/feed.xml')
    // A feed served from another origin joined while the site was unclaimed.
    const squatter = await FixtureServer.start()
    try {
      await db.run(sql`
        insert into feeds (site_id, feed_url, host, served_origin, next_fetch_at, created_at, updated_at)
        values (${siteId}, ${squatter.url('/evil.xml')}, '127.0.0.1', ${squatter.origin}, ${NOW}, 1, 1)
      `)
      serveHtml(
        '/',
        `<html><head><meta name="${VERIFICATION_META}" content="tok-123">
          <link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>`,
      )
      const claimId = await pendingClaim(siteId, 'owner')
      const due = await claimDue(db, {
        kind: 'site.claim',
        owner: 'x',
        now: clock.now(),
        ttlMs: MIN,
        limit: 5,
        due: dueClaims(),
      })
      expect(due.map((d) => d.key)).toEqual([String(claimId)])
      await db.run(sql`delete from leases`)

      expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toMatchObject({
        status: 'verified',
        method: 'meta',
      })
      const site = await first<{ claimed_by: string; listing: string; declared_feed_urls: string }>(
        db,
        sql`select claimed_by, listing, declared_feed_urls from sites where id = ${siteId}`,
      )
      expect(site?.claimed_by).toBe('owner')
      expect(site?.listing).toBe('listed')
      expect(JSON.parse(site!.declared_feed_urls)).toEqual([server.url('/feed.xml')])
      const onSite = await db.all<{ id: number }>(
        sql`select id from feeds where site_id = ${siteId}`,
      )
      expect(onSite.map((f) => f.id)).toEqual([feedId])
    } finally {
      await squatter.stop()
    }
  })

  test('a rel="me" link to the profile verifies too', async () => {
    await addUser('owner', 'owner')
    const { siteId } = await siteFor('/feed.xml')
    serveHtml('/', '<html><body><a rel="me" href="https://tela.test/@owner/">me</a></body></html>')
    const claimId = await pendingClaim(siteId, 'owner')
    expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toMatchObject({
      status: 'verified',
      method: 'rel_me',
    })
  })

  test('a rel="me" link counts however a browser would follow it to the profile', async () => {
    await addUser('owner', 'owner')
    const { siteId } = await siteFor('/feed.xml')
    // The old address, %40 for @, and a query: still the profile, and on the home page alone.
    serveHtml(
      '/',
      '<html><head><link rel="Me" href="http://tela.ainaive.com/%40Owner?ref=blog"></head></html>',
    )
    const claimId = await pendingClaim(siteId, 'owner')
    expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toMatchObject({
      status: 'verified',
      method: 'rel_me',
    })
  })

  /** The claim's stored reason, parsed. */
  const reasonOf = async (claimId: number) =>
    claimReason(
      (await first<{ error: string }>(db, sql`select error from site_claims where id = ${claimId}`))
        ?.error,
    )

  test('no proof fails with a reason the member can act on', async () => {
    await addUser('owner', 'owner')
    const { siteId } = await siteFor('/feed.xml')
    serveHtml('/', '<html><body>nothing here</body></html>')
    const claimId = await pendingClaim(siteId, 'owner')
    const outcome = await verifyClaimJob(ctx(), await claim('site.claim', claimId))
    expect(outcome.status).toBe('failed')
    const row = await first<{ status: string }>(
      db,
      sql`select status from site_claims where id = ${claimId}`,
    )
    expect(row?.status).toBe('failed')
    expect(await reasonOf(claimId)).toEqual({ reason: 'no_proof', page: server.origin })
  })

  test.each([
    [403, 'home_refused'],
    [429, 'home_refused'],
    [500, 'home_status'],
  ] as const)(
    'a home page answering %i fails as %s, which says what to do',
    async (status, reason) => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      server.set('/', (_req, res) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body>Checking your browser…</body></html>')
      })
      const claimId = await pendingClaim(siteId, 'owner')
      expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
        'failed',
      )
      expect(await reasonOf(claimId)).toEqual({ reason, page: server.origin, status })
    },
  )

  test('a home page that never answers says it took too long', async () => {
    await addUser('owner', 'owner')
    const { siteId } = await siteFor('/feed.xml')
    // Past the client's 300 ms.
    server.set('/', (_req, res) => {
      setTimeout(() => res.end('<html></html>'), 600)
    })
    const claimId = await pendingClaim(siteId, 'owner')
    expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe('failed')
    expect(await reasonOf(claimId)).toEqual({
      reason: 'home_unreachable',
      page: server.origin,
      why: 'timeout',
    })
  })

  /** The blog's page for an address it does not have, as the claim with token `tok-123` asks. */
  const serveNotFound = (html: string, status = 404) =>
    server.set(notFoundProbe('tok-123'), (_req, res) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  const chromeOnly = (footer: string) =>
    `<html><body><main>Nothing here.</main><footer>${footer}</footer></body></html>`

  describe('a link without rel="me" (ADR 0045)', () => {
    const footerLink = (href: string, rel = 'noopener noreferrer') =>
      `<a href="${href}" rel="${rel}">Tela</a>`
    const footer = (href: string, rel?: string) =>
      `<html><body><main>a post</main><footer>${footerLink(href, rel)}</footer></body></html>`

    test("counts when the blog's 404 page shows it too: it is the blog's own", async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', footer('https://tela.test/@owner'))
      serveNotFound(chromeOnly(footerLink('https://www.tela.test/@owner/')))
      const claimId = await pendingClaim(siteId, 'owner')
      expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toMatchObject({
        status: 'verified',
        method: 'link',
      })
      const row = await first<{ method: string }>(
        db,
        sql`select method from site_claims where id = ${claimId}`,
      )
      expect(row?.method).toBe('link')
    })

    test('a mention is not proof, wherever else the post that makes it is shown', async () => {
      // The home page shows a post in full that links the profile, and the post's own page shows
      // it again. A feed from elsewhere that names this blog as its home also carries a backdated
      // item pointing at that post, so an "oldest post" would be the post itself. Neither page is
      // asked: only the 404 page, which has no post on it.
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      const mention = '<article>A reader, <a href="https://tela.test/@owner">here</a></article>'
      serveHtml('/', `<html><body>${mention}</body></html>`)
      serveHtml('/a', `<html><body>${mention}</body></html>`)
      const elsewhere = await FixtureServer.start()
      try {
        await db.run(sql`
          insert into feeds (site_id, feed_url, host, served_origin, next_fetch_at, created_at, updated_at)
          values (${siteId}, ${elsewhere.url('/x.xml')}, '127.0.0.1', ${elsewhere.origin}, ${NOW}, 1, 1)
        `)
        await db.run(sql`
          insert into articles (feed_id, dedup_key, url, url_host, published_at, fetched_at, sort_at)
          select id, 'old', ${server.url('/a')}, '127.0.0.1', 0, 1, 0 from feeds
          where feed_url = ${elsewhere.url('/x.xml')}
        `)
        serveNotFound(chromeOnly('<a href="/about">About</a>'))
        const claimId = await pendingClaim(siteId, 'owner')
        expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
          'failed',
        )
        expect(await reasonOf(claimId)).toEqual({
          reason: 'not_site_wide',
          page: server.origin,
          other: server.url(notFoundProbe('tok-123')),
          target: 'profile',
        })
        expect(server.requests.some((r) => r.path === '/a')).toBe(false)
      } finally {
        await elsewhere.stop()
      }
    })

    test("never counts when marked as a commenter's, on every page or not", async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', footer('https://tela.test/@owner', 'external nofollow ugc'))
      serveNotFound(chromeOnly(footerLink('https://tela.test/@owner', 'external nofollow ugc')))
      const claimId = await pendingClaim(siteId, 'owner')
      expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
        'failed',
      )
      expect(await reasonOf(claimId)).toEqual({
        reason: 'link_marked',
        page: server.origin,
        target: 'profile',
        rel: 'nofollow ugc',
      })
    })

    test('a blog that answers a missing address with its home page has no 404 page', async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', footer('https://tela.test/@owner'))
      // A single-page app's fallback: 200 and whatever the home page shows, posts and all.
      serveNotFound(footer('https://tela.test/@owner'), 200)
      const claimId = await pendingClaim(siteId, 'owner')
      expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
        'failed',
      )
      expect(await reasonOf(claimId)).toEqual({
        reason: 'no_not_found_page',
        page: server.origin,
        target: 'profile',
      })
    })

    test('a blog that sends a missing address home has no 404 page either', async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', footer('https://tela.test/@owner'))
      server.set(notFoundProbe('tok-123'), (_req, res) => {
        res.writeHead(301, { location: '/' })
        res.end()
      })
      const claimId = await pendingClaim(siteId, 'owner')
      expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
        'failed',
      )
      expect((await reasonOf(claimId))?.reason).toBe('no_not_found_page')
    })

    test.each([
      ['https', 'https', null],
      ['http', 'https', null],
      ['https', 'http', 'no_not_found_page'],
    ] as const)('a blog on %s whose 404 page comes over %s: %s', async (home, notFound, reason) => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      const homeUrl = server.origin.replace(/^http:/, `${home}:`)
      await db.run(sql`update sites set home_url = ${homeUrl} where id = ${siteId}`)
      serveHtml('/', footer('https://tela.test/@owner'))
      serveNotFound(chromeOnly(footerLink('https://tela.test/@owner')))
      // The fixture speaks plain HTTP: ask it that way, and say which scheme each page came over.
      const over: HttpClient = {
        async get(url, opts) {
          const res = await http.get(url.replace(/^https:/, 'http:'), opts)
          const scheme = new URL(url).pathname === notFoundProbe('tok-123') ? notFound : home
          return { ...res, finalUrl: res.finalUrl.replace(/^http:/, `${scheme}:`) }
        },
      }
      const claimId = await pendingClaim(siteId, 'owner')
      const outcome = await verifyClaimJob(ctx({ http: over }), await claim('site.claim', claimId))
      expect(outcome.status).toBe(reason ? 'failed' : 'verified')
      expect((await reasonOf(claimId))?.reason ?? null).toBe(reason)
    })

    test('a link to another handle says which, so a changed handle is found', async () => {
      await addUser('owner', 'new_name')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml(
        '/',
        '<html><body><a rel="me" href="https://tela.test/@old_name">me</a></body></html>',
      )
      const claimId = await pendingClaim(siteId, 'owner')
      expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
        'failed',
      )
      expect(await reasonOf(claimId)).toEqual({
        reason: 'other_handle',
        page: server.origin,
        found: 'old_name',
        handle: 'new_name',
      })
    })
  })

  describe('by GitHub (ADR 0045)', () => {
    const GITHUB_ID = '4242'
    let asked: string[]
    /** GitHub, answering for one account: its login, and the website its profile names. */
    const github = (website: string | (() => never), login = 'Owner-GH'): GitHub => ({
      async user(id) {
        asked.push(id)
        if (typeof website === 'function') return website()
        return id === GITHUB_ID ? { login, website } : null
      },
    })
    const linkGitHub = (userId: string) =>
      db.run(sql`
        insert into account (id, account_id, provider_id, user_id, created_at, updated_at)
        values (${`gh-${userId}`}, ${GITHUB_ID}, 'github', ${userId}, 1, 1)
      `)
    const githubLink = (rel: string) =>
      `<a href="https://github.com/owner-gh" rel="${rel}">GitHub</a>`
    const linking = (rel: string) => `<html><body><footer>${githubLink(rel)}</footer></body></html>`
    const storedError = async (claimId: number) =>
      (await first<{ error: string }>(db, sql`select error from site_claims where id = ${claimId}`))
        ?.error ?? ''

    beforeEach(() => {
      asked = []
    })

    test('a blog and a GitHub that link each other verify, with nothing added', async () => {
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', linking('noopener'))
      serveNotFound(chromeOnly(githubLink('noopener')))
      const claimId = await pendingClaim(siteId, 'owner')
      // GitHub's website field, typed without a scheme or with www, still names the blog.
      const website = server.url('/').replace(/^http:\/\//, '')
      expect(
        await verifyClaimJob(ctx({ github: github(website) }), await claim('site.claim', claimId)),
      ).toMatchObject({ status: 'verified', method: 'github' })
      expect(asked).toEqual([GITHUB_ID])
    })

    test('a rel="me" link to the GitHub needs no 404 page', async () => {
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', linking('me'))
      const claimId = await pendingClaim(siteId, 'owner')
      expect(
        await verifyClaimJob(
          ctx({ github: github(server.url('/')) }),
          await claim('site.claim', claimId),
        ),
      ).toMatchObject({ status: 'verified', method: 'github' })
      expect(server.requests.some((r) => r.path === notFoundProbe('tok-123'))).toBe(false)
    })

    test('a GitHub a post mentions cannot claim the blog by naming it', async () => {
      // The Daring Fireball shape: the home page shows a post in full that links a developer's
      // GitHub, and that developer's profile names the blog.
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      const mention = `<article>A developer known as ${githubLink('')}</article>`
      serveHtml('/', `<html><body>${mention}</body></html>`)
      serveHtml('/a', `<html><body>${mention}</body></html>`)
      serveNotFound(chromeOnly('<a href="/about">About</a>'))
      const claimId = await pendingClaim(siteId, 'owner')
      expect(
        (
          await verifyClaimJob(
            ctx({ github: github(server.url('/')) }),
            await claim('site.claim', claimId),
          )
        ).status,
      ).toBe('failed')
      expect(await reasonOf(claimId)).toEqual({
        reason: 'not_site_wide',
        page: server.origin,
        other: server.url(notFoundProbe('tok-123')),
        target: 'github',
      })
    })

    test('a GitHub that names another website is told to name this one, and neither is kept', async () => {
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', linking('noopener'))
      serveNotFound(chromeOnly(githubLink('noopener')))
      const claimId = await pendingClaim(siteId, 'owner')
      await verifyClaimJob(
        ctx({ github: github('https://elsewhere.example') }),
        await claim('site.claim', claimId),
      )
      expect(await reasonOf(claimId)).toEqual({ reason: 'github_website' })
      // The stored reason syncs to the device and goes into the nightly export: nothing GitHub
      // said may be in it (ADR 0036).
      const error = (await storedError(claimId)).toLowerCase()
      expect(error).not.toContain('owner-gh')
      expect(error).not.toContain('elsewhere')
    })

    test('a GitHub that names the blog, on a blog that does not link it, says so', async () => {
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', '<html><body>nothing here</body></html>')
      const claimId = await pendingClaim(siteId, 'owner')
      await verifyClaimJob(
        ctx({ github: github(server.url('/')) }),
        await claim('site.claim', claimId),
      )
      expect(await reasonOf(claimId)).toEqual({ reason: 'github_link', page: server.origin })
      expect((await storedError(claimId)).toLowerCase()).not.toContain('owner-gh')
    })

    test('GitHub not answering is the reason only when nothing else came close', async () => {
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', '<html><body>nothing here</body></html>')
      const claimId = await pendingClaim(siteId, 'owner')
      const down = github(() => {
        throw new GitHubUnavailable('GitHub answered HTTP 403')
      })
      await verifyClaimJob(ctx({ github: down }), await claim('site.claim', claimId))
      expect(await reasonOf(claimId)).toEqual({ reason: 'github_unavailable' })
    })

    test('a member who never linked a GitHub is not looked up', async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', linking('me'))
      const claimId = await pendingClaim(siteId, 'owner')
      await verifyClaimJob(
        ctx({ github: github(server.url('/')) }),
        await claim('site.claim', claimId),
      )
      expect(asked).toEqual([])
      expect((await reasonOf(claimId))?.reason).toBe('no_proof')
    })
  })

  describe('vouched for by an operator (ADR 0039)', () => {
    const vouchFor = async (claimId: number) => {
      await addUser('ops', 'operator')
      await db.run(sql`update site_claims set vouched_by = 'ops' where id = ${claimId}`)
    }

    test('verifies with no proof on the page, and still moves feeds the site does not vouch for', async () => {
      await addUser('owner', 'owner')
      const { siteId, feedId } = await siteFor('/feed.xml')
      const squatter = await FixtureServer.start()
      try {
        await db.run(sql`
          insert into feeds (site_id, feed_url, host, served_origin, next_fetch_at, created_at, updated_at)
          values (${siteId}, ${squatter.url('/evil.xml')}, '127.0.0.1', ${squatter.origin}, ${NOW}, 1, 1)
        `)
        // No meta tag, no rel="me": only the feed the home page declares.
        serveHtml(
          '/',
          '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
        )
        const claimId = await pendingClaim(siteId, 'owner')
        await vouchFor(claimId)
        expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toMatchObject({
          status: 'verified',
          method: 'meta',
          vouched: true,
        })
        const site = await first<{ claimed_by: string; declared_feed_urls: string }>(
          db,
          sql`select claimed_by, declared_feed_urls from sites where id = ${siteId}`,
        )
        expect(site?.claimed_by).toBe('owner')
        expect(JSON.parse(site!.declared_feed_urls)).toEqual([server.url('/feed.xml')])
        const onSite = await db.all<{ id: number }>(
          sql`select id from feeds where site_id = ${siteId}`,
        )
        expect(onSite.map((f) => f.id)).toEqual([feedId])
        // The home page was still read: that is where the declared feeds come from.
        expect(server.requests.some((r) => r.path === '/')).toBe(true)
      } finally {
        await squatter.stop()
      }
    })

    test('still fails when the home page cannot be read', async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      server.set('/', (_req, res) => {
        res.writeHead(503)
        res.end()
      })
      const claimId = await pendingClaim(siteId, 'owner')
      await vouchFor(claimId)
      expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toEqual({
        status: 'failed',
        error: JSON.stringify({ reason: 'home_status', page: server.origin, status: 503 }),
      })
    })

    test('never takes a blog another member holds', async () => {
      await addUser('first', 'first_owner')
      await addUser('second', 'second_owner')
      const { siteId } = await siteFor('/feed.xml')
      await db.run(sql`update sites set claimed_by = 'first' where id = ${siteId}`)
      serveHtml('/', '<html></html>')
      const claimId = await pendingClaim(siteId, 'second')
      await vouchFor(claimId)
      expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toEqual({
        status: 'failed',
        error: 'site already claimed by another member',
      })
    })
  })

  test('a blog claimed by someone else while the check read the page is neither taken nor moved', async () => {
    await addUser('first', 'first_owner')
    await addUser('second', 'second_owner')
    const { siteId, feedId } = await siteFor('/feed.xml')
    // A feed from another origin, which a verification would move off the site.
    const squatter = await FixtureServer.start()
    try {
      await db.run(sql`
        insert into feeds (site_id, feed_url, host, served_origin, next_fetch_at, created_at, updated_at)
        values (${siteId}, ${squatter.url('/other.xml')}, '127.0.0.1', ${squatter.origin}, ${NOW}, 1, 1)
      `)
      const claimId = await pendingClaim(siteId, 'second', 'tok-2')
      // The first member's claim is verified while this check is fetching the page.
      server.set('/', async (_req, res) => {
        await db.run(sql`update sites set claimed_by = 'first' where id = ${siteId}`)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<html><head><meta name="${VERIFICATION_META}" content="tok-2"></head></html>`)
      })
      expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toEqual({
        status: 'failed',
        error: 'site already claimed by another member',
      })
      const row = await first<{ status: string; verified_at: number | null }>(
        db,
        sql`select status, verified_at from site_claims where id = ${claimId}`,
      )
      expect(row).toEqual({ status: 'failed', verified_at: null })
      expect(
        (
          await first<{ claimed_by: string }>(
            db,
            sql`select claimed_by from sites where id = ${siteId}`,
          )
        )?.claimed_by,
      ).toBe('first')
      const onSite = await db.all<{ id: number }>(
        sql`select id from feeds where site_id = ${siteId} order by id`,
      )
      expect(onSite.length).toBe(2)
      expect(onSite[0]?.id).toBe(feedId)
    } finally {
      await squatter.stop()
    }
  })

  test('a site another member already claimed is not taken away', async () => {
    await addUser('first', 'first_owner')
    await addUser('second', 'second_owner')
    const { siteId } = await siteFor('/feed.xml')
    await db.run(sql`update sites set claimed_by = 'first' where id = ${siteId}`)
    serveHtml('/', `<html><head><meta name="${VERIFICATION_META}" content="tok-2"></head></html>`)
    const claimId = await pendingClaim(siteId, 'second', 'tok-2')
    expect(await verifyClaimJob(ctx(), await claim('site.claim', claimId))).toEqual({
      status: 'failed',
      error: 'site already claimed by another member',
    })
    const site = await first<{ claimed_by: string }>(
      db,
      sql`select claimed_by from sites where id = ${siteId}`,
    )
    expect(site?.claimed_by).toBe('first')
  })
})

describe('websubSubscribeJob', () => {
  test('asks the hub to push to the web app, and records a hub that refuses', async () => {
    const { feedId } = await siteFor('/feed.xml')
    let form = new URLSearchParams()
    server.set('/hub', async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      form = new URLSearchParams(body)
      res.writeHead(202)
      res.end()
    })
    await db.run(sql`update feeds set hub_url = ${server.url('/hub')} where id = ${feedId}`)
    await db.run(sql`
      insert into websub_subscriptions (feed_id, hub_url, topic_url, secret, updated_at)
      values (${feedId}, ${server.url('/hub')}, ${server.url('/feed.xml')}, 's3cret', ${NOW})
    `)
    expect(await websubSubscribeJob(ctx(), await claim('websub.subscribe', feedId))).toEqual({
      status: 'requested',
    })
    expect(form.get('hub.callback')).toBe(`https://tela.test/api/websub/${feedId}`)
    expect(form.get('hub.secret')).toBe('s3cret')

    server.set('/hub', (_req, res) => {
      res.writeHead(500)
      res.end()
    })
    clock.advance(MIN)
    expect(await websubSubscribeJob(ctx(), await claim('websub.subscribe', feedId))).toMatchObject({
      status: 'failed',
    })
    const row = await first<{ status: string }>(
      db,
      sql`select status from websub_subscriptions where feed_id = ${feedId}`,
    )
    expect(row?.status).toBe('failed')
  })
})

describe('placeholder sites', () => {
  /** Sites with no feed at all: a placeholder nothing filled, which Discover shows as a nameless card. */
  const feedless = () =>
    db.all<{ home_url: string }>(
      sql`select home_url from sites s where not exists (select 1 from feeds f where f.site_id = s.id)`,
    )

  /** A feed whose blog declares a home other than the feed's own origin, as most blogs do. */
  async function filedUnderItsHome() {
    server.text('/feed.xml', rss({ link: 'https://blog.example/', items: [] }))
    return registerFeed(db, {
      feedUrl: server.url('/feed.xml'),
      homeUrl: 'https://blog.example/',
      now: clock.now(),
    })
  }

  test('an OPML import naming a feed Tela has makes no site for that address', async () => {
    const { feedId } = await filedUnderItsHome()
    await addTestUser(db, 'u1')
    const url = new URL(server.url('/feed.xml'))
    const ids = await importFeedUrls(
      db,
      [{ feedUrl: url.toString(), host: url.hostname, origin: url.origin }],
      'u1',
      clock.now(),
    )
    expect(ids).toEqual([feedId])
    expect(await feedless()).toEqual([])
  })

  test('an import still makes the site a new feed is filed under until its first fetch', async () => {
    await addTestUser(db, 'u1')
    const url = new URL(server.url('/new.xml'))
    const [id] = await importFeedUrls(
      db,
      [{ feedUrl: url.toString(), host: url.hostname, origin: url.origin }],
      'u1',
      clock.now(),
    )
    const row = await first<{ home_url: string }>(
      db,
      sql`select s.home_url from feeds f join sites s on s.id = f.site_id where f.id = ${id}`,
    )
    expect(row?.home_url).toBe(url.origin)
  })

  test('registering a known feed under another declared home makes no site for that home', async () => {
    const before = await filedUnderItsHome()
    const again = await registerFeed(db, {
      feedUrl: server.url('/feed.xml'),
      homeUrl: 'https://elsewhere.example/',
      now: clock.now(),
    })
    expect(again).toEqual({ ...before, created: false })
    expect(await feedless()).toEqual([])
  })
})
