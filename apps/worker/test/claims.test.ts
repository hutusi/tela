import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { feeds, siteClaims, sites } from '@tela/db'
import { getOrCreateClaim } from '@tela/db/queries'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { createHttpClient, type HttpClient } from '@tela/ingest'
import { eq, sql } from 'drizzle-orm'
import { findProof, resolveDeclaredFeeds, verifyClaim } from '../src/claims/verify'
import { FixtureServer } from './fixture-server'

let t: TestDb
let server: FixtureServer
const userA = '11111111-1111-4111-8111-111111111111'
const userB = '22222222-2222-4222-8222-222222222222'
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 500,
})

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
  await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
})

async function siteWithClaim() {
  const [site] = await t.db
    .insert(sites)
    .values({ homeUrl: server.origin, title: 'Fixture' })
    .returning()
  await t.db.insert(feeds).values({ siteId: site!.id, feedUrl: `${server.origin}/feed.xml` })
  const claim = await getOrCreateClaim(t.db, site!.id, userA)
  return { site: site!, claim }
}

describe('findProof', () => {
  test('accepts the meta tag or a rel=me link, and nothing else', () => {
    expect(findProof('<meta name="tela-site-verification" content="abc">', 'abc', [])).toEqual({
      method: 'meta',
    })
    expect(findProof('<meta name="Tela-Site-Verification" content=" abc ">', 'abc', [])).toEqual({
      method: 'meta',
    })
    expect(
      findProof('<link rel="me" href="https://tela.app/@ada/">', 'x', ['https://tela.app/@ada']),
    ).toEqual({ method: 'rel_me' })
    expect(
      findProof('<a rel="me nofollow" href="https://tela.app/@ada">me</a>', 'x', [
        'https://tela.app/@ada',
      ]),
    ).toEqual({ method: 'rel_me' })
    expect(findProof('<meta name="tela-site-verification" content="wrong">', 'abc', [])).toBeNull()
    expect(
      findProof('<a href="https://tela.app/@ada">no rel</a>', 'x', ['https://tela.app/@ada']),
    ).toBeNull()
  })
})

describe('verifyClaim', () => {
  test('verifies a meta tag, claims the site, and lists it', async () => {
    const { site, claim } = await siteWithClaim()
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        `<html><head><meta name="tela-site-verification" content="${claim.token}"></head><body>hi</body></html>`,
      )
    })
    expect(await verifyClaim({ db: t.db, http, publicUrl: 'https://tela.test' }, claim.id)).toEqual(
      { status: 'verified', method: 'meta' },
    )
    const [updated] = await t.db.select().from(sites).where(eq(sites.id, site.id))
    expect(updated?.claimedBy).toBe(userA)
    expect(updated?.listing).toBe('listed')
    const [row] = await t.db.select().from(siteClaims).where(eq(siteClaims.id, claim.id))
    expect(row?.status).toBe('verified')
    expect(row?.verifiedAt).not.toBeNull()
  })

  test('verifies a rel=me link to the profile handle', async () => {
    const { claim } = await siteWithClaim()
    const handleRows = await t.db.execute<{ handle: string }>(
      sql`select handle from profiles where id = ${userA}`,
    )
    const handle = handleRows[0]?.handle as string
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><body><a rel="me" href="https://tela.test/@${handle}">Tela</a></body></html>`)
    })
    expect(
      await verifyClaim({ db: t.db, http, publicUrl: 'https://tela.test/' }, claim.id),
    ).toEqual({ status: 'verified', method: 'rel_me' })
  })

  test('fails with a clear error when the proof is missing or the page is down', async () => {
    const { claim } = await siteWithClaim()
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>nothing here</body></html>')
    })
    const missing = await verifyClaim({ db: t.db, http, publicUrl: 'https://tela.test' }, claim.id)
    expect(missing).toMatchObject({ status: 'failed' })
    expect((await t.db.select().from(siteClaims))[0]?.error).toMatch(/tela-site-verification/)

    server.text('/', 'gone', { status: 503 })
    const down = await verifyClaim({ db: t.db, http, publicUrl: 'https://tela.test' }, claim.id)
    expect(down).toMatchObject({ status: 'failed' })
    expect(down.status === 'failed' ? down.error : '').toMatch(/503/)
  })

  test('verification records the feeds the home page declares and evicts squatters', async () => {
    const { site, claim } = await siteWithClaim()
    // While the site was unclaimed, a feed served from elsewhere joined it by declaring this
    // home; the owner's own hosted feed is declared on the page.
    const [squatter] = await t.db
      .insert(feeds)
      .values({
        siteId: site.id,
        feedUrl: 'https://attacker.example/feed.xml',
        servedOrigin: 'https://attacker.example',
      })
      .returning({ id: feeds.id })
    const [hosted] = await t.db
      .insert(feeds)
      .values({
        siteId: site.id,
        feedUrl: 'https://feeds.example/mine',
        servedOrigin: 'https://feeds.example',
      })
      .returning({ id: feeds.id })
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        `<html><head><meta name="tela-site-verification" content="${claim.token}">
         <link rel="alternate" type="application/rss+xml" href="https://feeds.example/mine"></head>
         <body>hi</body></html>`,
      )
    })
    expect(await verifyClaim({ db: t.db, http, publicUrl: 'https://tela.test' }, claim.id)).toEqual(
      { status: 'verified', method: 'meta' },
    )
    const [updated] = await t.db.select().from(sites).where(eq(sites.id, site.id))
    expect(updated?.declaredFeedUrls).toEqual(['https://feeds.example/mine'])
    const [evicted] = await t.db.select().from(feeds).where(eq(feeds.id, squatter!.id))
    expect(evicted?.siteId).not.toBe(site.id)
    const [evictedSite] = await t.db
      .select()
      .from(sites)
      .where(eq(sites.id, evicted?.siteId as number))
    expect(evictedSite?.homeUrl).toBe('https://attacker.example')
    const remaining = await t.db
      .select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.siteId, site.id))
    expect(remaining).toHaveLength(2)
    expect(remaining.map((r) => r.id)).toContain(hosted!.id)
  })

  test('a declared feed that redirects elsewhere vouches for the feed under its final URL', async () => {
    const { site, claim } = await siteWithClaim()
    const hosted = await FixtureServer.start()
    try {
      // The page declares /declared.xml on its own origin, which redirects to the hosted feed;
      // discovery stored the feed under its final URL, and a reader (not the owner) added it.
      server.redirect('/declared.xml', hosted.url('/feed.xml'), 301)
      hosted.text(
        '/feed.xml',
        '<rss version="2.0"><channel><title>Hosted</title></channel></rss>',
        {
          headers: { 'content-type': 'application/rss+xml' },
        },
      )
      const [feed] = await t.db
        .insert(feeds)
        .values({ siteId: site.id, feedUrl: hosted.url('/feed.xml'), servedOrigin: hosted.origin })
        .returning({ id: feeds.id })
      server.set('/', (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(
          `<html><head><meta name="tela-site-verification" content="${claim.token}">
           <link rel="alternate" type="application/rss+xml" href="/declared.xml"></head>
           <body>hi</body></html>`,
        )
      })
      expect(
        await verifyClaim({ db: t.db, http, publicUrl: 'https://tela.test' }, claim.id),
      ).toEqual({ status: 'verified', method: 'meta' })
      const [updated] = await t.db.select().from(sites).where(eq(sites.id, site.id))
      expect(updated?.declaredFeedUrls).toEqual([
        server.url('/declared.xml'),
        hosted.url('/feed.xml'),
      ])
      const [kept] = await t.db.select().from(feeds).where(eq(feeds.id, feed!.id))
      expect(kept?.siteId).toBe(site.id)
    } finally {
      await hosted.stop()
    }
  })

  test('declared feeds are kept in page order up to the cap, and each kept one is followed to its alias', async () => {
    const { site, claim } = await siteWithClaim()
    const rss = '<rss version="2.0"><channel><title>d</title></channel></rss>'
    const headers = { 'content-type': 'application/rss+xml' }
    const links = Array.from({ length: 25 }, (_, i) => `/d${i + 1}.xml`)
    for (const path of links) server.text(path, rss, { headers })
    // The sixth declaration is a hosted feed behind a redirect: its alias must be learned too.
    server.redirect('/d6.xml', '/hosted6.xml', 302)
    server.text('/hosted6.xml', rss, { headers })
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        `<html><head><meta name="tela-site-verification" content="${claim.token}">
         ${links.map((l) => `<link rel="alternate" type="application/rss+xml" href="${l}">`).join('')}
         </head><body>hi</body></html>`,
      )
    })
    expect(await verifyClaim({ db: t.db, http, publicUrl: 'https://tela.test' }, claim.id)).toEqual(
      { status: 'verified', method: 'meta' },
    )
    const [updated] = await t.db.select().from(sites).where(eq(sites.id, site.id))
    const kept = links.slice(0, 20)
    expect(updated?.declaredFeedUrls).toEqual([
      ...kept.map((l) => server.url(l)),
      server.url('/hosted6.xml'),
    ])
    expect(links.filter((l) => server.requestsFor(l).length > 0)).toEqual(kept)
  })

  test('alias lookups stop at the time budget; the declarations themselves are all kept', async () => {
    const paths = ['/b1.xml', '/b2.xml', '/b3.xml', '/b4.xml', '/b5.xml']
    for (const path of paths) server.text(path, '<rss/>')
    const urls = paths.map((p) => server.url(p))
    let clock = 0
    // Every lookup costs 40 s of the 90 s budget: the third gets what is left, the fourth none.
    const slow: Pick<HttpClient, 'get'> = {
      get: async (url, opts) => {
        const res = await http.get(url, opts)
        clock += 40_000
        return res
      },
    }
    expect(await resolveDeclaredFeeds(slow, urls, () => clock)).toEqual(urls)
    expect(paths.filter((p) => server.requestsFor(p).length > 0)).toEqual(paths.slice(0, 3))
  })

  test('a second member whose rel=me link is also on the page cannot take over a claimed site', async () => {
    const { site, claim } = await siteWithClaim()
    await t.db.execute(sql`insert into auth.users (id, email) values (${userB}, 'b@x.test')`)
    const other = await getOrCreateClaim(t.db, site.id, userB)
    const handles = await t.db.execute<{ handle: string }>(sql`select handle from profiles`)
    const links = handles
      .map((h) => `<a rel="me" href="https://tela.test/@${h.handle}">${h.handle}</a>`)
      .join('')
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><body>${links}</body></html>`)
    })
    const deps = { db: t.db, http, publicUrl: 'https://tela.test' }
    expect(await verifyClaim(deps, claim.id)).toEqual({ status: 'verified', method: 'rel_me' })
    expect(await verifyClaim(deps, other.id)).toEqual({
      status: 'failed',
      error: 'site already claimed by another member',
    })
    const [updated] = await t.db.select().from(sites).where(eq(sites.id, site.id))
    expect(updated?.claimedBy).toBe(userA)
    const [row] = await t.db.select().from(siteClaims).where(eq(siteClaims.id, other.id))
    expect(row?.status).toBe('failed')
  })
})
