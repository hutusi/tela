import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHttpClient, HttpError, isBlockedHost } from '../src/http'
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

  test('rejects oversized bodies', async () => {
    server.text('/big', 'x'.repeat(20_000))
    await expect(client().get(server.url('/big'))).rejects.toMatchObject({ kind: 'too_large' })
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

  test('blocks private hosts unless allowed', async () => {
    expect(isBlockedHost('localhost')).toBe(true)
    expect(isBlockedHost('10.1.2.3')).toBe(true)
    expect(isBlockedHost('blog.example')).toBe(false)
    const strict = createHttpClient({ userAgent: 'x', politenessMs: 0 })
    await expect(strict.get(server.url('/new'))).rejects.toBeInstanceOf(HttpError)
  })

  test('spaces requests to the same host', async () => {
    server.text('/p', 'ok')
    const waits: number[] = []
    let clock = 0
    const http = client({
      politenessMs: 2000,
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
