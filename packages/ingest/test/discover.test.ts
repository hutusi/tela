import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { discoverFeeds } from '../src/discover'
import { createHttpClient } from '../src/http'
import { FEED_MAX_BYTES } from '../src/items'
import { FixtureServer, rss } from './fixture-server'

let server: FixtureServer
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})

beforeAll(async () => {
  server = await FixtureServer.start()
})

afterAll(async () => {
  await server.stop()
})

beforeEach(() => {
  server.reset()
})

describe('discoverFeeds', () => {
  test('returns the feed itself when given a feed URL', async () => {
    server.text('/feed.xml', rss({ items: [{ guid: '1', title: 'A', description: 'x' }] }))
    const found = await discoverFeeds(http, server.url('/feed.xml'))
    expect(found).toEqual([
      {
        url: server.url('/feed.xml'),
        title: 'Test Blog',
        format: 'rss',
        itemCount: 1,
        homeUrl: 'https://blog.example/',
      },
    ])
  })

  // danluu.com's feed carries every post since 2013: 6.6 MB, past the 5 MB pages get.
  test('reads a feed past the 5 MB a page gets, up to FEED_MAX_BYTES', async () => {
    const big = (pad: number) =>
      rss({ items: [{ guid: '1', title: 'A', content: `<p>x</p><!-- ${'x'.repeat(pad)} -->` }] })
    server.text('/archive.xml', big(6 * 1024 * 1024))
    server.text('/huge.xml', big(FEED_MAX_BYTES))
    const found = await discoverFeeds(http, server.url('/archive.xml'))
    expect(found.map((f) => [f.url, f.itemCount])).toEqual([[server.url('/archive.xml'), 1]])
    expect(await discoverFeeds(http, server.url('/huge.xml'))).toEqual([])
  })

  test('uses feeds declared by the page', async () => {
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><head>
        <link rel="alternate" type="application/rss+xml" href="/declared.xml">
        <link rel="alternate" type="application/atom+xml" href="/missing.xml">
      </head><body>Hello</body></html>`)
    })
    server.text(
      '/declared.xml',
      rss({ title: 'Declared', items: [{ guid: '1', title: 'A', description: 'x' }] }),
    )
    const found = await discoverFeeds(http, server.url('/'))
    expect(found.map((f) => [f.url, f.title])).toEqual([[server.url('/declared.xml'), 'Declared']])
  })

  test('probes well-known paths when the page declares nothing', async () => {
    server.set('/plain', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>No links here</body></html>')
    })
    server.text(
      '/atom.xml',
      rss({ title: 'Probed', items: [{ guid: '1', title: 'A', description: 'x' }] }),
    )
    const found = await discoverFeeds(http, server.url('/plain'))
    expect(found.map((f) => f.title)).toEqual(['Probed'])
  })

  test('returns nothing for sites without feeds', async () => {
    server.set('/nothing', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>bare</body></html>')
    })
    expect(await discoverFeeds(http, server.url('/nothing'))).toEqual([])
  })
})
