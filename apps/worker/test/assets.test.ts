import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sites } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { createHttpClient } from '@tela/ingest'
import { eq } from 'drizzle-orm'
import { findCoverUrl, findIconUrls, processSiteAssets } from '../src/assets/site-assets'
import { createFsStore } from '../src/assets/store'
import { FixtureServer } from './fixture-server'

let t: TestDb
let server: FixtureServer
let dir: string
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 500,
})

let PNG: Buffer

beforeAll(async () => {
  t = await startTestDb()
  server = await FixtureServer.start()
  dir = await mkdtemp(join(tmpdir(), 'tela-assets-'))
  // A real 4x4 red PNG, produced by sharp so the fixture never goes stale.
  PNG = await (await import('sharp'))
    .default({
      create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
    .png()
    .toBuffer()
}, 120_000)

afterAll(async () => {
  await server.stop()
  await t?.stop()
})

beforeEach(async () => {
  server.reset()
  await resetDatabase(t.db)
})

describe('asset discovery', () => {
  test('ranks declared icons, adds /favicon.ico, and finds og:image', () => {
    const html = `<head>
      <link rel="icon" href="/small.png" sizes="16x16">
      <link rel="icon" href="/big.png" sizes="192x192">
      <link rel="apple-touch-icon" href="/apple.png">
      <meta property="og:image" content="/cover.jpg">
    </head>`
    expect(findIconUrls(html, 'https://blog.example/')).toEqual([
      'https://blog.example/apple.png',
      'https://blog.example/big.png',
      'https://blog.example/small.png',
      'https://blog.example/favicon.ico',
    ])
    expect(findCoverUrl(html, 'https://blog.example/')).toBe('https://blog.example/cover.jpg')
    expect(findIconUrls('', 'https://blog.example/')).toEqual(['https://blog.example/favicon.ico'])
  })
})

describe('processSiteAssets', () => {
  test('stores a normalized favicon and cover and stamps the site', async () => {
    const [site] = await t.db
      .insert(sites)
      .values({ homeUrl: server.origin, title: 'Fixture' })
      .returning()
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        '<html><head><link rel="icon" href="/icon.png"><meta property="og:image" content="/cover.png"></head></html>',
      )
    })
    server.set('/icon.png', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length })
      res.end(PNG)
    })
    server.set('/cover.png', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length })
      res.end(PNG)
    })
    const out = await processSiteAssets({ db: t.db, http, store: createFsStore(dir) }, site!.id)
    expect(out).toEqual({ status: 'done', favicon: true, cover: true })
    const [row] = await t.db.select().from(sites).where(eq(sites.id, site!.id))
    expect(row?.faviconKey).toMatch(new RegExp(`^sites/${site!.id}/favicon-\\d+\\.png$`))
    expect(row?.coverKey).toMatch(/\.webp$/)
    expect(row?.assetsCheckedAt).not.toBeNull()
    const icon = await readFile(join(dir, row?.faviconKey as string))
    expect(icon.subarray(1, 4).toString()).toBe('PNG')
    expect((await stat(join(dir, row?.coverKey as string))).size).toBeGreaterThan(0)
  })

  test('stamps the site when nothing is found, but not while no store is configured', async () => {
    const [site] = await t.db.insert(sites).values({ homeUrl: server.origin }).returning()
    server.text('/', '<html></html>', { headers: { 'content-type': 'text/html' } })
    const none = await processSiteAssets({ db: t.db, http, store: createFsStore(dir) }, site!.id)
    expect(none).toEqual({ status: 'done', favicon: false, cover: false })
    let [row] = await t.db.select().from(sites).where(eq(sites.id, site!.id))
    expect(row?.faviconKey).toBeNull()
    expect(row?.assetsCheckedAt).not.toBeNull()

    await t.db.update(sites).set({ assetsCheckedAt: null }).where(eq(sites.id, site!.id))
    expect(await processSiteAssets({ db: t.db, http, store: null }, site!.id)).toMatchObject({
      status: 'skipped',
    })
    ;[row] = await t.db.select().from(sites).where(eq(sites.id, site!.id))
    expect(row?.assetsCheckedAt).toBeNull()
  })
})
