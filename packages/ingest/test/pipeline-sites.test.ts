import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, first, type Lease, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { claimReason } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { type GitHub, GitHubUnavailable } from '../src/github'
import { createHttpClient } from '../src/http'
import {
  dueAssets,
  dueClaims,
  type IngestContext,
  ingestFeed,
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
    })
    expect(assets.size).toBe(0)
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

  describe('a link without rel="me" (ADR 0045)', () => {
    const footer = (href: string, rel = 'noopener noreferrer') =>
      `<html><body><main>a post</main><footer><a href="${href}" rel="${rel}">Tela</a></footer></body></html>`

    test("counts when an older post carries it too: it is the blog's own", async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', footer('https://tela.test/@owner'))
      serveHtml('/a', footer('https://www.tela.test/@owner/'))
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

    test('does not count on the home page alone, and says where it was missing', async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      // A post the home page shows in full mentions the profile; the post's own page has the
      // site's chrome and not that post.
      serveHtml(
        '/',
        '<html><body><article><a href="https://tela.test/@owner">x</a></article></body></html>',
      )
      serveHtml('/a', '<html><body><article>another post</article></body></html>')
      const claimId = await pendingClaim(siteId, 'owner')
      expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
        'failed',
      )
      expect(await reasonOf(claimId)).toEqual({
        reason: 'not_site_wide',
        page: server.origin,
        other: server.url('/a'),
        target: 'profile',
      })
    })

    test("never counts when marked as a commenter's, on every page or not", async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', footer('https://tela.test/@owner', 'external nofollow ugc'))
      serveHtml('/a', footer('https://tela.test/@owner', 'external nofollow ugc'))
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

    test('waits for a post to compare with when the blog has none yet', async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      await db.run(sql`delete from articles`)
      serveHtml('/', footer('https://tela.test/@owner'))
      const claimId = await pendingClaim(siteId, 'owner')
      expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
        'failed',
      )
      expect(await reasonOf(claimId)).toEqual({
        reason: 'no_second_page',
        page: server.origin,
        target: 'profile',
      })
    })

    test('a post that is gone and sends readers home is not a second page', async () => {
      await addUser('owner', 'owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', footer('https://tela.test/@owner'))
      server.set('/a', (_req, res) => {
        res.writeHead(301, { location: '/' })
        res.end()
      })
      const claimId = await pendingClaim(siteId, 'owner')
      expect((await verifyClaimJob(ctx(), await claim('site.claim', claimId))).status).toBe(
        'failed',
      )
      expect((await reasonOf(claimId))?.reason).toBe('no_second_page')
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
    const linking = (rel: string) =>
      `<html><body><footer><a href="https://github.com/owner-gh" rel="${rel}">GitHub</a></footer></body></html>`

    beforeEach(() => {
      asked = []
    })

    test('a blog and a GitHub that link each other verify, with nothing added', async () => {
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', linking('noopener'))
      serveHtml('/a', linking('noopener'))
      const claimId = await pendingClaim(siteId, 'owner')
      // GitHub's website field, typed without a scheme or with www, still names the blog.
      const website = server.url('/').replace(/^http:\/\//, '')
      expect(
        await verifyClaimJob(ctx({ github: github(website) }), await claim('site.claim', claimId)),
      ).toMatchObject({ status: 'verified', method: 'github' })
      expect(asked).toEqual([GITHUB_ID])
    })

    test('a rel="me" link to the GitHub needs no second page', async () => {
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      await db.run(sql`delete from articles`)
      serveHtml('/', linking('me'))
      const claimId = await pendingClaim(siteId, 'owner')
      expect(
        await verifyClaimJob(
          ctx({ github: github(server.url('/')) }),
          await claim('site.claim', claimId),
        ),
      ).toMatchObject({ status: 'verified', method: 'github' })
    })

    test('a GitHub a post mentions cannot claim the blog by naming it', async () => {
      // The Daring Fireball shape: the home page shows a post in full that links a developer's
      // GitHub, and that developer's profile names the blog.
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml(
        '/',
        '<html><body><article>A developer known as <a href="https://github.com/owner-gh">Owner</a></article></body></html>',
      )
      serveHtml('/a', '<html><body><article>another post</article></body></html>')
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
        other: server.url('/a'),
        target: 'github',
      })
    })

    test('a GitHub that names another website is told to name this one', async () => {
      await addUser('owner', 'owner')
      await linkGitHub('owner')
      const { siteId } = await siteFor('/feed.xml')
      serveHtml('/', linking('noopener'))
      serveHtml('/a', linking('noopener'))
      const claimId = await pendingClaim(siteId, 'owner')
      await verifyClaimJob(
        ctx({ github: github('https://elsewhere.example') }),
        await claim('site.claim', claimId),
      )
      expect(await reasonOf(claimId)).toEqual({
        reason: 'github_website',
        login: 'Owner-GH',
        website: 'https://elsewhere.example',
      })
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
      expect(await reasonOf(claimId)).toEqual({
        reason: 'github_link',
        page: server.origin,
        login: 'Owner-GH',
      })
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
        error: 'home page returned HTTP 503',
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
