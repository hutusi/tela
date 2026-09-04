import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  hubSignature,
  newWebsubSecret,
  requestHubSubscription,
  verifyHubSignature,
} from '../src/websub'
import { FixtureServer } from './fixture-server'

let server: FixtureServer
beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(() => server.reset())

const body = new TextEncoder().encode('<feed><entry>new</entry></feed>')

describe('hub signatures', () => {
  test('round-trips every algorithm and rejects tampering', async () => {
    const secret = newWebsubSecret()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(newWebsubSecret()).not.toBe(secret)
    for (const algorithm of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
      const header = await hubSignature(secret, body, algorithm)
      expect(header.startsWith(`${algorithm}=`)).toBe(true)
      expect(await verifyHubSignature(secret, body, header)).toBe(true)
      expect(await verifyHubSignature(secret, body, header.toUpperCase())).toBe(true)
      expect(await verifyHubSignature('other', body, header)).toBe(false)
      expect(await verifyHubSignature(secret, new TextEncoder().encode('x'), header)).toBe(false)
    }
    expect(await verifyHubSignature(secret, body, null)).toBe(false)
    expect(await verifyHubSignature(secret, body, 'md5=abcd')).toBe(false)
    expect(await verifyHubSignature(secret, body, 'sha256=zz')).toBe(false)
  })
})

describe('requestHubSubscription', () => {
  test('posts the form the spec wants and treats 2xx as accepted', async () => {
    let received = ''
    server.set('/hub', (req, res) => {
      let data = ''
      req.on('data', (c) => {
        data += c
      })
      req.on('end', () => {
        received = data
        res.writeHead(202)
        res.end()
      })
    })
    const result = await requestHubSubscription({
      hubUrl: server.url('/hub'),
      topicUrl: 'https://blog.example/feed.xml',
      callbackUrl: 'https://tela.app/api/websub/7',
      secret: 's3cret',
      leaseSeconds: 3600,
      allowPrivateHosts: true,
    })
    expect(result).toEqual({ ok: true, status: 202 })
    const form = new URLSearchParams(received)
    expect(Object.fromEntries(form)).toEqual({
      'hub.mode': 'subscribe',
      'hub.topic': 'https://blog.example/feed.xml',
      'hub.callback': 'https://tela.app/api/websub/7',
      'hub.secret': 's3cret',
      'hub.lease_seconds': '3600',
    })
    expect(server.requests[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded')
  })

  test('reports rejections, timeouts, and blocked hubs without throwing', async () => {
    server.text('/no', 'nope', { status: 404 })
    server.delay('/slow', 800)
    const base = {
      topicUrl: 'https://b.example/f',
      callbackUrl: 'https://tela.app/api/websub/1',
      secret: 's',
    }
    expect(
      await requestHubSubscription({ ...base, hubUrl: server.url('/no'), allowPrivateHosts: true }),
    ).toEqual({ ok: false, error: 'hub responded 404' })
    const slow = await requestHubSubscription({
      ...base,
      hubUrl: server.url('/slow'),
      allowPrivateHosts: true,
      timeoutMs: 200,
    })
    expect(slow.ok).toBe(false)
    expect(slow.ok ? '' : slow.error).toMatch(/timed out/)
    const blocked = await requestHubSubscription({ ...base, hubUrl: server.url('/hub') })
    expect(blocked.ok).toBe(false)
    expect(blocked.ok ? '' : blocked.error).toMatch(/not allowed/)
    expect(await requestHubSubscription({ ...base, hubUrl: 'ftp://hub.example' })).toMatchObject({
      ok: false,
    })
  })
})
