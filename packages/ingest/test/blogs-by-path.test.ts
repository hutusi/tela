/**
 * Blogs by path (ADR 0069): on a host many writers share, each writer's blog is the first segment
 * of the path, and a section of a site the rules name is a blog of its own. The fixture server is
 * one origin, so these tests name its host and paths in the rules they pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  bumpSeq,
  claimDue,
  fileFeedUnder,
  first,
  isFenceRefusal,
  type Lease,
  type TelaDb,
} from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { type BlogRules, claimReason } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createHttpClient } from '../src/http'
import {
  createIngest,
  dueAssets,
  type IngestContext,
  ingestFeed,
  namesSite,
  notFoundProbe,
  registerFeed,
  VERIFICATION_META,
  verifyClaimJob,
} from '../src/pipeline'
import { FixtureServer, longHtml, rss } from './fixture-server'

const NOW = Date.UTC(2026, 9, 30, 10)
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})

let server: FixtureServer
let db: TelaDb
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
  clock = fakeClock(NOW)
})

/** The fixture's host as one many writers share, as world.hey.com is. */
const shared = (): BlogRules => ({ sharedHosts: ['127.0.0.1'], pathBlogs: [] })
/** The fixture's /research as a section that is a blog of its own, as Anthropic's is. */
const sections = (): BlogRules => ({ sharedHosts: [], pathBlogs: [server.url('/research')] })

const ctx = (blogRules: BlogRules): IngestContext => ({
  db,
  blobs: memoryBlobs(),
  http,
  clock,
  random: () => 0.5,
  blogRules,
})

async function fetchFeed(rules: BlogRules, feedId: number) {
  await claimDue(db, {
    kind: 'feed.fetch',
    owner: 'w1',
    now: clock.now(),
    ttlMs: 120_000,
    limit: 1,
    due: sql`select ${feedId} as key, null as host, 0 as ord`,
  })
  const lease: Lease = { kind: 'feed.fetch', key: String(feedId), owner: 'w1' }
  return ingestFeed(ctx(rules), lease)
}

/** A writer's feed at `/<name>/rss`, declaring `/<name>` as its home. */
function writer(name: string) {
  server.text(
    `/${name}/rss`,
    rss({
      title: name,
      link: server.url(`/${name}`),
      items: [{ guid: name, link: server.url(`/${name}/a`), title: 'A', content: longHtml(3) }],
    }),
  )
  return server.url(`/${name}/rss`)
}

const homes = async () =>
  (await db.all<{ home_url: string }>(sql`select home_url from sites order by home_url`)).map((s) =>
    s.home_url.replace(server.origin, ''),
  )

describe('filing a feed by its site key', () => {
  test('two writers on a shared host are two blogs', async () => {
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), rules: shared(), now: NOW })
    const jason = await registerFeed(db, { feedUrl: writer('jason'), rules: shared(), now: NOW })
    expect(dhh.siteId).not.toBe(jason.siteId)
    expect(await homes()).toEqual(['/dhh', '/jason'])
  })

  test('a feed whose home is a named section is filed under it, any other under the origin', async () => {
    const elsewhere = 'https://feeds.example/lab.xml'
    await registerFeed(db, {
      feedUrl: elsewhere,
      homeUrl: server.url('/research/'),
      rules: sections(),
      now: NOW,
    })
    await registerFeed(db, {
      feedUrl: 'https://feeds.example/news.xml',
      homeUrl: server.url('/news'),
      rules: sections(),
      now: NOW,
    })
    expect(await homes()).toEqual(['', '/research'])
  })

  test('a feed filed under the bare host before moves to its writer at its next fetch', async () => {
    // Filed as Tela did before blogs by path: both writers on one blog, the host.
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), now: NOW })
    const jason = await registerFeed(db, { feedUrl: writer('jason'), now: NOW })
    expect(dhh.siteId).toBe(jason.siteId)

    // The first splits onto a blog of its own; the second, left alone there, renames the host's.
    expect(await fetchFeed(shared(), dhh.feedId)).toMatchObject({ siteHome: 'split' })
    expect(await fetchFeed(shared(), jason.feedId)).toMatchObject({ siteHome: 'renamed' })
    expect(await homes()).toEqual(['/dhh', '/jason'])
    const served = await db.all<{ served_origin: string }>(
      sql`select served_origin from feeds order by id`,
    )
    expect(served.map((f) => f.served_origin.replace(server.origin, ''))).toEqual([
      '/dhh',
      '/jason',
    ])
  })

  test("a claim on the bare host keeps what its claimant added, and no other writer's feed", async () => {
    await addTestUser(db, 'u1')
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), actorId: 'u1', now: NOW })
    const jason = await registerFeed(db, { feedUrl: writer('jason'), now: NOW })
    await db.run(sql`update sites set claimed_by = 'u1' where id = ${dhh.siteId}`)
    // What the claimant added stays on the blog they claimed.
    expect(await fetchFeed(shared(), dhh.feedId)).toMatchObject({ siteHome: 'blocked' })
    // Served from another writer's path, a feed is not the claimed blog's own: it moves there.
    expect(await fetchFeed(shared(), jason.feedId)).toMatchObject({ siteHome: 'detached' })
    expect(await homes()).toEqual(['', '/jason'])
  })

  test('a blog split off one an operator hid keeps every no it said', async () => {
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), now: NOW })
    const jason = await registerFeed(db, { feedUrl: writer('jason'), now: NOW })
    await db.run(sql`update sites set listing = 'rejected', review = 'dismissed', reviewed_at = 5,
      feed_only = 1, translation_opt_out = 1 where id = ${dhh.siteId}`)
    expect(await fetchFeed(shared(), dhh.feedId)).toMatchObject({ siteHome: 'split' })
    expect(await fetchFeed(shared(), jason.feedId)).toMatchObject({ siteHome: 'renamed' })
    const after = await db.all<Record<string, unknown>>(sql`
      select home_url, listing, review, reviewed_at, feed_only, translation_opt_out
      from sites order by home_url`)
    expect(
      after.map((s) => ({ ...s, home_url: String(s.home_url).replace(server.origin, '') })),
    ).toEqual(
      ['/dhh', '/jason'].map((home_url) => ({
        home_url,
        listing: 'rejected',
        review: 'dismissed',
        reviewed_at: 5,
        feed_only: 1,
        translation_opt_out: 1,
      })),
    )
  })

  test("a blog a fetched feed moves to has the feed's name and its posts' language at once", async () => {
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), now: NOW })
    await registerFeed(db, { feedUrl: writer('jason'), now: NOW })
    await fetchFeed({ sharedHosts: [], pathBlogs: [] }, dhh.feedId)
    // Moved by anything but a fetch whose body changed (curate, a claim), no fetch fills it after.
    const filed = await fileFeedUnder(
      db,
      { id: dhh.feedId, siteId: dhh.siteId },
      { homeUrl: server.origin, claimedBy: null },
      server.url('/dhh'),
      NOW,
    )
    expect(filed.outcome).toBe('split')
    await db.batch([bumpSeq(db), ...filed.statements] as never)
    const moved = await first<Record<string, unknown>>(
      db,
      sql`select title, description, primary_lang from sites where home_url = ${server.url('/dhh')}`,
    )
    expect(moved).toEqual({ title: 'dhh', description: 'A test blog', primary_lang: 'en' })
  })

  test('a move decided before a claim was verified is refused, onto the blog or off it', async () => {
    await addTestUser(db, 'u1')
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), now: NOW })
    await registerFeed(db, { feedUrl: writer('jason'), now: NOW })
    const decide = () =>
      fileFeedUnder(
        db,
        { id: dhh.feedId, siteId: dhh.siteId },
        { homeUrl: server.origin, claimedBy: null },
        server.url('/dhh'),
        NOW,
      )
    const run = (filed: Awaited<ReturnType<typeof decide>>) =>
      db.batch([bumpSeq(db), ...filed.statements] as never).then(
        () => null,
        (err: unknown) => err,
      )

    const onto = await decide()
    await db.run(sql`insert into sites (home_url, claimed_by, created_at, updated_at)
      values (${server.url('/dhh')}, 'u1', 1, 1)`)
    expect(isFenceRefusal(await run(onto))).toBe(true)
    await db.run(sql`delete from sites where home_url = ${server.url('/dhh')}`)

    const off = await decide()
    await db.run(sql`update sites set claimed_by = 'u1' where id = ${dhh.siteId}`)
    expect(isFenceRefusal(await run(off))).toBe(true)
    expect(await homes()).toEqual([''])
    expect(
      await first<{ site_id: number }>(db, sql`select site_id from feeds where id = ${dhh.feedId}`),
    ).toEqual({
      site_id: dhh.siteId,
    })
  })

  test('a rename decided before another feed joined the blog is refused', async () => {
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), now: NOW })
    const filed = await fileFeedUnder(
      db,
      { id: dhh.feedId, siteId: dhh.siteId },
      { homeUrl: server.origin, claimedBy: null },
      server.url('/dhh'),
      NOW,
    )
    expect(filed.outcome).toBe('renamed')
    // Renamed now, the host's blog would take this writer's feed to the first writer's address.
    await registerFeed(db, { feedUrl: writer('jason'), now: NOW })
    const err = await db.batch([bumpSeq(db), ...filed.statements] as never).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isFenceRefusal(err)).toBe(true)
    expect(await homes()).toEqual([''])
  })

  test('a blog by path is leased by its host, as its feeds are', async () => {
    await registerFeed(db, { feedUrl: writer('dhh'), rules: shared(), now: NOW })
    const due = await db.all<{ host: string }>(dueAssets())
    expect(due.map((d) => d.host)).toEqual([new URL(server.origin).host])
  })
})

describe('claiming a blog by path', () => {
  const TOKEN = 'tok-123'

  async function owner() {
    await addTestUser(db, 'owner')
    await db.run(sql`insert into profiles (user_id, handle, created_at, updated_at)
      values ('owner', 'owner', 1, 1)`)
  }

  function serveHtml(path: string, html: string, status = 200) {
    server.set(path, (_req, res) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  }

  /** The member's claim on `siteId`, under a lease the check holds. */
  async function verify(siteId: number) {
    await db.run(sql`insert into site_claims (site_id, user_id, method, token, created_at)
      values (${siteId}, 'owner', 'meta', ${TOKEN}, ${NOW})
      on conflict (site_id, user_id) do update set status = 'pending'`)
    await db.run(sql`delete from leases`)
    const row = await first<{ id: number }>(db, sql`select max(id) as id from site_claims`)
    const id = row?.id ?? 0
    await claimDue(db, {
      kind: 'site.claim',
      owner: 'w1',
      now: clock.now(),
      ttlMs: 120_000,
      limit: 1,
      due: sql`select ${id} as key, null as host, 0 as ord`,
    })
    const lease: Lease = { kind: 'site.claim', key: String(id), owner: 'w1' }
    return verifyClaimJob({ ...ctx(shared()), publicUrl: 'https://tela.test' }, lease)
  }

  test("on a shared host, a plain link the host's 404 page shows too proves nothing", async () => {
    await owner()
    const { siteId } = await registerFeed(db, { feedUrl: writer('dhh'), rules: shared(), now: NOW })
    const footer = '<footer><a href="https://tela.test/@owner">Tela</a></footer>'
    serveHtml('/dhh', `<html><body><main>a post</main>${footer}</body></html>`)
    // The host's page for a missing address shows the host's footer, which every writer shares.
    serveHtml(notFoundProbe(TOKEN), `<html><body>${footer}</body></html>`, 404)
    expect(await verify(siteId)).toMatchObject({ status: 'failed' })
    const failed = await first<{ error: string }>(
      db,
      sql`select error from site_claims order by id desc limit 1`,
    )
    expect(claimReason(failed?.error ?? null)).toMatchObject({ reason: 'no_not_found_page' })
    expect(server.requests.some((r) => r.path === notFoundProbe(TOKEN))).toBe(false)

    // rel="me" on the writer's own page is theirs alone.
    serveHtml(
      '/dhh',
      '<html><body><a rel="me" href="https://tela.test/@owner">me</a></body></html>',
    )
    expect(await verify(siteId)).toMatchObject({ status: 'verified', method: 'rel_me' })
  })

  test("verifying moves another writer's feed to that writer's blog, never to the host", async () => {
    await owner()
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), rules: shared(), now: NOW })
    // Filed under dhh's blog while it was unclaimed, served from jason's path.
    await db.run(sql`insert into feeds (site_id, feed_url, host, served_origin, next_fetch_at,
        created_at, updated_at)
      values (${dhh.siteId}, ${server.url('/jason/rss')}, '127.0.0.1', ${server.url('/jason')},
        ${NOW}, 1, 1)`)
    serveHtml(
      '/dhh',
      `<html><head><meta name="${VERIFICATION_META}" content="${TOKEN}"></head></html>`,
    )
    expect(await verify(dhh.siteId)).toMatchObject({ status: 'verified', method: 'meta' })
    expect(await homes()).toEqual(['/dhh', '/jason'])
  })

  test('a claim started at a writer’s address files their blog, not the host', async () => {
    await owner()
    writer('dhh')
    serveHtml(
      '/dhh',
      `<html><head><link rel="alternate" type="application/rss+xml" href="/dhh/rss"></head></html>`,
    )
    const ingest = createIngest({ db, http, now: () => clock.now(), rules: shared() })
    const started = await ingest.startClaim({ url: server.url('/dhh'), actorId: 'owner' })
    expect(started).toMatchObject({ feedId: expect.any(Number) })
    expect(await homes()).toEqual(['/dhh'])
  })

  test("a GitHub profile names a writer's blog, not another's on the same host", () => {
    expect(namesSite('world.hey.com/dhh', 'https://world.hey.com/dhh')).toBe(true)
    expect(namesSite('https://world.hey.com/DHH/', 'https://world.hey.com/dhh')).toBe(true)
    expect(namesSite('world.hey.com/jason', 'https://world.hey.com/dhh')).toBe(false)
    expect(namesSite('world.hey.com', 'https://world.hey.com/dhh')).toBe(false)
    // An ordinary blog, by any path on it, as before.
    expect(namesSite('www.hutusi.com/about', 'https://hutusi.com')).toBe(true)
    expect(namesSite('www.anthropic.com', 'https://www.anthropic.com/research')).toBe(false)
  })
})

describe('Add on a blog by path', () => {
  const both = (): BlogRules => ({
    sharedHosts: [],
    pathBlogs: [server.url('/research'), server.url('/engineering')],
  })
  const page = (path: string) =>
    server.set(path, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body>No feed declared here.</body></html>')
    })

  /** Two listed sections of the fixture's site, each read through a feed kept elsewhere. */
  async function lab() {
    for (const [section, feedUrl] of [
      ['/research', 'https://feeds.example/research.xml'],
      ['/engineering', 'https://feeds.example/engineering.xml'],
    ] as const) {
      await registerFeed(db, { feedUrl, homeUrl: server.url(section), rules: both(), now: NOW })
    }
    await db.run(sql`update sites set listing = 'listed'`)
    page('/')
    page('/research')
    page('/engineering')
    return createIngest({ db, http, now: () => clock.now(), rules: both() })
  }

  test("a section's address offers its own feed, and the site's address every section's", async () => {
    const ingest = await lab()
    const urls = async (url: string) => {
      const found = await ingest.discover({ url })
      return 'feeds' in found ? found.feeds.map((f) => f.url) : found
    }
    expect(await urls(server.url('/engineering'))).toEqual([
      'https://feeds.example/engineering.xml',
    ])
    expect(await urls(server.url('/research/proteins'))).toEqual([
      'https://feeds.example/research.xml',
    ])
    expect(await urls(server.url('/'))).toEqual([
      'https://feeds.example/research.xml',
      'https://feeds.example/engineering.xml',
    ])
  })

  test("a writer's address on a shared host never finds the host's own feed", async () => {
    server.text('/feed', rss({ title: 'The host', items: [{ guid: 'h', title: 'H' }] }))
    page('/dhh')
    const ingest = createIngest({ db, http, now: () => clock.now(), rules: shared() })
    expect(await ingest.discover({ url: server.url('/dhh/a-post') })).toEqual({ feeds: [] })
    expect(server.requests.some((r) => r.path === '/feed')).toBe(false)
    expect(server.requests.some((r) => r.path === '/dhh/feed')).toBe(true)
  })
})
