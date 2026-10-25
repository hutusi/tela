import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cappedStream, createHttpClient, HEAD_BYTES, type HttpError, readCapped } from '../src/http'
import { isBlockedHost } from '../src/net'
import { FixtureServer } from './fixture-server'

let server: FixtureServer

beforeAll(async () => {
  server = await FixtureServer.start()
})

afterAll(async () => {
  await server.stop()
})

function client(overrides: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  return createHttpClient({
    userAgent: 'TelaTest/1.0',
    politenessMs: 0,
    allowPrivateHosts: true,
    timeoutMs: 300,
    maxBytes: 10_000,
    ...overrides,
  })
}

describe('createHttpClient', () => {
  test('sends conditional headers and the user agent', async () => {
    server.cached('/feed.xml', '<rss/>', '"v1"')
    const http = client()
    const first = await http.get(server.url('/feed.xml'))
    expect(first.status).toBe(200)
    expect(first.body).toBe('<rss/>')
    const second = await http.get(server.url('/feed.xml'), { etag: '"v1"' })
    expect(second.status).toBe(304)
    const req = server.requestsFor('/feed.xml').at(-1)
    expect(req?.headers['user-agent']).toBe('TelaTest/1.0')
    expect(req?.headers['if-none-match']).toBe('"v1"')
  })

  test('follows redirects and reports permanent ones', async () => {
    server.redirect('/old', '/new', 301)
    server.redirect('/temp', '/new', 302)
    server.text('/new', 'here')
    const http = client()
    const permanent = await http.get(server.url('/old'))
    expect(permanent.body).toBe('here')
    expect(permanent.finalUrl).toBe(server.url('/new'))
    expect(permanent.permanentRedirectTo).toBe(server.url('/new'))
    const temporary = await http.get(server.url('/temp'))
    expect(temporary.permanentRedirectTo).toBeNull()
  })

  test('stops redirect loops', async () => {
    server.redirect('/a', '/b')
    server.redirect('/b', '/a')
    await expect(client().get(server.url('/a'))).rejects.toMatchObject({ kind: 'redirect_loop' })
  })

  test('times out slow responses', async () => {
    server.delay('/slow', 800)
    await expect(client().get(server.url('/slow'))).rejects.toMatchObject({ kind: 'timeout' })
  })

  test('a request may shorten the timeout for a quick side lookup', async () => {
    server.delay('/slow-side', 800)
    await expect(
      client({ timeoutMs: 5000 }).get(server.url('/slow-side'), { timeoutMs: 100 }),
    ).rejects.toMatchObject({ kind: 'timeout' })
  })

  test('the timeout is one deadline across redirects, not one per hop', async () => {
    const hop = (from: string, to: string) =>
      server.set(from, (_req, res) => {
        setTimeout(() => {
          res.writeHead(302, { location: server.url(to) })
          res.end()
        }, 60)
      })
    hop('/h1', '/h2')
    hop('/h2', '/h3')
    hop('/h3', '/h4')
    hop('/h4', '/h5')
    server.delay('/h5', 60)
    const started = Date.now()
    // Five 60 ms steps: each fits a 200 ms budget on its own, together they do not.
    await expect(
      client({ timeoutMs: 5000 }).get(server.url('/h1'), { timeoutMs: 200 }),
    ).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('rejects oversized bodies, whatever Content-Length claims', async () => {
    server.text('/big', 'x'.repeat(20_000))
    await expect(client().get(server.url('/big'))).rejects.toMatchObject({ kind: 'too_large' })
    // No Content-Length at all (chunked): the cap counts bytes as they arrive.
    server.set('/chunked', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      for (let i = 0; i < 20; i++) res.write('x'.repeat(1000))
      res.end()
    })
    await expect(client().get(server.url('/chunked'))).rejects.toMatchObject({ kind: 'too_large' })
  })

  test('a request may keep the start of an oversized body instead, and says it was cut', async () => {
    server.set('/robots.txt', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      for (let i = 0; i < 20; i++) res.write(`${String(i).padStart(999, '#')}\n`)
      res.end()
    })
    const cut = await client().get(server.url('/robots.txt'), { maxBytes: 4500, truncate: true })
    expect(cut).toMatchObject({ status: 200, bytes: 4500, truncated: true })
    expect(cut.body.split('\n')).toHaveLength(5)
    const whole = await client().get(server.url('/robots.txt'), {
      maxBytes: 50_000,
      truncate: true,
    })
    expect(whole.bytes).toBe(20_000)
    expect(whole.truncated).toBeUndefined()
  })

  // So discovery can tell a feed too large to read from a large error page.
  test('an oversized body says its status and how it began', async () => {
    server.text('/gone', `<html>${'x'.repeat(HEAD_BYTES * 2)}`, { status: 404 })
    const err = await client({ maxBytes: HEAD_BYTES + 100 })
      .get(server.url('/gone'))
      .catch((e: HttpError) => e)
    expect(err).toMatchObject({ kind: 'too_large', status: 404 })
    expect((err as HttpError).head?.byteLength).toBe(HEAD_BYTES)
    expect(new TextDecoder().decode((err as HttpError).head).startsWith('<html>xxx')).toBe(true)
  })

  test('a 206 that holds the whole file is a 200; one that misses a byte is not', async () => {
    const partial = (path: string, range: string | null) =>
      server.set(path, (_req, res) => {
        res.writeHead(206, {
          'content-type': 'text/xml',
          ...(range ? { 'content-range': range } : {}),
        })
        res.end('<rss/>')
      })
    // What Caddy answers with a precompressed file (kalzumeus.com): every byte, unasked.
    partial('/whole', 'bytes 0-5/6')
    partial('/part', 'bytes 0-2/6')
    partial('/later', 'bytes 3-5/6')
    partial('/unnamed', null)
    const http = client()
    const whole = await http.get(server.url('/whole'))
    expect(whole.status).toBe(200)
    expect(whole.body).toBe('<rss/>')
    expect((await http.get(server.url('/part'))).status).toBe(206)
    expect((await http.get(server.url('/later'))).status).toBe(206)
    expect((await http.get(server.url('/unnamed'))).status).toBe(206)
  })

  test('cappedStream passes bytes through until the cap and then fails the stream', async () => {
    const chunks = [new Uint8Array(6000), new Uint8Array(6000)]
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      },
    })
    const reader = cappedStream(source, 10_000).getReader()
    expect((await reader.read()).value?.byteLength).toBe(6000)
    // The error keeps the start of what arrived, the chunk that crossed the cap included.
    const cut = await reader.read().catch((e: HttpError) => e)
    expect(cut).toMatchObject({ kind: 'too_large' })
    expect((cut as HttpError).head?.byteLength).toBe(12_000)
    // Even when that chunk is the first: CI fetched a 32 KB body as one.
    const one = new Uint8Array(HEAD_BYTES * 2).fill(7)
    const whole = cappedStream(new Response(one).body as ReadableStream<Uint8Array>, 10_000)
    const first = await whole
      .getReader()
      .read()
      .catch((e: HttpError) => e)
    expect((first as HttpError).head).toEqual(one.subarray(0, HEAD_BYTES))
    const fine = await readCapped(new Response(new Uint8Array(3000)), 10_000)
    expect(fine.byteLength).toBe(3000)
  })

  test('decodes declared charsets', async () => {
    server.set('/gbk', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/xml; charset=gbk' })
      // "<t>中文</t>" encoded as GBK
      res.end(Buffer.from([0x3c, 0x74, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f, 0x74, 0x3e]))
    })
    const res = await client().get(server.url('/gbk'))
    expect(res.body).toBe('<t>中文</t>')
  })

  test('blocks private hosts unless allowed, on every redirect hop', async () => {
    expect(isBlockedHost('localhost')).toBe(true)
    expect(isBlockedHost('10.1.2.3')).toBe(true)
    expect(isBlockedHost('[fdaa::1]')).toBe(true)
    expect(isBlockedHost('blog.example')).toBe(false)
    const strict = createHttpClient({ userAgent: 'x', politenessMs: 0 })
    await expect(strict.get(server.url('/new'))).rejects.toMatchObject({ kind: 'blocked' })
    // A public-looking first hop that redirects into a private address is refused too.
    server.redirect('/hop', 'http://[::ffff:127.0.0.1]:9/secret')
    await expect(
      createHttpClient({ userAgent: 'x', politenessMs: 0, allowPrivateHosts: false }).get(
        server.url('/hop'),
      ),
    ).rejects.toMatchObject({ kind: 'blocked' })
  })

  test('spaces requests to the same host', async () => {
    server.text('/p', 'ok')
    const waits: number[] = []
    let clock = 0
    const http = client({
      politenessMs: 2000,
      // The wait counts against the request's deadline, so it must fit inside it.
      timeoutMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms)
        clock += ms
      },
    })
    await http.get(server.url('/p'))
    await http.get(server.url('/p'))
    expect(waits).toEqual([2000])
  })

  test('a politeness wait that would outlast the deadline is refused without sleeping', async () => {
    server.text('/q', 'ok')
    const waits: number[] = []
    let clock = 0
    const http = client({
      politenessMs: 2000,
      timeoutMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms)
        clock += ms
      },
    })
    await http.get(server.url('/q'))
    await expect(http.get(server.url('/q'), { timeoutMs: 500 })).rejects.toMatchObject({
      kind: 'timeout',
    })
    expect(waits).toEqual([])
    expect(server.requestsFor('/q')).toHaveLength(1)
  })

  test('uses the relay for the cn region', async () => {
    let relayed = ''
    const http = client({
      relay: async (url) => {
        relayed = url
        return new Response('from relay', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      },
    })
    const res = await http.get('https://blocked.example/feed', { region: 'cn' })
    expect(relayed).toBe('https://blocked.example/feed')
    expect(res.body).toBe('from relay')
  })
})
