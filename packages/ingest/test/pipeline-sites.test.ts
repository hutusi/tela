import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, first, type Lease, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
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

  test('no proof fails with a reason the member can act on', async () => {
    await addUser('owner', 'owner')
    const { siteId } = await siteFor('/feed.xml')
    serveHtml('/', '<html><body>nothing here</body></html>')
    const claimId = await pendingClaim(siteId, 'owner')
    const outcome = await verifyClaimJob(ctx(), await claim('site.claim', claimId))
    expect(outcome.status).toBe('failed')
    const row = await first<{ status: string; error: string }>(
      db,
      sql`select status, error from site_claims where id = ${claimId}`,
    )
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain(VERIFICATION_META)
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
