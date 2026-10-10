import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { first } from '@tela/data'
import type { ClaimReason } from '@tela/shared'
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
  error?: string | null
  reason?: ClaimReason | null
  github?: boolean
  proofs?: { meta: string; relMe: string }
}
const start = async (as = reader) =>
  (await (
    await api.request('/api/v1/claims', { body: { url: server.url('/') }, as })
  ).json()) as Standing

describe('claiming a blog', () => {
  test('starting shows the proofs, and records nothing yet', async () => {
    const standing = await start()
    expect(standing.status).toBe('unverified')
    expect(standing.proofs?.meta).toMatch(
      /^<meta name="tela-site-verification" content="[0-9a-f]{24}">$/,
    )
    // A link for the header or footer, where a blog keeps its links, not a tag for <head>.
    expect(standing.proofs?.relMe).toMatch(
      /^<a rel="me" href="http:\/\/tela\.test\/@u_[0-9a-f]{10}">Tela<\/a>$/,
    )
    expect(standing.github).toBe(false)
    expect(await first(api.db, sql`select 1 as x from site_claims`)).toBeUndefined()
  })

  test('says whether the member has a GitHub to claim by (ADR 0045)', async () => {
    await api.db.run(sql`
      insert into account (id, account_id, provider_id, user_id, created_at, updated_at)
      values ('gh', '4242', 'github', ${reader.userId}, 1, 1)
    `)
    expect((await start()).github).toBe(true)
  })

  test('a check that found no proof comes back as a reason, and as text for an older page', async () => {
    const { siteId } = await start()
    await api.request(`/api/v1/claims/${siteId}/verify`, { body: {}, as: reader })
    const failWith = async (error: string) => {
      await api.db.run(sql`update site_claims set status = 'failed', error = ${error}`)
      return (await (
        await api.request(`/api/v1/claims/${siteId}`, { as: reader })
      ).json()) as Standing
    }
    const missed = await failWith(JSON.stringify({ reason: 'no_proof', page: server.url('/') }))
    expect(missed.reason).toEqual({ reason: 'no_proof', page: server.url('/') })
    // A claim page cached before reasons shows `error` alone, so it is never empty for one.
    expect(missed.error).toContain(`no meta tag with the token`)
    expect(missed.error).toContain(server.url('/'))
    const down = await failWith('home page returned HTTP 503')
    expect(down.reason).toBe(null)
    expect(down.error).toBe('home page returned HTTP 503')
  })

  test('the token is the same every time for a member, and differs between members', async () => {
    const mine = await start()
    expect((await start()).proofs?.meta).toBe(mine.proofs?.meta)
    const other = await signedIn(api, 'other@x.test')
    expect((await start(other)).proofs?.meta).not.toBe(mine.proofs?.meta)
  })

  test('asking for the check makes a pending claim and sends it to be verified', async () => {
    const { siteId } = await start()
    const res = await api.request(`/api/v1/claims/${siteId}/verify`, { body: {}, as: reader })
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
    const verify = await api.request(`/api/v1/claims/${siteId}/verify`, { body: {}, as: reader })
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
    const res = await api.request('/api/v1/claims', { body: { url: server.url('/') }, as: reader })
    expect(res.status).toBe(422)
  })
})
