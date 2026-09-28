import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { first } from '@tela/data'
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
    rss({ title: 'Mine', link: server.url('/'), items: [{ guid: 'a', title: 'A' }] }),
  )
  server.set('/', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<html><head><link rel="alternate" type="application/rss+xml" href="${server.url('/feed.xml')}"></head></html>`,
    )
  })
})

type Standing = {
  siteId: number
  status: string
  proofs?: { meta: string; relMe: string }
}
const start = async (cookie = reader.cookie) =>
  (await (
    await api.request('/api/v1/claims', { body: { url: server.url('/') }, cookie })
  ).json()) as Standing

describe('claiming a blog', () => {
  test('starting shows the proofs, and records nothing yet', async () => {
    const standing = await start()
    expect(standing.status).toBe('unverified')
    expect(standing.proofs?.meta).toMatch(
      /^<meta name="tela-site-verification" content="[0-9a-f]{24}">$/,
    )
    expect(standing.proofs?.relMe).toMatch(/href="http:\/\/tela\.test\/@u_[0-9a-f]{10}"/)
    expect(await first(api.db, sql`select 1 as x from site_claims`)).toBeUndefined()
  })

  test('the token is the same every time for a member, and differs between members', async () => {
    const mine = await start()
    expect((await start()).proofs?.meta).toBe(mine.proofs?.meta)
    const other = await signedIn(api, 'other@x.test')
    expect((await start(other.cookie)).proofs?.meta).not.toBe(mine.proofs?.meta)
  })

  test('asking for the check makes a pending claim and sends it to be verified', async () => {
    const { siteId } = await start()
    const res = await api.request(`/api/v1/claims/${siteId}/verify`, {
      body: {},
      cookie: reader.cookie,
    })
    expect(((await res.json()) as Standing).status).toBe('pending')
    const claim = await first<{ id: number; status: string; token: string; seq: number }>(
      api.db,
      sql`select id, status, token, seq from site_claims`,
    )
    expect(claim).toMatchObject({ status: 'pending' })
    expect(claim?.seq).toBeGreaterThan(0)
    expect(api.jobs.sent).toMatchObject([
      { queue: 'misc', body: { kind: 'site.claim', key: String(claim?.id) } },
    ])
  })

  test("someone else's blog cannot be claimed", async () => {
    const { siteId } = await start()
    const owner = await signedIn(api, 'owner@x.test')
    await api.db.run(sql`update sites set claimed_by = ${owner.userId} where id = ${siteId}`)
    expect((await start()).status).toBe('claimed_by_other')
    const verify = await api.request(`/api/v1/claims/${siteId}/verify`, {
      body: {},
      cookie: reader.cookie,
    })
    expect(((await verify.json()) as Standing).status).toBe('claimed_by_other')
    expect(await first(api.db, sql`select 1 as x from site_claims`)).toBeUndefined()
  })

  test('a URL with no feed behind it cannot be claimed', async () => {
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html></html>')
    })
    server.set('/feed.xml', (_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const res = await api.request('/api/v1/claims', {
      body: { url: server.url('/') },
      cookie: reader.cookie,
    })
    expect(res.status).toBe(422)
  })
})
