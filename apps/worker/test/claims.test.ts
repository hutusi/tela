import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { feeds, siteClaims, sites } from '@tela/db'
import { getOrCreateClaim } from '@tela/db/queries'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { createHttpClient } from '@tela/ingest'
import { eq, sql } from 'drizzle-orm'
import { findProof, verifyClaim } from '../src/claims/verify'
import { FixtureServer } from './fixture-server'

let t: TestDb
let server: FixtureServer
const userA = '11111111-1111-4111-8111-111111111111'
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
})
