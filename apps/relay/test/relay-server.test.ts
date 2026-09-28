import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { connect } from 'node:net'
import { createHttpClient } from '@tela/ingest/http'
import { createRelayClient } from '@tela/ingest/relay'
import { FixtureServer } from '../../../packages/ingest/test/fixture-server'
import { relayConfig } from '../src/config'
import { startRelayServer } from '../src/server'

const SECRET = 'relay-secret-for-tests'
let origin: FixtureServer
let relay: Awaited<ReturnType<typeof startRelayServer>>

beforeAll(async () => {
  origin = await FixtureServer.start()
  relay = await startRelayServer({
    secrets: [SECRET],
    port: 0,
    host: '127.0.0.1',
    allowPrivateHosts: true,
    // Nothing here exercises the timeout; keep it loose so a busy machine cannot turn a 401
    // into a spurious timeout.
    timeoutMs: 5000,
  })
})
afterAll(async () => {
  await relay.stop()
  await origin.stop()
})
beforeEach(() => origin.reset())

function client(secret = SECRET) {
  return createHttpClient({
    userAgent: 'TelaTest/1.0',
    politenessMs: 0,
    allowPrivateHosts: true,
    timeoutMs: 5000,
    relay: createRelayClient({ relayUrl: `http://127.0.0.1:${relay.port}`, secret }),
  })
}

describe('relay server', () => {
  test('serves health and relays a fetch over a real socket', async () => {
    const health = await fetch(`http://127.0.0.1:${relay.port}/healthz`)
    expect(health.status).toBe(200)
    origin.text('/feed.xml', '<rss><channel><title>Relayed</title></channel></rss>', {
      headers: { etag: '"r1"' },
    })
    const res = await client().get(origin.url('/feed.xml'), { region: 'cn' })
    expect(res.status).toBe(200)
    expect(res.body).toContain('Relayed')
    expect(res.headers.get('etag')).toBe('"r1"')
    expect(origin.requests[0]?.headers['user-agent']).toBe('TelaTest/1.0')
  })

  test('refuses an oversized request before reading it, so memory cannot be exhausted pre-auth', async () => {
    const base = `http://127.0.0.1:${relay.port}/fetch`
    // A small unsigned request gets the normal 401 (timestamp first, before any body work).
    const small = await fetch(base, { method: 'POST', body: '{"url":"http://x/"}' })
    expect({ status: small.status, body: await small.text() }).toEqual({
      status: 401,
      body: '{"error":"stale or missing timestamp"}',
    })
    // Raw sockets, so no client-side connection pool (Bun shares reuse between fetch and
    // node:http) can hand a socket the server dropped mid-body to the next test.
    const raw = (headers: Record<string, string>, frames: string[]) =>
      new Promise<number | 'reset'>((resolve) => {
        let settled = false
        const sock = connect({ host: '127.0.0.1', port: relay.port })
        const settle = (value: number | 'reset') => {
          if (settled) return
          settled = true
          resolve(value)
          sock.destroy()
        }
        let received = ''
        sock.on('data', (chunk) => {
          received += chunk.toString('latin1')
          const status = /^HTTP\/1\.[01] (\d{3})/.exec(received)
          if (status) settle(Number(status[1]))
        })
        sock.on('error', () => settle('reset'))
        sock.on('close', () => settle('reset'))
        sock.on('connect', () => {
          const head = [
            'POST /fetch HTTP/1.1',
            `host: 127.0.0.1:${relay.port}`,
            'connection: close',
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            '',
            '',
          ].join('\r\n')
          sock.write(head)
          let i = 0
          const pump = () => {
            while (i < frames.length) {
              const frame = frames[i++] as string
              if (!sock.write(frame)) {
                sock.once('drain', pump)
                return
              }
            }
          }
          pump()
        })
      })
    // Declared up front: refused from the header alone.
    const big = 'x'.repeat(256 * 1024)
    expect(await raw({ 'content-length': String(big.length) }, [big])).toBe(413)
    // No Content-Length (chunked): the cap applies to what actually arrives. The server may
    // drop the connection right after answering, so a reset counts as refused too.
    const chunk = 'y'.repeat(32 * 1024)
    const frames = Array.from({ length: 8 }, () => `${chunk.length.toString(16)}\r\n${chunk}\r\n`)
    frames.push('0\r\n\r\n')
    expect([413, 'reset']).toContain(await raw({ 'transfer-encoding': 'chunked' }, frames))
    expect(origin.requests).toHaveLength(0)
  })

  test('rejects a client with the wrong secret', async () => {
    origin.text('/feed.xml', '<rss/>')
    await expect(
      client('some-other-secret-value').get(origin.url('/feed.xml'), { region: 'cn' }),
    ).rejects.toMatchObject({ kind: 'network', message: 'relay responded 401' })
    expect(origin.requests).toHaveLength(0)
  })

  test('needs a secret, and accepts the previous one while it rotates', () => {
    expect(() => relayConfig({})).toThrow(/RELAY_SECRET/)
    expect(() => relayConfig({ RELAY_SECRET: 'short' })).toThrow(/RELAY_SECRET/)
    expect(relayConfig({ RELAY_SECRET: SECRET })).toEqual({
      secrets: [SECRET],
      port: 8787,
      timeoutMs: 20_000,
    })
    expect(
      relayConfig({ RELAY_SECRET: SECRET, RELAY_SECRET_PREVIOUS: 'old-secret-still-good' }).secrets,
    ).toEqual([SECRET, 'old-secret-still-good'])
  })
})
