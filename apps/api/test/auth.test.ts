import { describe, expect, test } from 'bun:test'
import { first } from '@tela/data'
import { sql } from 'drizzle-orm'
import { PER_ADDRESS } from '../src/auth'
import { ADMIN_TOKEN, codeFor, cookiesOf, createTestApi, signedIn } from './helpers'

const invite = (
  api: Awaited<ReturnType<typeof createTestApi>>,
  email: string,
  token = ADMIN_TOKEN,
) =>
  api.request('/api/admin/invite', {
    body: { email },
    headers: { authorization: `Bearer ${token}` },
  })

describe('invites', () => {
  test('need the admin token', async () => {
    const api = await createTestApi()
    expect((await invite(api, 'a@x.test', 'wrong')).status).toBe(403)
    expect(
      (await createTestApi({ adminToken: undefined }).then((a) => invite(a, 'a@x.test'))).status,
    ).toBe(403)
    expect(api.mail.outbox).toHaveLength(0)
  })

  test('create the account and its profile, and mail an invitation with the code first', async () => {
    const api = await createTestApi()
    const res = await invite(api, ' New@X.test ')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ created: true })
    const [mail] = api.mail.outbox
    expect(mail?.to).toBe('new@x.test')
    expect(mail?.subject).toContain('invited')
    expect(mail?.text).toMatch(/^\d{6}$/m)
    expect(mail?.text).toContain(`/login?email=new%40x.test&otp=${codeFor(api, 'new@x.test')}`)
    const profile = await first<{ handle: string; seq: number }>(
      api.db,
      sql`select handle, seq from profiles`,
    )
    expect(profile?.handle).toMatch(/^u_[0-9a-f]{10}$/)
    expect(profile?.seq).toBeGreaterThan(0)
  })

  test('inviting an existing member only mails a fresh code', async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    const again = await invite(api, 'a@x.test')
    expect(await again.json()).toMatchObject({ created: false })
    expect(api.mail.outbox).toHaveLength(2)
    expect(await first<{ n: number }>(api.db, sql`select count(*) as n from user`)).toEqual({
      n: 1,
    })
  })
})

describe('signing in with a code', () => {
  test('gives a session that tela-api accepts, and the next mail is a plain sign-in', async () => {
    const api = await createTestApi()
    const { cookie } = await signedIn(api, 'reader@x.test')
    expect(cookie).toContain('tela.session_token=')
    expect(cookie).toContain('tela.session_data=')
    const me = await api.request('/api/v1/me', { cookie })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      email: 'reader@x.test',
      profile: { handle: expect.any(String) },
    })
    await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: 'reader@x.test', type: 'sign-in' },
    })
    expect(api.mail.outbox.at(-1)?.subject).toContain('sign-in code')
  })

  test('registration is closed: an unknown address gets the same answer and no mail', async () => {
    const api = await createTestApi()
    await invite(api, 'known@x.test')
    const known = await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: 'known@x.test', type: 'sign-in' },
    })
    const unknown = await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: 'stranger@x.test', type: 'sign-in' },
    })
    expect(unknown.status).toBe(known.status)
    expect(await unknown.json()).toEqual(await known.json())
    expect(api.mail.outbox.filter((m) => m.to === 'stranger@x.test')).toHaveLength(0)
    const signIn = await api.request('/api/auth/sign-in/email-otp', {
      body: { email: 'stranger@x.test', otp: '123456' },
    })
    expect(signIn.status).not.toBe(200)
    expect(await first<{ n: number }>(api.db, sql`select count(*) as n from user`)).toEqual({
      n: 1,
    })
  })

  // Each try from its own IP, so better-auth's per-IP rate limit below stays out of the way.
  const tryCode = (
    api: Awaited<ReturnType<typeof createTestApi>>,
    otp: string,
    ip: string,
    email = 'a@x.test',
  ) =>
    api.request('/api/auth/sign-in/email-otp', {
      body: { email, otp },
      headers: { 'cf-connecting-ip': ip },
    })
  const askCode = (api: Awaited<ReturnType<typeof createTestApi>>, email: string, ip: string) =>
    api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email, type: 'sign-in' },
      headers: { 'cf-connecting-ip': ip },
    })

  test('three wrong codes use the code up', async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    const code = codeFor(api, 'a@x.test')
    const wrong = code === '000000' ? '111111' : '000000'
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      expect((await tryCode(api, wrong, ip)).status).toBe(400)
    }
    const late = await tryCode(api, code, '198.51.100.4')
    expect(late.status).not.toBe(429)
    expect(late.status).not.toBe(200)
  })

  test("tries are rate limited per reader's address, taken from cf-connecting-ip", async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    for (let i = 0; i < 3; i++)
      expect((await tryCode(api, '000000', '203.0.113.9')).status).toBe(400)
    expect((await tryCode(api, '000000', '203.0.113.9')).status).toBe(429)
    // Another reader behind the same Cloudflare edge is not throttled with them.
    expect((await tryCode(api, '000000', '203.0.113.10')).status).not.toBe(429)
  })

  test('one address is tried ten times an hour at most, however many IPs try it', async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    for (let i = 1; i <= 10; i++)
      expect((await tryCode(api, '000000', `198.51.100.${i}`)).status).not.toBe(429)
    // A fresh code, from the operator (tela-api's own call, which is not counted), is no help: the
    // eleventh try is refused from an IP that never tried, right code or not.
    await invite(api, 'a@x.test')
    const code = codeFor(api, 'a@x.test')
    const refused = await tryCode(api, code, '198.51.100.11', 'A@X.test')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-retry-after')).toBe('3600')
    // An address with no account is refused the same way, and so is a client over the per-IP
    // limit: the answer tells none of the three apart.
    for (let i = 1; i <= 11; i++)
      await tryCode(api, '000000', `198.51.100.${20 + i}`, 'stranger@x.test')
    const stranger = await tryCode(api, '000000', '198.51.100.40', 'stranger@x.test')
    expect(stranger.status).toBe(429)
    for (let i = 0; i < 3; i++) await tryCode(api, '000000', '203.0.113.9', 'b@x.test')
    const perIp = await tryCode(api, '000000', '203.0.113.9', 'b@x.test')
    expect(perIp.status).toBe(429)
    const answer = await refused.json()
    expect(await stranger.json()).toEqual(answer)
    expect(await perIp.json()).toEqual(answer)
    // Another address from the eleventh IP is tried as usual, and the next hour starts afresh.
    expect((await tryCode(api, '000000', '198.51.100.11', 'c@x.test')).status).toBe(400)
    api.clock.advance(60 * 60 * 1000)
    expect((await tryCode(api, code, '198.51.100.12')).status).toBe(200)
  })

  test('one address is mailed five codes an hour at most, however many IPs ask', async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    await invite(api, 'b@x.test')
    for (let i = 1; i <= 5; i++)
      expect((await askCode(api, 'a@x.test', `198.51.100.${i}`)).status).toBe(200)
    const mailed = api.mail.outbox.length
    const refused = await askCode(api, 'A@X.test', '198.51.100.6')
    expect(refused.status).toBe(429)
    expect(api.mail.outbox).toHaveLength(mailed)
    // The same for an address no one has, so the limit says nothing about who is a member.
    for (let i = 1; i <= 5; i++) await askCode(api, 'stranger@x.test', `198.51.100.${10 + i}`)
    const stranger = await askCode(api, 'stranger@x.test', '198.51.100.16')
    expect(stranger.status).toBe(429)
    expect(await stranger.json()).toEqual(await refused.json())
    // Another address from the same IP is mailed, and the operator's invite still goes out.
    expect((await askCode(api, 'b@x.test', '198.51.100.6')).status).toBe(200)
    expect((await invite(api, 'a@x.test')).status).toBe(200)
    expect(api.mail.outbox).toHaveLength(mailed + 2)
  })

  // A right reset code gives the account a password, passwords on or not, so it is as good as a
  // sign-in code to someone guessing: every way to mail or check a code shares the address's counts.
  const authCall = (
    api: Awaited<ReturnType<typeof createTestApi>>,
    path: string,
    body: Record<string, string>,
    ip: string,
  ) => api.request(`/api/auth/${path}`, { body, headers: { 'cf-connecting-ip': ip } })

  test('a reset code is checked against the same ten tries an hour as a sign-in code', async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    let n = 0
    const ip = () => `198.51.100.${++n}`
    const reset = (email: string, otp: string) =>
      authCall(
        api,
        'email-otp/reset-password',
        { email, otp, password: 'a-guessed-password' },
        ip(),
      )
    // Every endpoint that checks a code, in turn, each try from an IP that never tried.
    const checks = [
      (email: string) => tryCode(api, '000000', ip(), email),
      (email: string) => reset(email, '000000'),
      (email: string) =>
        authCall(
          api,
          'email-otp/check-verification-otp',
          { email, type: 'sign-in', otp: '000000' },
          ip(),
        ),
      (email: string) => authCall(api, 'email-otp/verify-email', { email, otp: '000000' }, ip()),
    ]
    const tenTries = [...checks, ...checks, ...checks].slice(0, 10)
    for (const check of tenTries) expect((await check('a@x.test')).status).not.toBe(429)
    // A reset code asked for now (one of the address's five sends) is refused, right as it is, and
    // the account gets no password. So is a try on every other endpoint that checks a code.
    const asked = await authCall(
      api,
      'email-otp/request-password-reset',
      { email: 'a@x.test' },
      ip(),
    )
    expect(asked.status).toBe(200)
    const refused = await reset('A@X.test', codeFor(api, 'a@x.test'))
    expect(refused.status).toBe(429)
    expect(
      await first(api.db, sql`select 1 as x from account where provider_id = 'credential'`),
    ).toBeUndefined()
    for (const check of checks) expect((await check('a@x.test')).status).toBe(429)
    // An address with no account is refused the same way.
    for (const check of tenTries) await check('stranger@x.test')
    const stranger = await reset('stranger@x.test', '000000')
    expect(stranger.status).toBe(429)
    expect(await stranger.json()).toEqual(await refused.json())
  })

  test('a reset code is mailed from the same five an hour as a sign-in code', async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    let n = 0
    const ip = () => `198.51.100.${++n}`
    const askReset = (email: string) =>
      authCall(api, 'email-otp/request-password-reset', { email }, ip())
    // Every endpoint that mails a code, and every kind of code they mail.
    const sends = [
      (email: string) => askCode(api, email, ip()),
      (email: string) =>
        authCall(api, 'email-otp/send-verification-otp', { email, type: 'forget-password' }, ip()),
      (email: string) =>
        authCall(
          api,
          'email-otp/send-verification-otp',
          { email, type: 'email-verification' },
          ip(),
        ),
      askReset,
      (email: string) => authCall(api, 'forget-password/email-otp', { email }, ip()),
    ]
    for (const send of sends) expect((await send('a@x.test')).status).toBe(200)
    // The invitation, then the five.
    expect(api.mail.outbox).toHaveLength(6)
    for (const send of sends) expect((await send('A@X.test')).status).toBe(429)
    expect(api.mail.outbox).toHaveLength(6)
    // The same for an address no one has, so the limit says nothing about who is a member.
    for (const send of sends) await send('stranger@x.test')
    const stranger = await askReset('stranger@x.test')
    expect(stranger.status).toBe(429)
    expect(await stranger.json()).toEqual(await (await askReset('a@x.test')).json())
  })

  test('every endpoint that mails or checks a code is counted per address', async () => {
    const api = await createTestApi()
    const plugin = api.auth.options.plugins.find((p) => p.id === 'email-otp')
    const paths = Object.values(plugin?.endpoints ?? {}).flatMap((e) => (e.path ? [e.path] : []))
    // A better-auth upgrade that adds a way to mail or check a code fails here until it is counted,
    // and one that drops an endpoint fails here until the map drops it. Server-only endpoints have
    // no path, and the change-email pair needs a session and is off.
    expect(paths.filter((p) => !PER_ADDRESS.has(p)).sort()).toEqual([
      '/email-otp/change-email',
      '/email-otp/request-email-change',
    ])
    expect([...PER_ADDRESS.keys()].filter((p) => !paths.includes(p))).toEqual([])
  })

  test('codes are stored hashed, never as sent', async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    const code = codeFor(api, 'a@x.test')
    const rows = await api.db.all<{ value: string }>(sql`select value from verification`)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.value).not.toContain(code)
  })

  test('a request without a session is refused', async () => {
    const api = await createTestApi()
    expect((await api.request('/api/v1/me')).status).toBe(401)
    expect((await api.request('/api/v1/me', { cookie: 'tela.session_token=forged' })).status).toBe(
      401,
    )
  })

  test('signing out ends the session', async () => {
    const api = await createTestApi()
    const { cookie } = await signedIn(api)
    const out = await api.request('/api/auth/sign-out', { body: {}, cookie })
    expect(out.status).toBe(200)
    expect((await api.request('/api/v1/me', { cookie: cookiesOf(out) || 'none=1' })).status).toBe(
      401,
    )
  })
})

describe('health', () => {
  test('reports the database', async () => {
    const api = await createTestApi()
    const res = await api.request('/api/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ ok: true })
  })
})
