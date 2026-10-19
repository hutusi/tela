/** What a browser reports when something breaks (`POST /api/client-errors`): logged, kept nowhere. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ACTION_LIMITS } from '@tela/data'
import { CLIENT_ERROR_MAX_BYTES, STACK_MAX, withoutQueries } from '../src/routes/client-errors'
import { createTestApi, type TestApi } from './helpers'

let api: TestApi
const logged = spyOn(console, 'error').mockImplementation(() => {})
beforeEach(async () => {
  api = await createTestApi()
})
afterEach(() => logged.mockClear())

const report = (body: unknown, ip = '203.0.113.7') =>
  api.request('/api/client-errors', { body, headers: { 'cf-connecting-ip': ip } })

const lines = () =>
  logged.mock.calls.filter(([message]) => message === 'client error').map(([, line]) => line)

describe('a client error report', () => {
  test('is logged with its kind, message, stack, path and build, and answered 204', async () => {
    const res = await report({
      kind: 'boundary',
      message: "Cannot read properties of undefined (reading 'title')",
      stack: 'TypeError: …\n    at Reader (https://telaread.com/assets/index-abc.js:1:2345)',
      path: '/reading',
      build: 'abc123',
    })
    expect(res.status).toBe(204)
    expect(lines()).toEqual([
      {
        kind: 'boundary',
        message: "Cannot read properties of undefined (reading 'title')",
        stack: 'TypeError: …\n    at Reader (https://telaread.com/assets/index-abc.js:1:2345)',
        path: '/reading',
        build: 'abc123',
      },
    ])
  })

  test('never logs a query string, wherever it is', async () => {
    await report({
      kind: 'error',
      message: 'Failed to load https://telaread.com/join?code=SECRET-CODE',
      stack: 'at f (https://telaread.com/login?email=a@b.c&otp=123456:1:1)',
      path: '/join?code=SECRET-CODE',
    })
    const text = JSON.stringify(lines())
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('123456')
    expect(lines()[0]).toMatchObject({ path: '/join' })
    expect(withoutQueries('see /l/abc?x=1 and https://a.example/p?q#h')).toBe(
      'see /l/abc and https://a.example/p#h',
    )
  })

  test('cuts a stack to 4 KB', async () => {
    await report({ kind: 'rejection', message: 'boom', stack: 'x'.repeat(6000) })
    expect((lines()[0] as { stack: string }).stack).toHaveLength(STACK_MAX)
  })

  test('refuses what is not a report, and what is larger than one', async () => {
    expect((await report({ kind: 'nonsense', message: 'x' })).status).toBe(400)
    expect((await report({ kind: 'error' })).status).toBe(400)
    expect((await report(null)).status).toBe(400)
    const big = await report({ kind: 'error', message: 'x'.repeat(CLIENT_ERROR_MAX_BYTES) })
    expect(big.status).toBe(413)
    expect(lines()).toEqual([])
  })

  test('is counted per IP, thirty an hour, before anything is read', async () => {
    const { limit } = ACTION_LIMITS.clientError
    for (let i = 0; i < limit; i++) {
      expect((await report({ kind: 'error', message: `m${i}` })).status).toBe(204)
    }
    expect((await report({ kind: 'error', message: 'one more' })).status).toBe(429)
    expect((await report('not even json')).status).toBe(429)
    // Another browser is not held to that one's hour.
    expect((await report({ kind: 'error', message: 'elsewhere' }, '198.51.100.2')).status).toBe(204)
  })

  test('needs no session, and no member is named', async () => {
    await report({ kind: 'csp', message: 'img-src https://tracker.example/pixel.gif' })
    expect(Object.keys(lines()[0] as object).sort()).toEqual([
      'build',
      'kind',
      'message',
      'path',
      'stack',
    ])
  })
})
