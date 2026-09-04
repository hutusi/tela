import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { request as httpRequest } from 'node:http'
import { createHttpClient, createRelayClient } from '@tela/ingest'
import { loadConfig } from '../src/config'
import { startRelayServer } from '../src/relay/server'
import { FixtureServer } from './fixture-server'

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
    timeoutMs: 500,
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
    timeoutMs: 1000,
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
    // Node's http client, not the shared fetch pool: the server drops these connections, and a
    // pooled socket that died under a later test would only make the failure look flaky.
    const post = (headers: Record<string, string>, chunk: string, times: number) =>
      new Promise<number | 'reset'>((resolve) => {
        const req = httpRequest(base, { method: 'POST', headers }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', () => resolve('reset'))
        let sent = 0
        const pump = () => {
          while (sent < times) {
            sent += 1
            if (!req.write(chunk)) {
              req.once('drain', pump)
              return
            }
          }
          req.end()
        }
        pump()
      })
    // Declared up front: refused from the header alone.
    const big = 'x'.repeat(256 * 1024)
    expect(await post({ 'content-length': String(big.length) }, big, 1)).toBe(413)
    // No Content-Length (chunked): the cap applies to what actually arrives. The server may
    // drop the connection right after answering, so a reset counts as refused too.
    const chunked = await post({ 'transfer-encoding': 'chunked' }, 'y'.repeat(32 * 1024), 8)
    expect([413, 'reset']).toContain(chunked)
    expect(origin.requests).toHaveLength(0)
  })

  test('rejects a client with the wrong secret', async () => {
    origin.text('/feed.xml', '<rss/>')
    await expect(
      client('some-other-secret-value').get(origin.url('/feed.xml'), { region: 'cn' }),
    ).rejects.toMatchObject({ kind: 'network', message: 'relay responded 401' })
    expect(origin.requests).toHaveLength(0)
  })

  test('the relay role needs a secret and no database', () => {
    expect(() => loadConfig({ WORKER_ROLES: 'relay' })).toThrow(/RELAY_SECRET/)
    const cfg = loadConfig({ WORKER_ROLES: 'relay', RELAY_SECRET: SECRET })
    expect(cfg.needsDb).toBe(false)
    expect(cfg.RELAY_PORT).toBe(8787)
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x/y', RELAY_URL: 'https://relay.example' }),
    ).toThrow(/RELAY_SECRET/)
  })
})
