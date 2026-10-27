/**
 * The consent page's questions and Settings → Connected apps (ADR 0064): which requests may be
 * shown at all (client, redirect, scope, PKCE, the app's standing and cap), what an answer sends
 * the browser to, and a member's connections, listed and ended.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { approveConnection, first } from '@tela/data'
import type { Connection, ConnectRequest } from '@tela/shared'
import { sql } from 'drizzle-orm'
import {
  approve,
  askConsent,
  authorizationParams,
  connect,
  decide,
  gateway,
  LISTENING,
  meStatus,
  pkce,
  registerApp,
  type TestApp,
} from './apps-helpers'
import { API_ORIGIN, createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let ann: SignedIn
let app: TestApp
let challenge: string

beforeEach(async () => {
  api = await createTestApi()
  ann = await signedIn(api, 'ann@x.test')
  app = await registerApp(api)
  challenge = (await pkce()).challenge
})

const json = async <T>(res: Response) => (await res.json()) as T
/** A body to compare with `toEqual`, untyped. */
const body = (res: Response): Promise<unknown> => res.json()

/** What the consent page is told for a request with `overrides`, as `ann` unless said. */
async function asked(
  overrides: Record<string, string | undefined> = {},
  options: { as?: SignedIn; app?: TestApp } = {},
) {
  const res = await askConsent(
    api,
    options.as ?? ann,
    authorizationParams(options.app ?? app, challenge, overrides),
  )
  const body = await json<ConnectRequest & { error?: string }>(res)
  return { status: res.status, body }
}

const errorOf = async (...args: Parameters<typeof asked>) => (await asked(...args)).body.error

describe('GET /api/v1/connect/request', () => {
  test('shows the app, what it asks, and where it returns to', async () => {
    const { status, body } = await asked()
    expect(status).toBe(200)
    expect(body).toEqual({
      app: {
        clientId: app.clientId,
        name: expect.stringMatching(/^App \d+$/),
        developer: 'Dev Ltd',
        homepageUrl: 'https://app.example',
        privacyUrl: 'https://app.example/privacy',
        status: 'approved',
      },
      scope: 'write',
      email: false,
      redirect: { kind: 'loopback', target: '127.0.0.1:53682' },
    })
  })

  test('a loopback redirect matches on any port, on its own host, path and query', async () => {
    for (const uri of [
      'http://127.0.0.1/callback',
      'http://127.0.0.1:1/callback',
      'http://127.0.0.1:65535/callback',
    ]) {
      expect((await asked({ redirect_uri: uri })).status).toBe(200)
    }
    for (const uri of [
      'http://127.0.0.1:8080/other',
      'http://127.0.0.1:8080/callback?x=1',
      'http://127.0.0.1:8080/callback#frag',
      'http://[::1]:8080/callback',
      'http://127.1:8080/callback',
      'http://user@127.0.0.1:8080/callback',
      'https://127.0.0.1:8080/callback',
      'http://127.0.0.1.evil.example/callback',
    ]) {
      expect([uri, await errorOf({ redirect_uri: uri })]).toEqual([uri, 'invalid_redirect'])
    }
    const v6 = await registerApp(api, { redirectUris: ['http://[::1]/cb'] })
    const { body } = await asked({ redirect_uri: 'http://[::1]:4000/cb' }, { app: v6 })
    expect(body.redirect).toEqual({ kind: 'loopback', target: '[::1]:4000' })
    expect(await errorOf({ redirect_uri: 'http://127.0.0.1:4000/cb' }, { app: v6 })).toBe(
      'invalid_redirect',
    )
  })

  test('localhost and web addresses are refused even when registered', async () => {
    const loose = await registerApp(api, {
      redirectUris: ['http://localhost/callback', 'https://app.example/callback', 'javascript:x'],
    })
    for (const uri of [
      'http://localhost/callback',
      'http://localhost:8080/callback',
      'https://app.example/callback',
      'javascript:x',
    ]) {
      expect([uri, await errorOf({ redirect_uri: uri }, { app: loose })]).toEqual([
        uri,
        'invalid_redirect',
      ])
    }
  })

  test('a registered custom scheme is allowed, exactly as registered', async () => {
    const native = await registerApp(api, { redirectUris: ['com.example.app:/oauth'] })
    const { status, body } = await asked(
      { redirect_uri: 'com.example.app:/oauth' },
      { app: native },
    )
    expect(status).toBe(200)
    expect(body.redirect).toEqual({ kind: 'scheme', target: 'com.example.app' })
    for (const uri of ['com.example.app:/other', 'com.evil.app:/oauth']) {
      expect(await errorOf({ redirect_uri: uri }, { app: native })).toBe('invalid_redirect')
    }
  })

  test('an unknown client, and a draft that is not the member’s, are no client at all', async () => {
    expect(await errorOf({ client_id: 'tela_app_nobody' })).toBe('invalid_client')
    expect(await errorOf({ client_id: undefined })).toBe('invalid_client')
    const bo = await signedIn(api, 'bo@x.test')
    const draft = await registerApp(api, { status: 'draft', ownerUserId: bo.userId })
    expect(await errorOf({}, { app: draft })).toBe('invalid_client')
    const mine = await asked({}, { as: bo, app: draft })
    expect(mine.status).toBe(200)
    expect(mine.body.app.status).toBe('draft')
    const deviceOnly = await registerApp(api, { grantTypes: ['device'] })
    expect(await errorOf({}, { app: deviceOnly })).toBe('invalid_client')
  })

  test('a suspended app is unavailable, once its client and redirect are known good', async () => {
    const cut = await registerApp(api, { status: 'suspended' })
    expect(await errorOf({}, { app: cut })).toBe('app_unavailable')
    expect(await errorOf({ redirect_uri: 'http://127.0.0.1/elsewhere' }, { app: cut })).toBe(
      'invalid_redirect',
    )
  })

  test('the response type, scope and PKCE are checked', async () => {
    expect(await errorOf({ response_type: 'token' })).toBe('unsupported_response_type')
    expect(await errorOf({ response_type: undefined })).toBe('invalid_request')
    for (const scope of ['', 'email', 'admin', 'read admin']) {
      expect([scope, await errorOf({ scope })]).toEqual([scope, 'invalid_scope'])
    }
    expect(await errorOf({ code_challenge_method: 'plain' })).toBe('invalid_request')
    expect(await errorOf({ code_challenge_method: undefined })).toBe('invalid_request')
    expect(await errorOf({ code_challenge: undefined })).toBe('invalid_request')
    expect(await errorOf({ code_challenge: 'too-short' })).toBe('invalid_request')
    expect(await errorOf({ state: 'x'.repeat(1025) })).toBe('invalid_request')
    expect((await asked({ state: undefined })).status).toBe(200)
  })

  test('a parameter given twice is refused', async () => {
    const query = `${new URLSearchParams(authorizationParams(app, challenge))}&scope=read`
    const res = await api.request(`/api/v1/connect/request?${query}`, { as: ann })
    expect(await res.json()).toEqual({ error: 'invalid_request' })
  })

  test("what is offered is held to the app's ceiling and its permission to ask for the address", async () => {
    const reader = await registerApp(api, { maxScope: 'read' })
    expect((await asked({ scope: 'write' }, { app: reader })).body.scope).toBe('read')
    expect((await asked({ scope: 'read write' })).body.scope).toBe('write')
    expect((await asked({ scope: 'read email' })).body.email).toBe(false)
    const mailer = await registerApp(api, { allowEmail: true })
    expect((await asked({ scope: 'read email' }, { app: mailer })).body).toMatchObject({
      scope: 'read',
      email: true,
    })
  })

  test('a full app refuses a new member, never one already connected', async () => {
    const small = await registerApp(api, { maxConnections: 1 })
    await connect(api, ann, small)
    const bo = await signedIn(api, 'bo@x.test')
    expect(await errorOf({}, { as: bo, app: small })).toBe('max_connections')
    expect((await asked({}, { app: small })).status).toBe(200)
    // And the write itself holds the cap, should two approvals race past the check.
    const raced = await approveConnection(api.db, {
      appId: small.id,
      userId: bo.userId,
      scope: 'read',
      email: false,
      redirectUri: LISTENING,
      codeChallenge: challenge,
      now: api.clock.now(),
    })
    expect(raced).toBeNull()
    expect(
      await first<unknown>(
        api.db,
        sql`select count(*) as n from app_grants where app_id = ${small.id}`,
      ),
    ).toEqual({ n: 1 })
  })

  test('a member already connected gets no code once the app is cut off, even racing the check', async () => {
    await connect(api, ann, app)
    await api.db.run(sql`update apps set status = 'suspended' where id = ${app.id}`)
    const raced = await approveConnection(api.db, {
      appId: app.id,
      userId: ann.userId,
      scope: 'read',
      email: false,
      redirectUri: LISTENING,
      codeChallenge: challenge,
      now: api.clock.now(),
    })
    expect(raced).toBeNull()
    expect(await first<unknown>(api.db, sql`select count(*) as n from app_codes`)).toEqual({ n: 1 })
  })
})

describe('POST /api/v1/connect/decide', () => {
  test('approving answers the redirect with a code, the state and the issuer', async () => {
    const res = await decide(api, ann, authorizationParams(app, challenge))
    expect(res.status).toBe(200)
    const { redirect } = await json<{ redirect: string }>(res)
    const url = new URL(redirect)
    expect(`${url.origin}${url.pathname}`).toBe(LISTENING)
    expect(url.searchParams.get('state')).toBe('xyz')
    expect(url.searchParams.get('iss')).toBe(API_ORIGIN)
    expect(url.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect([...url.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state'])
  })

  test('declining answers access_denied, and connects nothing', async () => {
    const res = await decide(api, ann, authorizationParams(app, challenge), {
      decision: 'decline',
    })
    const url = new URL((await json<{ redirect: string }>(res)).redirect)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      error: 'access_denied',
      state: 'xyz',
      iss: API_ORIGIN,
    })
    expect(await first<unknown>(api.db, sql`select count(*) as n from app_grants`)).toEqual({
      n: 0,
    })
    expect(await first<unknown>(api.db, sql`select count(*) as n from app_codes`)).toEqual({ n: 0 })
  })

  test('a custom scheme, or a redirect with its own query, keeps it', async () => {
    const native = await registerApp(api, {
      redirectUris: ['com.example.app:/oauth', 'http://127.0.0.1/cb?app=1'],
    })
    const scheme = await decide(
      api,
      ann,
      authorizationParams(native, challenge, { redirect_uri: 'com.example.app:/oauth' }),
    )
    const toScheme = (await json<{ redirect: string }>(scheme)).redirect
    expect(toScheme.startsWith('com.example.app:/oauth?')).toBe(true)
    expect(new URL(toScheme).searchParams.get('iss')).toBe(API_ORIGIN)
    const query = await decide(
      api,
      ann,
      authorizationParams(native, challenge, { redirect_uri: 'http://127.0.0.1:7/cb?app=1' }),
    )
    const toQuery = new URL((await json<{ redirect: string }>(query)).redirect)
    expect(toQuery.searchParams.get('app')).toBe('1')
    expect(toQuery.port).toBe('7')
  })

  test('the request is checked again, and an error is never a redirect', async () => {
    const res = await decide(
      api,
      ann,
      authorizationParams(app, challenge, { redirect_uri: 'http://localhost/callback' }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_redirect' })
    await api.db.run(sql`update apps set status = 'suspended' where id = ${app.id}`)
    const cut = await decide(api, ann, authorizationParams(app, challenge))
    expect(await cut.json()).toEqual({ error: 'app_unavailable' })
    expect(await first<unknown>(api.db, sql`select count(*) as n from app_codes`)).toEqual({ n: 0 })
  })

  test('the member may grant less than offered, never more', async () => {
    const params = authorizationParams(app, challenge, { scope: 'read' })
    expect(await body(await decide(api, ann, params, { scope_granted: 'write' }))).toEqual({
      error: 'invalid_scope',
    })
    expect(await body(await decide(api, ann, params, { email_granted: true }))).toEqual({
      error: 'invalid_scope',
    })
    expect(await body(await decide(api, ann, params, { decision: 'maybe' }))).toEqual({
      error: 'invalid_request',
    })
    const reader = await registerApp(api, { maxScope: 'read' })
    const capped = authorizationParams(reader, challenge, { scope: 'write' })
    expect(await body(await decide(api, ann, capped, { scope_granted: 'write' }))).toEqual({
      error: 'invalid_scope',
    })
    expect((await decide(api, ann, capped, { scope_granted: 'read' })).status).toBe(200)
  })

  test('always asks: each approval is a new code, and reconnecting updates the one connection', async () => {
    const one = await approve(api, ann, app, { scope: 'write' })
    const two = await approve(api, ann, app, { scope: 'read' })
    expect(one.code).not.toBe(two.code)
    expect(
      await api.db.all(sql`select scope, ended_at from app_grants where user_id = ${ann.userId}`),
    ).toEqual([{ scope: 'read', ended_at: null }])
  })

  test('answers are counted per member', async () => {
    const params = authorizationParams(app, challenge)
    for (let i = 0; i < 30; i++) {
      expect((await decide(api, ann, params, { decision: 'decline' })).status).toBe(200)
    }
    const limited = await decide(api, ann, params)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})

describe('Connected apps', () => {
  const list = async (who: SignedIn) =>
    (
      await json<{ connections: Connection[] }>(
        await api.request('/api/v1/connections', { as: who }),
      )
    ).connections

  test('lists what each app may do, when it was last used, and on how many devices', async () => {
    const created = api.clock.now()
    const one = await connect(api, ann, app)
    await connect(api, ann, app, { scope: 'read' })
    const [connection] = await list(ann)
    expect(connection).toEqual({
      id: expect.any(Number),
      app: {
        name: expect.stringMatching(/^App/),
        developer: 'Dev Ltd',
        homepageUrl: 'https://app.example',
      },
      scope: 'read',
      email: false,
      createdAt: created,
      lastUsedAt: null,
      devices: 2,
    })
    expect(await meStatus(api, one.access_token)).toBe(200)
    await gateway(api, '/oauth/revoke', {
      form: { token: one.refresh_token, client_id: app.clientId },
    })
    expect(await list(ann)).toMatchObject([{ lastUsedAt: created, devices: 1 }])
    // Only the member's own.
    const bo = await signedIn(api, 'bo@x.test')
    expect(await list(bo)).toEqual([])
    // A ceiling lowered is what the member is shown.
    await api.db.run(sql`update apps set max_scope = 'read' where id = ${app.id}`)
    expect(await list(ann)).toMatchObject([{ scope: 'read' }])
  })

  test('disconnecting ends the connection and every device under it', async () => {
    const one = await connect(api, ann, app)
    const two = await connect(api, ann, app)
    const [connection] = await list(ann)
    const bo = await signedIn(api, 'bo@x.test')
    const theirs = await api.request(`/api/v1/connections/${connection?.id}`, {
      as: bo,
      method: 'DELETE',
    })
    expect(theirs.status).toBe(404)
    expect(await meStatus(api, one.access_token)).toBe(200)

    const res = await api.request(`/api/v1/connections/${connection?.id}`, {
      as: ann,
      method: 'DELETE',
    })
    expect(await res.json()).toEqual({ ok: true })
    expect(await meStatus(api, one.access_token)).toBe(401)
    expect(await meStatus(api, two.access_token)).toBe(401)
    expect(await list(ann)).toEqual([])
    expect(
      await api.db.all(sql`select end_reason from app_tokens union all
        select end_reason from app_grants`),
    ).toEqual([
      { end_reason: 'disconnected' },
      { end_reason: 'disconnected' },
      { end_reason: 'disconnected' },
    ])
    const again = await api.request(`/api/v1/connections/${connection?.id}`, {
      as: ann,
      method: 'DELETE',
    })
    expect(again.status).toBe(404)
  })
})
