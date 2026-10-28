/**
 * The consent page's and Settings → Connected apps' calls to tela-api (ADR 0064), against the
 * answers `GET /api/v1/connect/request`, `POST /api/v1/connect/decide` and `/api/v1/connections`
 * give. What the page draws is read field by field, and the browser is sent only to the app.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import type { ConnectDecision } from '@tela/shared'
import {
  askConnect,
  decideConnect,
  disconnect,
  listConnections,
  readConnections,
  readConnectRequest,
  requestParams,
  requestQuery,
  sameApp,
} from '../src/lib/apps-api'
import { bindApi } from '../src/store/api'

const saved = globalThis.fetch
afterAll(() => {
  globalThis.fetch = saved
})
afterEach(() => {
  bindApi({ member: () => null, accountChanged() {}, upgrade() {} })
})

type Seen = { path: string; method: string; body: unknown; member: string | null }
function answer(status: number, body: unknown) {
  const calls: Seen[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({
      path: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      member: new Headers(init?.headers).get('x-tela-member'),
    })
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status })
  }) as typeof fetch
  bindApi({ member: () => 'member-1', accountChanged() {}, upgrade() {} })
  return calls
}

const SEARCH =
  '?response_type=code&client_id=tela_app_abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback' +
  '&scope=write+email&state=xyz&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
  '&code_challenge_method=S256'

const REQUEST = {
  app: {
    clientId: 'tela_app_abc',
    name: 'Loom',
    developer: 'Loom Labs',
    homepageUrl: 'https://loom.example',
    privacyUrl: 'https://loom.example/privacy',
    status: 'approved',
    developerHandle: 'loomlabs',
    reviewed: false,
  },
  scope: 'write',
  email: true,
  redirect: { kind: 'loopback', target: '127.0.0.1:53682' },
}

describe('the authorization request', () => {
  test('is passed on by its own names only, with none of what the sheet adds', () => {
    const query = new URLSearchParams(requestQuery(`${SEARCH}&door=login&via=google&error=x&hl=fr`))
    expect([...query.keys()].sort()).toEqual([
      'client_id',
      'code_challenge',
      'code_challenge_method',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ])
    expect(query.get('redirect_uri')).toBe('http://127.0.0.1:53682/callback')
    // A name given twice stays twice, for tela-api to refuse (RFC 6749 §3.1).
    expect(
      new URLSearchParams(requestQuery('?client_id=a&client_id=b')).getAll('client_id'),
    ).toEqual(['a', 'b'])
  })

  test('is answered with every field it came with, and no state where it had none', () => {
    expect(requestParams(SEARCH)).toEqual({
      client_id: 'tela_app_abc',
      redirect_uri: 'http://127.0.0.1:53682/callback',
      response_type: 'code',
      scope: 'write email',
      state: 'xyz',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })
    expect(requestParams('?client_id=x')).not.toHaveProperty('state')
  })
})

describe('what tela-api says of a request', () => {
  test('is read as it was sent, and asked for as a member call', async () => {
    const calls = answer(200, REQUEST)
    expect(await askConnect(SEARCH)).toEqual({ ok: true, request: REQUEST as never })
    expect(calls[0]?.path.startsWith('/api/v1/connect/request?')).toBe(true)
    expect(calls[0]?.member).toBe('member-1')
  })

  test('a refusal is its reason, and anything else a failure; never a redirect', async () => {
    answer(400, { error: 'invalid_redirect' })
    expect(await askConnect(SEARCH)).toEqual({ ok: false, error: 'invalid_redirect' })
    answer(400, { error: 'something_new' })
    expect(await askConnect(SEARCH)).toEqual({ ok: false, error: 'failed' })
    answer(500, null)
    expect(await askConnect(SEARCH)).toEqual({ ok: false, error: 'failed' })
    answer(200, { app: { name: 'Loom' } })
    expect(await askConnect(SEARCH)).toEqual({ ok: false, error: 'failed' })
  })

  test('a link that is not https is drawn as no link', () => {
    const read = readConnectRequest({
      ...REQUEST,
      app: { ...REQUEST.app, homepageUrl: 'javascript:alert(1)', privacyUrl: 'http://x.example' },
    })
    expect(read?.app.homepageUrl).toBeNull()
    expect(read?.app.privacyUrl).toBeNull()
    expect(readConnectRequest({ ...REQUEST, scope: 'admin' })).toBeNull()
    expect(
      readConnectRequest({ ...REQUEST, app: { ...REQUEST.app, status: 'suspended' } }),
    ).toBeNull()
  })
})

describe('the answer', () => {
  const decision: ConnectDecision = {
    ...requestParams(SEARCH),
    decision: 'approve',
    scope_granted: 'read',
    email_granted: false,
  }

  test('posts the decision and gives back where the app listens', async () => {
    const back =
      'http://127.0.0.1:53682/callback?code=c0de&state=xyz&iss=https%3A%2F%2Fapi.telaread.com'
    const calls = answer(200, { redirect: back })
    expect(await decideConnect(decision)).toEqual({ ok: true, redirect: back })
    expect(calls[0]).toMatchObject({
      path: '/api/v1/connect/decide',
      method: 'POST',
      body: decision,
    })
  })

  test('never follows an address that is not the app’s', async () => {
    for (const redirect of [
      'javascript:alert(1)',
      'https://evil.example/callback?code=c0de',
      'http://evil.example:53682/callback',
      'com.other.app:/cb',
    ]) {
      answer(200, { redirect })
      expect({ redirect, answer: await decideConnect(decision) }).toEqual({
        redirect,
        answer: { ok: false, error: 'failed' },
      })
    }
    answer(403, { error: 'app_unavailable' })
    expect(await decideConnect(decision)).toEqual({ ok: false, error: 'app_unavailable' })
  })

  test('an app’s own scheme, and a loopback address on any port, are the app', () => {
    expect(sameApp('com.loom.app:/oauth?code=1', 'com.loom.app:/oauth')).toBe(true)
    expect(sameApp('http://127.0.0.1:9/cb?code=1', 'http://127.0.0.1:53682/cb')).toBe(true)
    expect(sameApp('http://[::1]:9/cb', 'http://[::1]:7/cb')).toBe(true)
    expect(sameApp('http://127.0.0.1/cb', 'http://[::1]/cb')).toBe(false)
    expect(sameApp('not a url', 'http://127.0.0.1/cb')).toBe(false)
  })
})

describe('connected apps', () => {
  const CONNECTION = {
    id: 7,
    app: {
      name: 'Loom',
      developer: 'Loom Labs',
      homepageUrl: 'https://loom.example',
      clientId: 'tela_app_loom',
      reviewed: false,
      developerHandle: 'loomlabs',
    },
    scope: 'read',
    email: false,
    createdAt: 1_760_000_000_000,
    lastUsedAt: null,
    devices: 2,
  }

  test('from a tela-api before self-serve apps read as reviewed, with no developer handle', () => {
    const { clientId: _c, reviewed: _r, developerHandle: _d, ...older } = CONNECTION.app
    expect(readConnections({ connections: [{ ...CONNECTION, app: older }] })?.[0]?.app).toEqual({
      ...older,
      clientId: '',
      reviewed: true,
      developerHandle: null,
    })
  })

  test('are listed as tela-api sends them, each read on its own', async () => {
    const calls = answer(200, { connections: [CONNECTION, { id: 'x' }] })
    expect(await listConnections()).toEqual([CONNECTION as never])
    expect(calls[0]).toMatchObject({ path: '/api/v1/connections', member: 'member-1' })
    expect(readConnections({ nope: [] })).toBeNull()
    expect(
      readConnections({
        connections: [{ ...CONNECTION, app: { ...CONNECTION.app, homepageUrl: 'ftp://x' } }],
      })?.[0]?.app.homepageUrl,
    ).toBeNull()
  })

  test('one is disconnected by its id', async () => {
    const calls = answer(204, null)
    expect(await disconnect(7)).toBe(true)
    expect(calls[0]).toMatchObject({ path: '/api/v1/connections/7', method: 'DELETE' })
    answer(404, { error: 'not_found' })
    expect(await disconnect(7)).toBe(false)
  })
})
