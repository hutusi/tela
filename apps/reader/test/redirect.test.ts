/**
 * tela-redirect (ADR 0042): the old address and `www` go to the same path on telaread.com, and
 * `/sw.js` is the kill switch, never a redirect.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import redirect, { KILL_SW, ORIGIN } from '../redirect/index'

const at = (url: string, method = 'GET') => redirect.fetch(new Request(url, { method }))

describe('tela-redirect', () => {
  test('keeps the path and the query', () => {
    const res = at('https://tela.ainaive.com/@hutusi?tab=liked')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://telaread.com/@hutusi?tab=liked')
  })

  test('sends the www name, and an invite or a sign-in link, the same way', () => {
    expect(at('https://www.telaread.com/discover').headers.get('location')).toBe(
      `${ORIGIN}/discover`,
    )
    expect(at('https://tela.ainaive.com/').headers.get('location')).toBe(`${ORIGIN}/`)
    expect(at('https://tela.ainaive.com/join?code=WELCOME').headers.get('location')).toBe(
      `${ORIGIN}/join?code=WELCOME`,
    )
    expect(
      at('https://tela.ainaive.com/login?email=a%40b.c&otp=123456').headers.get('location'),
    ).toBe(`${ORIGIN}/login?email=a%40b.c&otp=123456`)
  })

  test('a write keeps its method', () => {
    expect(at('https://tela.ainaive.com/api/v1/sync', 'POST').status).toBe(308)
    expect(at('https://tela.ainaive.com/reading', 'HEAD').status).toBe(301)
  })

  test('/sw.js is the kill switch, answered where it was asked', async () => {
    const res = at('https://tela.ainaive.com/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toBe(KILL_SW)
  })

  test('its logs keep no query string, where an invite or sign-in code travels', () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'redirect', 'wrangler.jsonc'), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as { observability: { enabled?: boolean; redact_query_string?: boolean } }
    expect(config.observability.redact_query_string).toBe(true)
  })

  test('the kill switch is shell/kill-sw.js, code for code', () => {
    const file = readFileSync(new URL('../shell/kill-sw.js', import.meta.url), 'utf8')
    expect(KILL_SW).toBe(file.replace(/^\/\*\*[\s\S]*?\*\/\n/, ''))
    expect(KILL_SW).toContain('registration.unregister()')
  })
})
