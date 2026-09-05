import { describe, expect, test } from 'bun:test'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { config as proxyConfig } from '../middleware'
import { refreshSessionCookies } from './session-refresh'

const CONFIG = { url: 'https://tela.supabase.co', anonKey: 'anon' }
const COOKIE = 'sb-tela-auth-token'
const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'ada@example.com',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
}

const b64url = (s: string) => Buffer.from(s).toString('base64url')

/** An HS256-shaped token: getClaims then verifies it through /auth/v1/user, no JWKS needed. */
function jwt(expiresAt: number, marker: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      sub: USER.id,
      email: USER.email,
      role: 'authenticated',
      aud: 'authenticated',
      exp: expiresAt,
      iat: expiresAt - 3600,
      session_id: marker,
    }),
  )
  return `${header}.${payload}.${b64url(marker)}`
}

function session(expiresAt: number, marker: string) {
  return {
    access_token: jwt(expiresAt, marker),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: `refresh-${marker}`,
    user: USER,
  }
}

const encode = (value: unknown) => `base64-${b64url(JSON.stringify(value))}`
const decode = (cookie: string) =>
  JSON.parse(Buffer.from(cookie.replace(/^base64-/, ''), 'base64url').toString()) as {
    access_token: string
    refresh_token: string
  }

function fakeSupabase(calls: string[], next: ReturnType<typeof session>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(new URL(url).pathname + new URL(url).search)
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) return Response.json(next)
    if (url.includes('/auth/v1/user')) return Response.json(USER)
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

function requestWith(value: string) {
  return new NextRequest('https://tela.test/reading?feed=3', {
    headers: { cookie: `${COOKIE}=${value}; locale=en` },
  })
}

describe('refreshSessionCookies', () => {
  test('refreshes an expired session and forwards the new cookie to the render and the browser', async () => {
    const calls: string[] = []
    const now = Math.floor(Date.now() / 1000)
    const fresh = session(now + 3600, 'new')
    const request = requestWith(encode(session(now - 60, 'old')))
    const response = await refreshSessionCookies(request, CONFIG, {
      fetch: fakeSupabase(calls, fresh),
    })

    expect(calls).toContain('/auth/v1/token?grant_type=refresh_token')
    const rotated = response.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`))
    expect(rotated).toBeDefined()
    const raw = (rotated as string).split(';')[0]?.slice(COOKIE.length + 1) ?? ''
    const value = decode(decodeURIComponent(raw))
    expect(value.access_token).toBe(fresh.access_token)
    expect(value.refresh_token).toBe('refresh-new')
    // The render downstream sees the rotated cookie too, and unrelated cookies survive.
    const forwarded = response.headers.get('x-middleware-request-cookie') ?? ''
    expect(forwarded).toContain(`${COOKIE}=`)
    expect(forwarded).toContain('locale=en')
    expect(decode(request.cookies.get(COOKIE)?.value ?? '').access_token).toBe(fresh.access_token)
  })

  test('leaves a valid session alone: no refresh call, no Set-Cookie', async () => {
    const calls: string[] = []
    const now = Math.floor(Date.now() / 1000)
    const current = session(now + 3600, 'current')
    const request = requestWith(encode(current))
    const response = await refreshSessionCookies(request, CONFIG, {
      fetch: fakeSupabase(calls, session(now + 7200, 'unexpected')),
    })
    expect(calls.some((c) => c.includes('grant_type=refresh_token'))).toBe(false)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(decode(request.cookies.get(COOKIE)?.value ?? '').access_token).toBe(current.access_token)
  })

  test('does nothing for a visitor without a session', async () => {
    const calls: string[] = []
    const request = new NextRequest('https://tela.test/discover')
    const response = await refreshSessionCookies(request, CONFIG, {
      fetch: fakeSupabase(calls, session(0, 'none')),
    })
    expect(calls).toEqual([])
    expect(response.headers.getSetCookie()).toEqual([])
  })
})

describe('proxy matcher', () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config: proxyConfig, url })
  test('covers pages and actions, skips assets and session-free routes', () => {
    for (const url of [
      '/',
      '/reading',
      '/reading?feed=3',
      '/discover',
      '/settings/opml',
      '/s/12',
      '/login',
    ]) {
      expect({ url, matches: matches(url) }).toEqual({ url, matches: true })
    }
    for (const url of [
      '/img?u=abc&s=def',
      '/api/health',
      '/api/websub/12',
      '/auth/callback?code=x',
      '/_next/static/chunks/main.js',
      '/favicon.ico',
      '/robots.txt',
      '/icon.png',
    ]) {
      expect({ url, matches: matches(url) }).toEqual({ url, matches: false })
    }
  })
})
