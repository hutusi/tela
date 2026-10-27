import { beforeEach, describe, expect, test } from 'bun:test'
import type { EdgeCache, OpensDecision } from '@tela/edge'
import { memoryBlobs } from '@tela/platform/portable'
import { TOKEN_ACCEPTED_HEADER } from '@tela/shared'
import {
  createGateway,
  DECISION_TTL_MS,
  PUBLIC_TTL_MS,
  TOKEN_TTL_MS,
  takesNoToken,
} from '../src/gateway'

const ORIGIN = 'https://api.telaread.test'
const TOKEN = `tela_at_${'x'.repeat(43)}`
const OTHER_TOKEN = `tela_at_${'y'.repeat(43)}`
const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const NOW = Date.UTC(2026, 9, 27, 12)
const MIDNIGHT = Date.UTC(2026, 9, 28)
const REFUSED = { error: 'post_limit', limit: 100, resetsAt: MIDNIGHT } as const

function memoryCache(): EdgeCache {
  const store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>()
  return {
    async match(key) {
      const hit = store.get(key.url)
      return hit ? new Response(hit.body.slice(0), hit.init) : undefined
    },
    async put(key, response) {
      store.set(key.url, {
        body: await response.arrayBuffer(),
        init: { status: response.status, headers: response.headers },
      })
    },
    async delete(key) {
      return store.delete(key.url)
    },
  }
}

type Call = {
  method: string
  path: string
  authorization: string | null
  cookie: string | null
  body: string
}

let now: number
let calls: Call[]
/** What tela-api decides for a token's keys; any other answer by `opensStatus`. */
let decide: (token: string, keys: string[]) => OpensDecision
let opensStatus: number
/** tela-api's answer to everything forwarded. */
let answer: (call: Call) => Response
let fetched: string[]
let gateway: ReturnType<typeof createGateway>

beforeEach(async () => {
  now = NOW
  calls = []
  fetched = []
  opensStatus = 200
  decide = (_token, keys) => ({ allowed: keys, refused: {} })
  answer = (call) =>
    Response.json({ path: call.path }, { headers: { 'set-cookie': 'tela.session_token=nope' } })
  const blobs = memoryBlobs()
  for (const k of [A, B]) {
    await blobs.put(
      `c/${k}.json`,
      JSON.stringify({ key: k, images: [`https://img.example/${k.slice(0, 1)}.png`] }),
    )
  }
  await blobs.put(`t/${A}/fr/0123abcd.json`, JSON.stringify({ lang: 'fr' }))
  gateway = createGateway({
    blobs,
    cache: memoryCache(),
    now: () => now,
    fetchImage: async (url) => {
      fetched.push(url)
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    },
    api: {
      fetch: async (req) => {
        const url = new URL(req.url)
        const call: Call = {
          method: req.method,
          path: url.pathname + url.search,
          authorization: req.headers.get('authorization'),
          cookie: req.headers.get('cookie'),
          body: req.method === 'GET' ? '' : await req.text(),
        }
        calls.push(call)
        if (url.pathname === '/gateway/opens') {
          if (opensStatus !== 200) {
            return Response.json(
              { error: opensStatus === 401 ? 'invalid_token' : 'rate_limited' },
              {
                status: opensStatus,
                headers: {
                  'www-authenticate': 'Bearer error="invalid_token"',
                  'retry-after': '7',
                },
              },
            )
          }
          const token = (call.authorization ?? '').slice('Bearer '.length)
          return accepted(
            Response.json(decide(token, (JSON.parse(call.body) as { keys: string[] }).keys)),
          )
        }
        const res = answer(call)
        // As tela-api's bearer middleware does: a route that resolved a token says so; one that
        // takes no token (`/meta`, the OpenAPI document, OAuth) never does.
        return res.ok && !takesNoToken(url.pathname.slice('/gateway'.length)) && call.authorization
          ? accepted(res)
          : res
      },
    },
  })
})

function accepted(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set(TOKEN_ACCEPTED_HEADER, '1')
  return out
}

const ask = (
  path: string,
  init: {
    token?: string | null
    headers?: Record<string, string>
    method?: string
    body?: string
  } = {},
) => {
  const token = init.token === undefined ? TOKEN : init.token
  return gateway.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
  )
}
const decisions = () => calls.filter((c) => c.path === '/gateway/opens')

describe('every request and answer', () => {
  test('answers noindex, HSTS and the version, sets no cookie, and robots.txt disallows all', async () => {
    const robots = await ask('/robots.txt', { token: null })
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n')
    for (const res of [robots, await ask('/v1/sync'), await ask(`/o/c/${A}.json`)]) {
      expect(res.headers.get('x-robots-tag')).toBe('noindex')
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
      expect(res.headers.get('tela-api-version')).toBe('1')
      expect(res.headers.getSetCookie()).toEqual([])
    }
  })

  test('drops every cookie before tela-api sees the request', async () => {
    await ask('/v1/sync?cursor=x', { headers: { cookie: 'tela.session_token=abc' } })
    await ask(`/o/c/${A}.json`, { headers: { cookie: 'tela.session_token=abc' } })
    await ask('/meta', { token: null, headers: { cookie: 'tela.session_token=abc' } })
    expect(calls.map((c) => c.cookie)).toEqual([null, null, null])
  })

  test('refuses any credential that is not an access token, except where none is taken', async () => {
    for (const authorization of [
      'Basic dXNlcjpwYXNz',
      'Bearer tela_rt_abcdefabcdefabcdefabcdef',
      `Bearer ${TOKEN}!`,
      'Bearer',
    ]) {
      for (const path of ['/v1/sync', `/o/c/${A}.json`, '/v1/discover/week?lang=en']) {
        const res = await ask(path, { token: null, headers: { authorization } })
        expect([authorization, path, res.status]).toEqual([authorization, path, 401])
        expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
        expect(await res.json()).toEqual({ error: 'invalid_token' })
      }
    }
    expect(calls).toEqual([])
    // What tela-api reads itself: its metadata, OAuth's endpoints (form-encoded, no bearer).
    for (const path of [
      '/meta',
      '/v1/openapi.json',
      '/.well-known/oauth-authorization-server',
      '/oauth/token',
    ]) {
      const res = await ask(path, { token: null, headers: { authorization: 'Basic eDp5' } })
      expect([path, res.status]).toEqual([path, 200])
    }
    expect(calls.map((c) => [c.path, c.authorization])).toEqual([
      ['/gateway/meta', 'Basic eDp5'],
      ['/gateway/v1/openapi.json', 'Basic eDp5'],
      ['/gateway/.well-known/oauth-authorization-server', 'Basic eDp5'],
      ['/gateway/oauth/token', 'Basic eDp5'],
    ])
  })

  test("everything else is tela-api's, under /gateway, method, query and body as sent", async () => {
    const res = await ask('/v1/mutations?x=1', {
      method: 'POST',
      body: '{"mutations":[]}',
      headers: { 'content-type': 'application/json' },
    })
    expect(await res.json()).toEqual({ path: '/gateway/v1/mutations?x=1' })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/gateway/v1/mutations?x=1',
        authorization: `Bearer ${TOKEN}`,
        cookie: null,
        body: '{"mutations":[]}',
      },
    ])
    // No token at all: tela-api says what that route needs.
    await ask('/v1/me', { token: null })
    expect(calls.at(-1)?.authorization).toBe(null)
  })

  test('forwards only the API, its metadata and OAuth: anything else is a 404 here', async () => {
    // `/opens` is this edge's own question to tela-api, with the app's token: an app asking it
    // directly would count posts against the member's day without fetching them.
    for (const [method, path] of [
      ['POST', '/opens'],
      ['POST', '/gateway/opens'],
      ['GET', '/'],
      ['GET', '/nothing'],
      ['GET', '/v1'],
      ['GET', '/api/v1/me'],
      ['GET', '/.well-known/openid-configuration'],
    ] as const) {
      const res = await ask(path, {
        method,
        ...(method === 'POST' ? { body: '{"keys":[]}' } : {}),
      })
      expect([method, path, res.status]).toEqual([method, path, 404])
      expect(await res.json()).toEqual({ error: 'not_found' })
      expect(res.headers.get('tela-api-version')).toBe('1')
    }
    expect(calls).toEqual([])
  })

  test('a tela-api that cannot be reached is a 503 to retry', async () => {
    answer = () => {
      throw new Error('binding down')
    }
    const res = await ask('/v1/sync')
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
  })
})

describe('content at the edge (ADR 0066)', () => {
  test('needs a token, asks no tela-api without one, and takes only GET', async () => {
    const res = await ask(`/o/c/${A}.json`, { token: null })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect((await ask(`/o/c/${A}.json`, { method: 'POST', body: '{}' })).status).toBe(405)
    expect(calls).toEqual([])
  })

  test('an object or image allowed is served, and the decision is kept a minute per token', async () => {
    const object = await ask(`/o/c/${A}.json`)
    expect(object.status).toBe(200)
    expect(object.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect((await ask(`/o/t/${A}/fr/0123abcd.json`)).status).toBe(200)
    expect((await ask(`/img/${A}/0`)).status).toBe(200)
    expect(decisions()).toHaveLength(1)
    expect(decisions()[0]?.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(decisions()[0]?.body ?? '')).toEqual({ keys: [A] })
    // Another token is another app or member: asked apart.
    await ask(`/img/${A}/0`, { token: OTHER_TOKEN })
    expect(decisions()).toHaveLength(2)
    // A minute on, an app cut off meanwhile is refused its images too.
    now = NOW + DECISION_TTL_MS
    opensStatus = 401
    const cut = await ask(`/img/${A}/0`)
    expect(cut.status).toBe(401)
    expect(cut.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
    expect(decisions()).toHaveLength(3)
  })

  test("tela-api's refusals of the token are passed through as they are", async () => {
    opensStatus = 429
    const res = await ask(`/o/c/${A}.json`)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    opensStatus = 500
    expect((await ask(`/o/c/${A}.json`)).status).toBe(503)
  })

  test("a post past the day's limit is a 429 and is never served from the colo", async () => {
    await ask(`/o/c/${B}.json`, { token: OTHER_TOKEN }) // now in the colo
    await ask(`/img/${B}/0`, { token: OTHER_TOKEN })
    decide = (token, keys) =>
      token === TOKEN
        ? { allowed: keys.filter((k) => k !== B), refused: { [B]: REFUSED } }
        : { allowed: keys, refused: {} }
    for (const path of [`/o/c/${B}.json`, `/img/${B}/0`]) {
      const res = await ask(path)
      expect([path, res.status]).toEqual([path, 429])
      expect(res.headers.get('retry-after')).toBe(String((MIDNIGHT - NOW) / 1000))
      expect(await res.json()).toEqual(REFUSED)
    }
    // A refusal is not kept: the next ask is tela-api's again.
    expect(decisions().filter((c) => c.authorization === `Bearer ${TOKEN}`)).toHaveLength(2)
    expect(fetched).toHaveLength(1)
  })

  test('/v1/bodies is a bundle of up to 25, with what it refused listed apart', async () => {
    decide = (_token, keys) => ({ allowed: keys.filter((k) => k !== B), refused: { [B]: REFUSED } })
    const res = await ask(`/v1/bodies?keys=${A},${B}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { objects: Record<string, unknown>; refused: unknown }
    expect(Object.keys(body.objects)).toEqual([A])
    expect(body.refused).toEqual({ [B]: REFUSED })
    const many = Array.from({ length: 26 }, (_, i) => i.toString(16).padStart(32, '0'))
    for (const keys of ['', 'nothex', `${A},x`, many.join(',')]) {
      const bad = await ask(`/v1/bodies?keys=${keys}`)
      expect([keys.slice(0, 10), bad.status]).toEqual([keys.slice(0, 10), 400])
      expect(await bad.json()).toEqual({ error: 'invalid_request' })
    }
  })
})

describe('/meta', () => {
  const metas = () => calls.filter((c) => c.path === '/gateway/meta')

  test('is kept five minutes per colo, for every caller, token or none', async () => {
    let n = 0
    answer = (call) =>
      Response.json(
        { path: call.path, n: ++n },
        { headers: { 'cache-control': 'public, max-age=300' } },
      )
    const first = await ask('/meta', { token: null })
    expect(await first.json()).toEqual({ path: '/gateway/meta', n: 1 })
    for (const token of [null, TOKEN, OTHER_TOKEN]) {
      const res = await ask('/meta', { token })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ path: '/gateway/meta', n: 1 })
      expect(res.headers.get('tela-api-version')).toBe('1')
      expect(res.headers.get('x-tela-until')).toBe(null)
    }
    expect(metas()).toHaveLength(1)
    now = NOW + PUBLIC_TTL_MS
    expect(((await (await ask('/meta')).json()) as { n: number }).n).toBe(2)
    expect(metas()).toHaveLength(2)
  })

  test('is not kept when tela-api fails or marks it as nobody’s to keep', async () => {
    answer = () => Response.json({ error: 'unavailable' }, { status: 503 })
    await ask('/meta')
    await ask('/meta')
    answer = (call) =>
      Response.json({ path: call.path }, { headers: { 'cache-control': 'no-store' } })
    await ask('/meta')
    await ask('/meta')
    expect(metas()).toHaveLength(4)
  })
})

describe('the public side', () => {
  const page = '/v1/discover/articles?page=2&lang=en'
  const forwarded = () => calls.filter((c) => c.path.startsWith('/gateway/v1/discover/'))

  test('is kept five minutes by path and query, for a token tela-api accepted in the last minute', async () => {
    answer = (call) => Response.json({ path: call.path, n: forwarded().length })
    expect(await (await ask(page)).json()).toEqual({ path: `/gateway${page}`, n: 1 })
    // The same answer, whatever the order of the query, and from the colo.
    expect(await (await ask('/v1/discover/articles?lang=en&page=2')).json()).toEqual({
      path: `/gateway${page}`,
      n: 1,
    })
    expect(forwarded()).toHaveLength(1)
    // A token not yet seen goes to tela-api, whose answer renews the copy; then from the copy.
    await ask(page, { token: OTHER_TOKEN })
    expect(forwarded()).toHaveLength(2)
    expect((await (await ask(page, { token: OTHER_TOKEN })).json()) as object).toEqual({
      path: `/gateway${page}`,
      n: 2,
    })
    expect(forwarded()).toHaveLength(2)
    // A minute on, the token is asked about again; five minutes on, so is the page.
    now = NOW + TOKEN_TTL_MS
    await ask(page)
    expect(forwarded()).toHaveLength(3)
    now = NOW + PUBLIC_TTL_MS
    expect(((await (await ask(page)).json()) as { n: number }).n).toBe(4)
  })

  test('a made-up token is never taken as good from a route that takes none', async () => {
    await ask(page)
    expect(forwarded()).toHaveLength(1)
    // The OpenAPI document answers 200 to anyone; that proves nothing about the token.
    expect((await ask('/v1/openapi.json', { token: OTHER_TOKEN })).status).toBe(200)
    await ask(page, { token: OTHER_TOKEN })
    expect(forwarded()).toHaveLength(2)
  })

  test('an escaped path is refused before anything classifies it', async () => {
    for (const path of ['/v1/%6fpenapi.json', '/v1/discover/%61rticles?lang=en', '/%6deta']) {
      const res = await ask(path, { token: OTHER_TOKEN })
      expect([path, res.status]).toEqual([path, 404])
    }
    expect(calls).toEqual([])
    // And tela-api's word never reaches an app.
    const res = await ask(page)
    expect(res.headers.get(TOKEN_ACCEPTED_HEADER)).toBeNull()
  })

  test('a token tela-api refused is forgotten, and gets nothing the colo kept', async () => {
    await ask(page)
    answer = () => Response.json({ error: 'invalid_token' }, { status: 401 })
    await ask('/v1/sync')
    expect((await ask(page)).status).toBe(401)
  })

  test("what names no language, or tela-api marks as someone's, is never kept", async () => {
    await ask('/v1/discover/week')
    await ask('/v1/discover/week')
    answer = (call) =>
      Response.json({ path: call.path }, { headers: { 'cache-control': 'private, no-store' } })
    await ask('/v1/sites/1?lang=fr')
    await ask('/v1/sites/1?lang=fr')
    expect(calls.map((c) => c.path)).toEqual([
      '/gateway/v1/discover/week',
      '/gateway/v1/discover/week',
      '/gateway/v1/sites/1?lang=fr',
      '/gateway/v1/sites/1?lang=fr',
    ])
  })
})
