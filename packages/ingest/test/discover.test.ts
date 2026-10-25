import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { discoverFeeds } from '../src/discover'
import { createHttpClient } from '../src/http'
import { FEED_MAX_BYTES } from '../src/items'
import { FixtureServer, type RouteHandler, rss } from './fixture-server'

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
    // Past it, the member is told the feed is too large, not that there is none.
    await expect(discoverFeeds(http, server.url('/huge.xml'))).rejects.toMatchObject({
      kind: 'too_large',
    })
  })

  test('a feed too large to read is not news when another feed was found', async () => {
    server.set('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><head>
        <link rel="alternate" type="application/rss+xml" href="/everything.xml">
        <link rel="alternate" type="application/rss+xml" href="/recent.xml">
      </head></html>`)
    })
    server.text(
      '/everything.xml',
      rss({
        items: [{ guid: '1', title: 'A', content: `<!-- ${'x'.repeat(FEED_MAX_BYTES)} -->` }],
      }),
    )
    server.text('/recent.xml', rss({ items: [{ guid: '1', title: 'A', description: 'x' }] }))
    const found = await discoverFeeds(http, server.url('/'))
    expect(found.map((f) => f.url)).toEqual([server.url('/recent.xml')])
  })

  // Codex's review: every body past the cap counted as a feed too large to read.
  test('a page too large to read is not a feed too large to read', async () => {
    const huge =
      (status: number, type: string, body: string): RouteHandler =>
      (_req, res) => {
        res.writeHead(status, { 'content-type': type })
        res.end(body)
      }
    const page = `<html><body>${'x'.repeat(FEED_MAX_BYTES)}</body></html>`
    server.set('/big', huge(200, 'text/html', page)) // the page typed
    server.set('/feed', huge(404, 'text/html', page)) // a guessed path's error page
    server.set('/atom.xml', huge(200, 'text/html', page)) // a soft 404
    server.set(
      '/feed.json',
      huge(200, 'application/json', `{"rows": "${'x'.repeat(FEED_MAX_BYTES)}"}`),
    )
    expect(await discoverFeeds(http, server.url('/big'))).toEqual([])
    // A JSON Feed no longer parses once cut, and is still named.
    const jsonFeed = `{"version": "https://jsonfeed.org/version/1.1", "items": ["${'x'.repeat(FEED_MAX_BYTES)}"]}`
    server.set('/feed.json', huge(200, 'application/feed+json', jsonFeed))
    await expect(discoverFeeds(http, server.url('/big'))).rejects.toMatchObject({
      kind: 'too_large',
    })
  })

  // Codex's second review: the start was read as UTF-8 whatever the charset said.
  test('a feed too large to read is known in the charset it declares', async () => {
    const utf16 =
      (text: string): RouteHandler =>
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-16le' })
        res.end(Buffer.from(`﻿${text}`, 'utf16le'))
      }
    const feed = (pad: number) =>
      rss({ items: [{ guid: '1', title: 'A', content: `<!-- ${'x'.repeat(pad)} -->` }] })
    server.set('/small.xml', utf16(feed(10)))
    expect((await discoverFeeds(http, server.url('/small.xml'))).map((f) => f.itemCount)).toEqual([
      1,
    ])
    server.set('/large.xml', utf16(feed(FEED_MAX_BYTES / 2)))
    await expect(discoverFeeds(http, server.url('/large.xml'))).rejects.toMatchObject({
      kind: 'too_large',
    })
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

  const html = (path: string, head: string) =>
    server.set(path, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><head>${head}</head><body>A page</body></html>`)
    })

  // byvoid.com's home is Hugo's multilingual root: a meta refresh to /zht/, which names the feed.
  test('follows a meta refresh when the page declares nothing', async () => {
    html('/', `<meta http-equiv="refresh" content="0; url=${server.url('/zht/')}">`)
    html('/zht/', '<link rel="alternate" type="application/rss+xml" href="/zht/feed.xml">')
    server.text(
      '/zht/feed.xml',
      rss({ title: 'Beyond the Void', items: [{ guid: '1', title: 'A', description: 'x' }] }),
    )
    const found = await discoverFeeds(http, server.url('/'))
    expect(found.map((f) => f.url)).toEqual([server.url('/zht/feed.xml')])
  })

  // paulgraham.com/articles.html names no feed; the home page does.
  test('asks the home page when a page of the blog declares nothing', async () => {
    html('/articles.html', '<title>Essays</title>')
    html('/', '<link rel="alternate" type="application/rss+xml" href="/essays.rss">')
    server.text(
      '/essays.rss',
      rss({ title: 'Essays', items: [{ guid: '1', title: 'A', description: 'x' }] }),
    )
    const found = await discoverFeeds(http, server.url('/articles.html'))
    expect(found.map((f) => f.url)).toEqual([server.url('/essays.rss')])
    // A home that declares nothing is asked once, never twice.
    server.reset()
    html('/', '<title>Home</title>')
    expect(await discoverFeeds(http, server.url('/'))).toEqual([])
    expect(server.requestsFor('/')).toHaveLength(2)
  })

  // Codex's review: the well-known paths moved to the second page's origin, so a refresh to
  // another host lost the feed the typed host serves, which main found.
  test('a second page on another host keeps the typed host’s well-known paths, and adds its own', async () => {
    const other = await FixtureServer.start()
    try {
      html('/', `<meta http-equiv="refresh" content="0; url=${other.url('/')}">`)
      other.set('/', (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body>Moved</body></html>')
      })
      const feed = rss({ items: [{ guid: '1', title: 'A', description: 'x' }] })
      server.text('/feed', feed)
      other.text('/feed', feed)
      // The typed host's first, so whatever main found is found still.
      expect((await discoverFeeds(http, server.url('/'))).map((f) => f.url)).toEqual([
        server.url('/feed'),
      ])
      // A blog that moved to the refresh's host is found there.
      server.set('/feed', (_req, res) => {
        res.writeHead(404).end()
      })
      expect((await discoverFeeds(http, server.url('/'))).map((f) => f.url)).toEqual([
        other.url('/feed'),
      ])
    } finally {
      await other.stop()
    }
  })

  test('returns nothing for sites without feeds', async () => {
    server.set('/nothing', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>bare</body></html>')
    })
    expect(await discoverFeeds(http, server.url('/nothing'))).toEqual([])
  })
})
