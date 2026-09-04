import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHttpClient } from '../src/http'
import {
  createRelayClient,
  createRelayHandler,
  fetchViaHandler,
  RELAY_SIGNATURE_HEADER,
  RELAY_TIMESTAMP_HEADER,
  type RelayReply,
  signRelayRequest,
} from '../src/relay'
import { FixtureServer } from './fixture-server'

let server: FixtureServer
const SECRET = 'relay-secret-for-tests'
const OLD_SECRET = 'previous-relay-secret'

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(() => server.reset())

type Handler = ReturnType<typeof createRelayHandler>

function handler(overrides: Partial<Parameters<typeof createRelayHandler>[0]> = {}): Handler {
  return createRelayHandler({
    secrets: [SECRET],
    allowPrivateHosts: true,
    timeoutMs: 300,
    maxBytes: 10_000,
    ...overrides,
  })
}

async function post(
  h: Handler,
  body: string,
  opts: { ts?: string; secret?: string; signature?: string } = {},
) {
  const ts = opts.ts ?? String(Date.now())
  const signature = opts.signature ?? (await signRelayRequest(opts.secret ?? SECRET, ts, body))
  return h(
    new Request('http://relay.test/fetch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [RELAY_TIMESTAMP_HEADER]: ts,
        [RELAY_SIGNATURE_HEADER]: signature,
      },
      body,
    }),
  )
}

const fetchBody = (url: string, headers: Record<string, string> = {}) =>
  JSON.stringify({ url, headers })

describe('relay handler', () => {
  test('answers health checks and rejects unknown routes and methods', async () => {
    const h = handler()
    expect((await h(new Request('http://relay.test/healthz'))).status).toBe(200)
    expect((await h(new Request('http://relay.test/fetch'))).status).toBe(405)
    expect((await h(new Request('http://relay.test/nope', { method: 'POST' }))).status).toBe(404)
  })

  test('rejects missing, stale, and forged signatures; accepts the previous secret', async () => {
    const h = handler({ secrets: [SECRET, OLD_SECRET] })
    const body = fetchBody(server.url('/x'))
    const bare = await h(new Request('http://relay.test/fetch', { method: 'POST', body }))
    expect(bare.status).toBe(401)
    expect((await post(h, body, { ts: String(Date.now() - 10 * 60_000) })).status).toBe(401)
    expect((await post(h, body, { secret: 'wrong-secret-entirely' })).status).toBe(401)
    expect((await post(h, body, { signature: 'ff'.repeat(32) })).status).toBe(401)
    // A signature over a different body does not authorize this one.
    const other = await signRelayRequest(SECRET, '1', fetchBody(server.url('/y')))
    expect((await post(h, body, { ts: '1', signature: other })).status).toBe(401)
    server.text('/x', 'ok')
    expect((await post(h, body, { secret: OLD_SECRET })).status).toBe(200)
    expect(server.requests).toHaveLength(1)
  })

  test('refuses private hosts and non-http schemes without fetching', async () => {
    const h = handler({ allowPrivateHosts: false })
    const blocked = (await (
      await post(h, fetchBody('http://127.0.0.1:9/feed'))
    ).json()) as RelayReply
    expect(blocked).toMatchObject({ ok: false, kind: 'blocked' })
    const scheme = (await (await post(h, fetchBody('file:///etc/passwd'))).json()) as RelayReply
    expect(scheme).toMatchObject({ ok: false, kind: 'blocked' })
    expect((await post(h, '{not json')).status).toBe(400)
    expect((await post(h, JSON.stringify({ url: 'nope' }))).status).toBe(400)
    expect(server.requests).toHaveLength(0)
  })

  test('forwards only allowlisted headers and returns status, headers, and body', async () => {
    server.set('/echo', (_req, res) => {
      res.writeHead(203, { 'content-type': 'text/plain', 'x-origin': 'yes' })
      res.end('hello 中文')
    })
    const res = await post(
      handler(),
      fetchBody(server.url('/echo'), {
        Accept: 'text/plain',
        'If-None-Match': '"v1"',
        Cookie: 'secret=1',
        Authorization: 'Bearer nope',
      }),
    )
    const reply = (await res.json()) as RelayReply
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.status).toBe(203)
    expect(Object.fromEntries(reply.headers)).toMatchObject({
      'content-type': 'text/plain',
      'x-origin': 'yes',
    })
    expect(
      new TextDecoder().decode(Uint8Array.from(atob(reply.bodyB64), (c) => c.charCodeAt(0))),
    ).toBe('hello 中文')
    const seen = server.requests[0]?.headers ?? {}
    expect(seen.accept).toBe('text/plain')
    expect(seen['if-none-match']).toBe('"v1"')
    expect(seen.cookie).toBeUndefined()
    expect(seen.authorization).toBeUndefined()
  })

  test('reports timeouts and oversized bodies as fetch failures, not transport errors', async () => {
    server.delay('/slow', 800)
    server.text('/big', 'x'.repeat(20_000))
    const slow = (await (
      await post(handler(), fetchBody(server.url('/slow')))
    ).json()) as RelayReply
    expect(slow).toMatchObject({ ok: false, kind: 'timeout' })
    const big = (await (await post(handler(), fetchBody(server.url('/big')))).json()) as RelayReply
    expect(big).toMatchObject({ ok: false, kind: 'too_large' })
  })

  test('returns redirects without following them', async () => {
    server.redirect('/old', server.url('/new'))
    const reply = (await (
      await post(handler(), fetchBody(server.url('/old')))
    ).json()) as RelayReply
    expect(reply).toMatchObject({ ok: true, status: 301, bodyB64: '' })
    if (!reply.ok) return
    expect(Object.fromEntries(reply.headers).location).toBe(server.url('/new'))
    expect(server.requests).toHaveLength(1)
  })
})

describe('relay client through createHttpClient', () => {
  let relayCalls = 0
  function client(secret = SECRET) {
    relayCalls = 0
    const h = handler()
    const direct = fetchViaHandler(h)
    const counted = ((...args: Parameters<typeof fetch>) => {
      relayCalls += 1
      return direct(...args)
    }) as typeof fetch
    return createHttpClient({
      userAgent: 'TelaTest/1.0',
      politenessMs: 0,
      allowPrivateHosts: true,
      timeoutMs: 1000,
      maxBytes: 10_000,
      relay: createRelayClient({ relayUrl: 'http://relay.test', secret, fetch: counted }),
    })
  }

  test('routes cn-region requests through the relay hop by hop; global requests go direct', async () => {
    server.redirect('/old', server.url('/new'))
    server.text('/new', '<rss/>', { headers: { etag: '"n"' } })
    const http = client()
    const res = await http.get(server.url('/old'), { region: 'cn' })
    expect(res).toMatchObject({
      status: 200,
      body: '<rss/>',
      permanentRedirectTo: server.url('/new'),
    })
    expect(res.headers.get('etag')).toBe('"n"')
    expect(relayCalls).toBe(2)
    await http.get(server.url('/new'))
    expect(relayCalls).toBe(2)
    expect(server.requests.map((r) => r.path)).toEqual(['/old', '/new', '/new'])
  })

  test('keeps conditional requests, charsets, and null-body statuses intact', async () => {
    server.cached('/feed.xml', '<rss/>', '"v1"')
    server.set('/gbk', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/xml; charset=gbk' })
      res.end(Buffer.from([0x3c, 0x74, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f, 0x74, 0x3e]))
    })
    const http = client()
    const fresh = await http.get(server.url('/feed.xml'), { region: 'cn' })
    expect(fresh.status).toBe(200)
    const notModified = await http.get(server.url('/feed.xml'), { region: 'cn', etag: '"v1"' })
    expect(notModified).toMatchObject({ status: 304, body: '', bytes: 0 })
    const gbk = await http.get(server.url('/gbk'), { region: 'cn' })
    expect(gbk.body).toBe('<t>中文</t>')
    expect(gbk.raw.byteLength).toBe(11)
  })

  test('surfaces relay-side failures with the client error kinds', async () => {
    server.delay('/slow', 800)
    server.text('/big', 'x'.repeat(20_000))
    const http = client()
    await expect(http.get(server.url('/slow'), { region: 'cn' })).rejects.toMatchObject({
      kind: 'timeout',
    })
    await expect(http.get(server.url('/big'), { region: 'cn' })).rejects.toMatchObject({
      kind: 'too_large',
    })
    // The relay enforces the private-network rules itself, even for a permissive client.
    const strict = createHttpClient({
      userAgent: 'TelaTest/1.0',
      politenessMs: 0,
      allowPrivateHosts: true,
      timeoutMs: 1000,
      relay: createRelayClient({
        relayUrl: 'http://relay.test',
        secret: SECRET,
        fetch: fetchViaHandler(handler({ allowPrivateHosts: false })),
      }),
    })
    await expect(strict.get('http://10.0.0.1/feed', { region: 'cn' })).rejects.toMatchObject({
      kind: 'blocked',
    })
    await expect(
      client('another-secret-value').get(server.url('/big'), { region: 'cn' }),
    ).rejects.toMatchObject({
      kind: 'network',
      message: 'relay responded 401',
    })
  })
})
