/**
 * The authorization server and the bearer boundary (ADR 0064): codes and PKCE, refresh rotation
 * and reuse, revocation, resolving a token (scope, email, standing, `apps.enabled`, rate limits),
 * and the two promises the app surface rests on: no internal `/api/*` route accepts a token, and
 * nothing under `/gateway` reads a cookie.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { first, sha256Hex } from '@tela/data'
import {
  ACCESS_TOKEN_PREFIX,
  API_VERSION_HEADER,
  AUTH_CODE_TTL_MS,
  REFRESH_GRACE_MS,
  REFRESH_IDLE_MS,
  REFRESH_TOKEN_PREFIX,
} from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { bearer, type GatewayEnv, requireScope } from '../src/gateway/auth'
import {
  approve,
  connect,
  exchange,
  gateway,
  meStatus,
  refresh,
  registerApp,
  type TestApp,
  type TokenAnswer,
  token,
} from './apps-helpers'
import {
  ADMIN_TOKEN,
  API_ORIGIN,
  createTestApi,
  ORIGIN,
  operatorSets,
  type SignedIn,
  signedIn,
  type TestApi,
} from './helpers'

let api: TestApi
let ann: SignedIn
let app: TestApp

beforeEach(async () => {
  api = await createTestApi()
  ann = await signedIn(api, 'ann@x.test')
  app = await registerApp(api)
})

const json = async <T>(res: Response) => (await res.json()) as T
/** A body to compare with `toEqual`, untyped. */
const body = (res: Response): Promise<unknown> => res.json()
const minutes = (n: number) => n * 60 * 1000

/** The device an access token was issued to: whether it ended, and why. */
const device = async (accessToken: string) =>
  first<{ ended_at: number | null; end_reason: string | null }>(
    api.db,
    sql`select ended_at, end_reason from app_tokens
      where access_hash = ${await sha256Hex(accessToken)}`,
  )

/** Every device's row for the app, oldest first. */
const devices = () =>
  api.db.all<{ id: number; ended_at: number | null; end_reason: string | null }>(
    sql`select id, ended_at, end_reason from app_tokens order by id`,
  )

/**
 * A route behind the bearer and `requireScope('write')`, as the v1 routes that write are: the
 * middleware tested on its own, since the v1 stub has no write route yet.
 */
function probe() {
  const routes = new Hono<GatewayEnv>()
  routes.use('*', bearer(api))
  routes.get('/read', (c) => c.json(c.get('app')))
  routes.post('/write', requireScope('write'), (c) => c.json(c.get('app')))
  return (method: 'GET' | 'POST', accessToken: string) =>
    routes.request(`${API_ORIGIN}/${method === 'GET' ? 'read' : 'write'}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}` },
    })
}

describe('the metadata (RFC 8414)', () => {
  test('names the issuer, the reader’s consent page and the endpoints on the API host', async () => {
    const res = await gateway(api, '/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    expect(res.headers.get(API_VERSION_HEADER)).toBe('1')
    expect(await res.json()).toMatchObject({
      issuer: API_ORIGIN,
      authorization_endpoint: `${ORIGIN}/connect`,
      token_endpoint: `${API_ORIGIN}/oauth/token`,
      revocation_endpoint: `${API_ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    })
  })
})

describe('the code exchange', () => {
  test('gives a device an access and a refresh token, kept only as hashes', async () => {
    const res = await exchange(api, app, await approve(api, ann, app))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    const tokens = await json<TokenAnswer>(res)
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'write' })
    expect(tokens.access_token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true)
    expect(tokens.refresh_token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true)

    const me = await gateway(api, '/v1/me', { token: tokens.access_token })
    expect(me.status).toBe(200)
    expect(me.headers.get(API_VERSION_HEADER)).toBe('1')
    const profile = await first<{ handle: string }>(
      api.db,
      sql`select handle from profiles where user_id = ${ann.userId}`,
    )
    expect(await me.json()).toMatchObject({ handle: profile?.handle, scope: 'write' })

    // Only hashes: neither token is anywhere in the database.
    const tables = await api.db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`,
    )
    for (const { name } of tables) {
      const rows = JSON.stringify(await api.db.all(sql.raw(`select * from "${name}"`)))
      expect(rows.includes(tokens.access_token)).toBe(false)
      expect(rows.includes(tokens.refresh_token)).toBe(false)
    }
    expect(
      await first<unknown>(
        api.db,
        sql`select 1 as found from app_tokens
        where access_hash = ${await sha256Hex(tokens.access_token)}
          and refresh_hash = ${await sha256Hex(tokens.refresh_token)}`,
      ),
    ).toEqual({ found: 1 })
  })

  test('refuses a wrong verifier without spending the code', async () => {
    const grant = await approve(api, ann, app)
    const wrong = await exchange(api, app, { ...grant, verifier: 'x'.repeat(43) })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: 'invalid_grant' })
    expect((await exchange(api, app, grant)).status).toBe(200)
  })

  test('refuses a replayed code, and ends the tokens it made', async () => {
    const grant = await approve(api, ann, app)
    const tokens = await json<TokenAnswer>(await exchange(api, app, grant))
    expect(await meStatus(api, tokens.access_token)).toBe(200)

    // A code shown without its verifier ends nothing: whoever saw it in a log cannot cut the app off.
    const seen = await exchange(api, app, { ...grant, verifier: 'y'.repeat(43) })
    expect(await seen.json()).toEqual({ error: 'invalid_grant' })
    expect(await meStatus(api, tokens.access_token)).toBe(200)

    const replay = await exchange(api, app, grant)
    expect(replay.status).toBe(400)
    expect(await replay.json()).toEqual({ error: 'invalid_grant' })
    expect(await meStatus(api, tokens.access_token)).toBe(401)
    expect((await refresh(api, app, tokens.refresh_token)).status).toBe(400)
    expect((await devices()).map((d) => d.end_reason)).toEqual(['reuse'])
  })

  test('refuses a code after its two minutes', async () => {
    const grant = await approve(api, ann, app)
    api.clock.advance(AUTH_CODE_TTL_MS)
    expect(await body(await exchange(api, app, grant))).toEqual({ error: 'invalid_grant' })
  })

  test('refuses another redirect, even another port of the same loopback one', async () => {
    const grant = await approve(api, ann, app)
    const other = await exchange(api, app, {
      ...grant,
      redirectUri: 'http://127.0.0.1:9999/callback',
    })
    expect(await body(other)).toEqual({ error: 'invalid_grant' })
    expect((await exchange(api, app, grant)).status).toBe(200)
  })

  test("refuses another app's client_id", async () => {
    const grant = await approve(api, ann, app)
    const other = await registerApp(api)
    expect(await body(await exchange(api, other, grant))).toEqual({ error: 'invalid_grant' })
    expect((await exchange(api, app, grant)).status).toBe(200)
  })

  test('refuses a code whose connection ended before it was exchanged', async () => {
    const grant = await approve(api, ann, app)
    const [connection] = (
      await json<{ connections: { id: number }[] }>(
        await api.request('/api/v1/connections', { as: ann }),
      )
    ).connections
    await api.request(`/api/v1/connections/${connection?.id}`, { as: ann, method: 'DELETE' })
    expect(await body(await exchange(api, app, grant))).toEqual({ error: 'invalid_grant' })

    // Connected again, the old code does not join the new connection.
    api.clock.advance(1000)
    const again = await approve(api, ann, app)
    expect(await body(await exchange(api, app, grant))).toEqual({ error: 'invalid_grant' })
    expect((await exchange(api, app, again)).status).toBe(200)
  })

  test('refuses a code once the app is cut off, or the member suspended', async () => {
    const grant = await approve(api, ann, app)
    await api.db.run(sql`update apps set status = 'suspended' where id = ${app.id}`)
    expect(await body(await exchange(api, app, grant))).toMatchObject({
      error: 'unauthorized_client',
    })
    await api.db.run(sql`update apps set status = 'approved' where id = ${app.id}`)
    await api.db.run(sql`update profiles set suspended_at = 1 where user_id = ${ann.userId}`)
    expect(await body(await exchange(api, app, grant))).toEqual({ error: 'invalid_grant' })
  })

  test('answers RFC 6749’s refusals for a malformed request', async () => {
    const grant = await approve(api, ann, app)
    const base = {
      grant_type: 'authorization_code',
      code: grant.code,
      redirect_uri: grant.redirectUri,
      client_id: app.clientId,
      code_verifier: grant.verifier,
    }
    const refusal = async (res: Response) => [
      res.status,
      (await json<{ error: string }>(res)).error,
    ]
    expect(await refusal(await token(api, { ...base, grant_type: 'password' }))).toEqual([
      400,
      'unsupported_grant_type',
    ])
    expect(await refusal(await token(api, { ...base, code_verifier: 'short' }))).toEqual([
      400,
      'invalid_request',
    ])
    const { client_id: _, ...noClient } = base
    expect(await refusal(await token(api, noClient))).toEqual([400, 'invalid_request'])
    expect(await refusal(await token(api, { ...base, client_id: 'tela_app_nobody' }))).toEqual([
      401,
      'invalid_client',
    ])
    // JSON is not a form, and a field twice is not allowed (§3.1).
    const asJson = await gateway(api, '/oauth/token', {
      body: JSON.stringify(base),
      headers: { 'content-type': 'application/json' },
    })
    expect(await refusal(asJson)).toEqual([400, 'invalid_request'])
    const twice = await gateway(api, '/oauth/token', {
      body: `${new URLSearchParams(base)}&code=${grant.code}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(await refusal(twice)).toEqual([400, 'invalid_request'])
    // None of those spent the code.
    expect((await exchange(api, app, grant)).status).toBe(200)
  })

  test('counts token requests per app and IP', async () => {
    const answers: number[] = []
    for (let i = 0; i < 31; i++) {
      answers.push((await refresh(api, app, 'tela_rt_nothing')).status)
    }
    expect(answers.slice(0, 30).every((s) => s === 400)).toBe(true)
    const limited = await refresh(api, app, 'tela_rt_nothing')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another IP has its own count; another minute starts over.
    expect(
      (
        await token(
          api,
          { grant_type: 'refresh_token', refresh_token: 'x', client_id: app.clientId },
          '198.51.100.1',
        )
      ).status,
    ).toBe(400)
    api.clock.advance(minutes(1))
    expect((await refresh(api, app, 'tela_rt_nothing')).status).toBe(400)
  })
})

describe('refresh rotation', () => {
  let first_: TokenAnswer
  beforeEach(async () => {
    first_ = await connect(api, ann, app)
  })

  test('swaps both tokens, and the old pair stops working', async () => {
    const res = await refresh(api, app, first_.refresh_token)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const next = await json<TokenAnswer>(res)
    expect(next.access_token).not.toBe(first_.access_token)
    expect(next.refresh_token).not.toBe(first_.refresh_token)
    expect(await meStatus(api, first_.access_token)).toBe(401)
    expect(await meStatus(api, next.access_token)).toBe(200)
    // One device all along, with the spent hash kept.
    expect(await devices()).toHaveLength(1)
    expect(
      await first<unknown>(
        api.db,
        sql`select 1 as kept from app_refresh_spent
        where hash = ${await sha256Hex(first_.refresh_token)}`,
      ),
    ).toEqual({ kept: 1 })
  })

  test('ends the device when a spent token comes back after its replacement was used', async () => {
    const next = await json<TokenAnswer>(await refresh(api, app, first_.refresh_token))
    expect(await meStatus(api, next.access_token)).toBe(200)
    const reused = await refresh(api, app, first_.refresh_token)
    expect(await body(reused)).toEqual({ error: 'invalid_grant' })
    expect(await meStatus(api, next.access_token)).toBe(401)
    expect((await refresh(api, app, next.refresh_token)).status).toBe(400)
    expect(await device(next.access_token)).toMatchObject({ end_reason: 'reuse' })
  })

  test('swaps a spent token again within the grace while its replacement is unused', async () => {
    // The answer to this swap was lost on the way: the app never saw `lost`.
    const lost = await json<TokenAnswer>(await refresh(api, app, first_.refresh_token))
    api.clock.advance(REFRESH_GRACE_MS - 1000)
    const retried = await refresh(api, app, first_.refresh_token)
    expect(retried.status).toBe(200)
    const kept = await json<TokenAnswer>(retried)
    expect(await meStatus(api, lost.access_token)).toBe(401)
    expect(await meStatus(api, kept.access_token)).toBe(200)
    expect((await devices()).map((d) => d.ended_at)).toEqual([null])
    // Used now, so the next swap is from `kept` only.
    expect((await refresh(api, app, kept.refresh_token)).status).toBe(200)
  })

  test('only the token swapped away last is a lost answer: an earlier one is reuse', async () => {
    const second = await json<TokenAnswer>(await refresh(api, app, first_.refresh_token))
    api.clock.advance(10_000)
    // Swapped again, its new pair still unused: the first token is two swaps old.
    await refresh(api, app, second.refresh_token)
    api.clock.advance(10_000)
    expect(await body(await refresh(api, app, first_.refresh_token))).toEqual({
      error: 'invalid_grant',
    })
    expect((await devices()).map((d) => d.end_reason)).toEqual(['reuse'])
  })

  test('ends the device when a spent token comes back after the grace', async () => {
    await refresh(api, app, first_.refresh_token)
    api.clock.advance(REFRESH_GRACE_MS)
    expect(await body(await refresh(api, app, first_.refresh_token))).toEqual({
      error: 'invalid_grant',
    })
    expect((await devices()).map((d) => d.end_reason)).toEqual(['reuse'])
  })

  test('two swaps racing with one token leave one working pair and the device live', async () => {
    const [one, two] = await Promise.all([
      refresh(api, app, first_.refresh_token),
      refresh(api, app, first_.refresh_token),
    ])
    expect([one.status, two.status]).toEqual([200, 200])
    const pairs = [await json<TokenAnswer>(one), await json<TokenAnswer>(two)]
    const working = []
    for (const pair of pairs)
      if ((await meStatus(api, pair.access_token)) === 200) working.push(pair)
    expect(working).toHaveLength(1)
    expect((await devices()).map((d) => d.ended_at)).toEqual([null])
    expect((await refresh(api, app, working[0]?.refresh_token ?? '')).status).toBe(200)
  })

  test('an attacker inside the window loses the device as soon as the app acts', async () => {
    // The app swaps; an attacker holding the spent token swaps it inside the grace, before the
    // app has used its new pair, and is answered as a lost answer would be.
    const app_ = await json<TokenAnswer>(await refresh(api, app, first_.refresh_token))
    const stolen = await refresh(api, app, first_.refresh_token)
    expect(stolen.status).toBe(200)
    const attacker = await json<TokenAnswer>(stolen)
    expect(await meStatus(api, attacker.access_token)).toBe(200)
    // The app's pair was replaced; its refresh, now spent and with the attacker's pair used, is
    // reuse: the device ends, and the attacker's tokens with it.
    expect(await meStatus(api, app_.access_token)).toBe(401)
    expect(await body(await refresh(api, app, app_.refresh_token))).toEqual({
      error: 'invalid_grant',
    })
    expect(await meStatus(api, attacker.access_token)).toBe(401)
    expect((await refresh(api, app, attacker.refresh_token)).status).toBe(400)
    expect((await devices()).map((d) => d.end_reason)).toEqual(['reuse'])
  })

  test('refuses a token unused for 90 days, ending nothing', async () => {
    api.clock.advance(REFRESH_IDLE_MS)
    expect(await body(await refresh(api, app, first_.refresh_token))).toEqual({
      error: 'invalid_grant',
    })
    expect((await devices()).map((d) => d.ended_at)).toEqual([null])
  })

  test("refuses another app's client_id, ending nothing", async () => {
    const other = await registerApp(api)
    expect(await body(await refresh(api, other, first_.refresh_token))).toEqual({
      error: 'invalid_grant',
    })
    expect((await refresh(api, app, first_.refresh_token)).status).toBe(200)
  })

  test('an expired access token is refreshed, not refused for good', async () => {
    api.clock.advance(minutes(60))
    expect(await meStatus(api, first_.access_token)).toBe(401)
    const next = await json<TokenAnswer>(await refresh(api, app, first_.refresh_token))
    expect(await meStatus(api, next.access_token)).toBe(200)
  })
})

describe('revocation (RFC 7009)', () => {
  test('either token ends the device', async () => {
    for (const which of ['access_token', 'refresh_token'] as const) {
      const tokens = await connect(api, ann, app)
      const res = await gateway(api, '/oauth/revoke', {
        form: { token: tokens[which], client_id: app.clientId },
      })
      expect(res.status).toBe(200)
      expect(await meStatus(api, tokens.access_token)).toBe(401)
      expect((await refresh(api, app, tokens.refresh_token)).status).toBe(400)
    }
    expect((await devices()).map((d) => d.end_reason)).toEqual(['revoked', 'revoked'])
  })

  test("answers 200 for a token that is not the client's, or not a token, and ends nothing", async () => {
    const tokens = await connect(api, ann, app)
    const other = await registerApp(api)
    for (const form of [
      { token: tokens.access_token, client_id: other.clientId },
      { token: 'tela_at_nothing', client_id: app.clientId },
    ]) {
      expect((await gateway(api, '/oauth/revoke', { form })).status).toBe(200)
    }
    expect(await meStatus(api, tokens.access_token)).toBe(200)
  })
})

describe('a bearer token', () => {
  test('no token, or a bad one, is 401 with an RFC 6750 challenge', async () => {
    const none = await gateway(api, '/v1/me')
    expect(none.status).toBe(401)
    expect(await none.json()).toEqual({ error: 'invalid_token' })
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="tela"')
    expect(none.headers.get(API_VERSION_HEADER)).toBe('1')
    for (const header of ['Bearer tela_at_nothing', 'Basic Zm9vOmJhcg==', 'Bearer a b']) {
      const bad = await gateway(api, '/v1/me', { headers: { authorization: header } })
      expect(bad.status).toBe(401)
      expect(bad.headers.get('www-authenticate')).toBe('Bearer realm="tela", error="invalid_token"')
    }
  })

  test('a read token on a route that writes is 403 insufficient_scope', async () => {
    const tokens = await connect(api, ann, app, { scope: 'read' })
    expect(tokens.scope).toBe('read')
    const call = probe()
    expect((await call('GET', tokens.access_token)).status).toBe(200)
    const write = await call('POST', tokens.access_token)
    expect(write.status).toBe(403)
    expect(await write.json()).toEqual({ error: 'insufficient_scope' })
    expect(write.headers.get('www-authenticate')).toBe(
      'Bearer realm="tela", error="insufficient_scope", scope="write"',
    )
  })

  test('the member may grant read when write was asked', async () => {
    const tokens = await connect(api, ann, app, { scope: 'write', granted: 'read' })
    expect(tokens.scope).toBe('read')
    expect((await probe()('POST', tokens.access_token)).status).toBe(403)
  })

  test("lowering the app's ceiling narrows live tokens at once", async () => {
    const tokens = await connect(api, ann, app)
    const call = probe()
    expect((await call('POST', tokens.access_token)).status).toBe(200)
    await api.db.run(sql`update apps set max_scope = 'read' where id = ${app.id}`)
    expect((await call('POST', tokens.access_token)).status).toBe(403)
    expect(await body(await gateway(api, '/v1/me', { token: tokens.access_token }))).toMatchObject({
      scope: 'read',
    })
  })

  test('connecting again at Read only lowers every device, and Settings says the same', async () => {
    const laptop = await connect(api, ann, app)
    const call = probe()
    expect((await call('POST', laptop.access_token)).status).toBe(200)
    // The member connects the app again from another computer, granting less.
    await connect(api, ann, app, { scope: 'write', granted: 'read' })
    expect((await call('POST', laptop.access_token)).status).toBe(403)
    expect(await body(await gateway(api, '/v1/me', { token: laptop.access_token }))).toMatchObject({
      scope: 'read',
    })
  })

  test('acts for the member and app, never as an admin, and sees the address only when both allow', async () => {
    await api.db.run(sql`update profiles set is_admin = 1 where user_id = ${ann.userId}`)
    const mailer = await registerApp(api, { allowEmail: true })
    const tokens = await connect(api, ann, mailer, { scope: 'write email', email: true })
    expect(tokens.scope).toBe('write email')
    const principal = await json<Record<string, unknown>>(await probe()('GET', tokens.access_token))
    expect(principal).toMatchObject({
      userId: ann.userId,
      appId: mailer.id,
      clientId: mailer.clientId,
      scope: 'write',
      email: true,
    })
    expect(Object.keys(principal).sort()).toEqual(
      ['appId', 'clientId', 'email', 'grantId', 'scope', 'tokenId', 'userId'].sort(),
    )
    // The operator taking the permission away reaches the live token.
    await api.db.run(sql`update apps set allow_email = 0 where id = ${mailer.id}`)
    expect(await body(await probe()('GET', tokens.access_token))).toMatchObject({ email: false })
  })

  test('is refused while its app is cut off, told to keep its tokens, and works again once restored', async () => {
    const tokens = await connect(api, ann, app)
    await api.db.run(sql`update apps set status = 'suspended' where id = ${app.id}`)
    const me = await gateway(api, '/v1/me', { token: tokens.access_token })
    expect([me.status, await body(me)]).toEqual([403, { error: 'app_suspended' }])
    const refused = await refresh(api, app, tokens.refresh_token)
    expect(refused.status).toBe(400)
    expect(await body(refused)).toMatchObject({ error: 'unauthorized_client' })
    await api.db.run(sql`update apps set status = 'approved' where id = ${app.id}`)
    expect(await meStatus(api, tokens.access_token)).toBe(200)
    // The refresh token the cut-off answer told it to keep still swaps.
    expect((await refresh(api, app, tokens.refresh_token)).status).toBe(200)
  })

  test("a draft app's token works for its owner only", async () => {
    const draft = await registerApp(api, { status: 'draft', ownerUserId: ann.userId })
    const tokens = await connect(api, ann, draft)
    expect(await meStatus(api, tokens.access_token)).toBe(200)
    // Handed to someone else, the draft is no longer theirs: refused.
    const bo = await signedIn(api, 'bo@x.test')
    await api.db.run(sql`update apps set owner_user_id = ${bo.userId} where id = ${draft.id}`)
    expect(await meStatus(api, tokens.access_token)).toBe(401)
  })

  test('every call answers 503 while apps are stopped, the token endpoint too', async () => {
    const tokens = await connect(api, ann, app)
    await operatorSets(api, 'apps.enabled', 'off')
    for (const res of [
      await gateway(api, '/v1/me', { token: tokens.access_token }),
      await refresh(api, app, tokens.refresh_token),
    ]) {
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'apps_paused' })
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    await operatorSets(api, 'apps.enabled', 'on')
    expect(await meStatus(api, tokens.access_token)).toBe(200)
    // Nothing was counted or swapped while stopped.
    expect((await refresh(api, app, tokens.refresh_token)).status).toBe(200)
  })

  test("is held to the app's limit per member, and starts over each minute", async () => {
    const limited = await registerApp(api, { perMemberPerMin: 2 })
    const tokens = await connect(api, ann, limited)
    expect(await meStatus(api, tokens.access_token)).toBe(200)
    expect(await meStatus(api, tokens.access_token)).toBe(200)
    const over = await gateway(api, '/v1/me', { token: tokens.access_token })
    expect(over.status).toBe(429)
    expect(await over.json()).toEqual({ error: 'rate_limited' })
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another member of the same app has their own count.
    const bo = await signedIn(api, 'bo@x.test')
    const theirs = await connect(api, bo, limited)
    expect(await meStatus(api, theirs.access_token)).toBe(200)
    api.clock.advance(minutes(1))
    expect(await meStatus(api, tokens.access_token)).toBe(200)
    // Counted as consumeLimit keys it, so closing the account finds the member's counts.
    expect(
      await api.db.all(
        sql`select key from action_limits where key like 'appMember.%' order by key`,
      ),
    ).toContainEqual({ key: `appMember.${limited.id}:${ann.userId}` })
  })

  test("is held to the app's limit in all", async () => {
    const limited = await registerApp(api, { perAppPerMin: 3 })
    const bo = await signedIn(api, 'bo@x.test')
    const annTokens = await connect(api, ann, limited)
    const boTokens = await connect(api, bo, limited)
    expect(await meStatus(api, annTokens.access_token)).toBe(200)
    expect(await meStatus(api, boTokens.access_token)).toBe(200)
    expect(await meStatus(api, annTokens.access_token)).toBe(200)
    expect(await meStatus(api, boTokens.access_token)).toBe(429)
  })

  test("one member's flood, refused for their own limit, does not spend the app's share", async () => {
    const shared = await registerApp(api, { perMemberPerMin: 2, perAppPerMin: 4 })
    const bo = await signedIn(api, 'bo@x.test')
    const flooder = await connect(api, ann, shared)
    const other = await connect(api, bo, shared)
    const statuses = []
    for (let i = 0; i < 10; i++) statuses.push(await meStatus(api, flooder.access_token))
    expect(statuses).toEqual([200, 200, 429, 429, 429, 429, 429, 429, 429, 429])
    // Only ann's two allowed calls counted toward the app: bo still has the other two.
    expect(await meStatus(api, other.access_token)).toBe(200)
    expect(await meStatus(api, other.access_token)).toBe(200)
  })

  test('a limit of 0 allows nothing', async () => {
    const stopped = await registerApp(api, { perMemberPerMin: 0 })
    const tokens = await connect(api, ann, stopped)
    expect(await meStatus(api, tokens.access_token)).toBe(429)
  })

  test('marks the device used once, and when, at most hourly, on the device and the connection', async () => {
    const tokens = await connect(api, ann, app)
    const used = () =>
      first<{ pristine: number; token_used: number | null; grant_used: number | null }>(
        api.db,
        sql`select t.pristine, t.last_used_at as token_used, g.last_used_at as grant_used
          from app_tokens t join app_grants g on g.id = t.grant_id`,
      )
    expect(await used()).toEqual({ pristine: 1, token_used: null, grant_used: null })
    const at = api.clock.now()
    await meStatus(api, tokens.access_token)
    expect(await used()).toEqual({ pristine: 0, token_used: at, grant_used: at })
    api.clock.advance(minutes(30))
    await meStatus(api, tokens.access_token)
    expect(await used()).toEqual({ pristine: 0, token_used: at, grant_used: at })
    // A swap is not a use: the new pair is unused, and the stamps stay.
    api.clock.advance(minutes(29))
    const next = await json<TokenAnswer>(await refresh(api, app, tokens.refresh_token))
    expect(await used()).toEqual({ pristine: 1, token_used: at, grant_used: at })
    api.clock.advance(minutes(2))
    await meStatus(api, next.access_token)
    const later = api.clock.now()
    expect(await used()).toEqual({ pristine: 0, token_used: later, grant_used: later })
  })
})

describe('the boundary', () => {
  /** A concrete path for a route pattern: each parameter given a value its pattern accepts. */
  const concrete = (path: string) =>
    path
      .replace(/:[A-Za-z]+\{([^}]*)\}/g, (_m, pattern: string) =>
        /^[a-z|]+$/.test(pattern) ? (pattern.split('|')[0] ?? 'x') : '1',
      )
      .replace(/:[A-Za-z]+/g, '1')
      .replace(/\*/g, 'x')

  test('no internal /api route takes a bearer token, even an admin’s', async () => {
    await api.db.run(sql`update profiles set is_admin = 1 where user_id = ${ann.userId}`)
    const tokens = await connect(api, ann, app)
    const sessions = async () =>
      (await first<{ n: number }>(api.db, sql`select count(*) as n from session`))?.n
    const before = await sessions()
    const routes = api.app.routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/'))
    expect(routes.length).toBeGreaterThan(100)
    let member = 0
    for (const route of routes) {
      if (route.path.startsWith('/api/test/')) continue
      const path = concrete(route.path)
      const res = await api.app.request(`${ORIGIN}${path}`, {
        method: route.method,
        headers: { origin: ORIGIN, authorization: `Bearer ${tokens.access_token}` },
      })
      const label = `${route.method} ${route.path}`
      const isPublic = path.startsWith('/api/v1/public/') || path === '/api/v1/join'
      if (path.startsWith('/api/v1/') && !isPublic) {
        member++
        expect([label, res.status]).toEqual([label, 401])
        expect(await res.json()).toEqual({ error: 'unauthorized' })
      } else if (path.startsWith('/api/admin/')) {
        // The operator's token routes compare the header with ADMIN_TOKEN: an app's is not it.
        expect([label, res.status]).toEqual([label, 403])
      } else if (path === '/api/auth/get-session') {
        // better-auth's bearer plugin would make this the member's session; it is never enabled.
        expect(await res.json()).toBeNull()
      }
    }
    expect(member).toBeGreaterThan(50)
    // Signing out with only a token ended no session.
    expect(await sessions()).toBe(before)
    // And the admin token still works where it should, so the 403s above refused something real.
    const operator = await api.request('/api/admin/settings', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(operator.status).toBe(200)
  })

  test('nothing under /gateway reads a cookie', async () => {
    // A member's session alone reaches nothing.
    const cookieOnly = await gateway(api, '/v1/me', { headers: { cookie: ann.cookie } })
    expect(cookieOnly.status).toBe(401)
    // With a token, the token says who: the cookie of someone else changes nothing.
    const bo = await signedIn(api, 'bo@x.test')
    const tokens = await connect(api, bo, app)
    const both = await gateway(api, '/v1/me', {
      token: tokens.access_token,
      headers: { cookie: ann.cookie },
    })
    const handles = await api.db.all<{ user_id: string; handle: string }>(
      sql`select user_id, handle from profiles`,
    )
    const boHandle = handles.find((h) => h.user_id === bo.userId)?.handle
    expect(await both.json()).toMatchObject({ handle: boHandle, scope: 'write' })
  })

  test('every answer under /gateway carries the API version, a 404 too', async () => {
    const missing = await gateway(api, '/v1/nothing-here')
    expect(missing.headers.get(API_VERSION_HEADER)).toBe('1')
    const outside = await gateway(api, '/nothing')
    expect(outside.status).toBe(404)
    expect(outside.headers.get(API_VERSION_HEADER)).toBe('1')
    expect(outside.headers.get('cache-control')).toBe('no-store')
  })

  test('is outside /api, which the reader forwards: /api/gateway is no route', async () => {
    const res = await api.request('/api/gateway/oauth/token', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
