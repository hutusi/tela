/** What tela-api holds of a request body, and how it answers a route it lacks or a failure. */
import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { BODY_MAX_BYTES, bodyCap, PUSH_MAX_BYTES } from '../src/app'
import { createTestApi, ORIGIN, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let reader: SignedIn

beforeAll(async () => {
  api = await createTestApi()
  reader = await signedIn(api)
})

/** A body of `size` bytes that sends no length, and how much of it was pulled. */
function stream(size: number) {
  const chunk = new Uint8Array(16 * 1024).fill(0x20)
  const read = { bytes: 0 }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (read.bytes >= size) return controller.close()
      read.bytes += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
  return { body, read }
}

describe('request bodies', () => {
  test('a JSON call larger than the cap is refused, before anything acts on it', async () => {
    const res = await api.request('/api/v1/feeds/discover', {
      as: reader,
      body: { url: `https://example.com/${'x'.repeat(BODY_MAX_BYTES)}` },
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too_large' })
  })

  test('so is a sign-in, which needs no session', async () => {
    const res = await api.request('/api/auth/sign-in/email', {
      body: { email: 'a@x.test', password: 'x'.repeat(BODY_MAX_BYTES) },
    })
    expect(res.status).toBe(413)
  })

  test('a body that sends no length is read no further than the cap', async () => {
    const { body, read } = stream(4 * 1024 * 1024)
    const res = await api.app.request(`${ORIGIN}/api/v1/feeds/discover`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: reader.cookie, ...reader.headers },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(read.bytes).toBeLessThanOrEqual(BODY_MAX_BYTES + 64 * 1024)
  })

  test('a push may carry fifty long highlights', async () => {
    // Over the general cap, under the push's: answered for what it is, not for its size.
    const res = await api.request('/api/v1/mutations', {
      as: reader,
      body: { mutations: [{ type: 'nothing', pad: '高'.repeat(100_000) }] },
    })
    expect(res.status).toBe(200)
    expect(bodyCap('POST', '/api/v1/mutations')).toBe(PUSH_MAX_BYTES)
  })

  test('the routes that read their own body under their own cap are left to it', () => {
    expect(bodyCap('PUT', '/api/v1/avatar')).toBeNull()
    expect(bodyCap('POST', '/api/websub/12')).toBeNull()
    expect(bodyCap('POST', '/api/v1/feeds/opml')).toBeNull()
    expect(bodyCap('POST', '/api/v1/feeds/discover')).toBe(BODY_MAX_BYTES)
  })

  test('an OPML file that sends no length is cut off at its cap', async () => {
    const { body, read } = stream(8 * 1024 * 1024)
    const res = await api.app.request(`${ORIGIN}/api/v1/feeds/opml`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: reader.cookie, ...reader.headers },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'opml_too_large' })
    expect(read.bytes).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024)
  })
})

describe('answers nobody planned', () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const warned = spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => {
    logged.mockClear()
    warned.mockClear()
  })

  test('a route nobody serves is a JSON 404', async () => {
    const res = await api.request('/api/v1/public/no-such-thing?code=SECRET')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    // Logged without its query, which may hold an invite code.
    expect(JSON.stringify(warned.mock.calls)).not.toContain('SECRET')
  })

  test('a failure is a JSON 500, logged with its path, ray and member', async () => {
    // A route of its own, added before the app's first request builds its router.
    const failing = await createTestApi()
    failing.app.get('/api/v1/test-throws', () => {
      throw new Error('boom')
    })
    const member = await signedIn(failing)
    const res = await failing.request('/api/v1/test-throws', {
      as: member,
      headers: { 'cf-ray': '8f00aa-SIN' },
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    const [message, context, err] = logged.mock.calls[0] ?? []
    expect(message).toBe('request failed')
    expect(context).toEqual({
      method: 'GET',
      path: '/api/v1/test-throws',
      ray: '8f00aa-SIN',
      member: member.userId,
    })
    expect((err as Error).message).toBe('boom')
  })
})
