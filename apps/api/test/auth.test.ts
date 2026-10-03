import { describe, expect, spyOn, test } from 'bun:test'
import { createOperatorCode, first, headSeq, holdJoin, inviteAddress } from '@tela/data'
import { sql } from 'drizzle-orm'
import { PER_ADDRESS } from '../src/auth'
import { ADMIN_TOKEN, codeFor, cookiesOf, createTestApi, signedIn, type TestApi } from './helpers'

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
    const answer = (await res.json()) as { userId: string; created: boolean }
    expect(answer).toEqual({ userId: expect.any(String), created: true })
    // Through the gate like anyone's: the operator's invitation to the address, claimed and
    // settled by the account it made.
    expect(
      await api.db.all(
        sql`select code, email, user_id, redeemed_at is not null and settled_at is not null as spent
          from invite_redemptions`,
      ),
    ).toEqual([{ code: null, email: 'new@x.test', user_id: answer.userId, spent: 1 }])
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
    // …and writes no second invitation, which would wait for an account that already exists.
    expect(
      await first<{ n: number }>(api.db, sql`select count(*) as n from invite_redemptions`),
    ).toEqual({ n: 1 })
  })
})

describe('the invitation gate', () => {
  /**
   * A code asked for and tried as the reader's browser does, each request from an IP of its own,
   * so better-auth's three a minute per IP stays out of the way.
   */
  const door = (api: TestApi) => {
    let n = 0
    const ip = () => `198.51.100.${++n}`
    return {
      ask: (email: string) =>
        api.request('/api/auth/email-otp/send-verification-otp', {
          body: { email, type: 'sign-in' },
          headers: { 'cf-connecting-ip': ip() },
        }),
      signIn: (email: string, otp: string, extra: Record<string, unknown> = {}) =>
        api.request('/api/auth/sign-in/email-otp', {
          body: { email, otp, ...extra },
          headers: { 'cf-connecting-ip': ip() },
        }),
    }
  }
  const count = async (api: TestApi, table: 'user' | 'profiles') =>
    (await first<{ n: number }>(api.db, sql`select count(*) as n from ${sql.raw(table)}`))?.n
  /** A code of the operator's with `uses` places, and a hold on it for each address. */
  const held = async (api: TestApi, emails: string[], uses = 5) => {
    const now = api.clock.now()
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: uses, now })
    for (const email of emails)
      expect(await holdJoin(api.db, { code: 'WELCOME', email, now })).toBe('held')
  }

  test('a right code for an address with no invitation makes no account', async () => {
    const api = await createTestApi()
    // A code made on the server, since none is ever mailed to this address: the gate itself is
    // what stands in the way.
    const otp = await api.auth.api.createVerificationOTP({
      body: { email: 'stranger@x.test', type: 'sign-in' },
    })
    const res = await door(api).signIn('stranger@x.test', otp)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'INVITE_REQUIRED' })
    expect(res.headers.getSetCookie()).toEqual([])
    expect(await count(api, 'user')).toBe(0)
    expect(await count(api, 'profiles')).toBe(0)
  })

  test('a hold is mailed an invitation, and its sign-in makes the account, its profile and its place', async () => {
    const api = await createTestApi()
    await held(api, ['new@x.test'])
    const d = door(api)
    expect((await d.ask('New@X.test')).status).toBe(200)
    const otp = codeFor(api, 'new@x.test')
    // The code still ends the subject, which the e2e reads it from.
    expect(api.mail.outbox.at(-1)?.subject).toBe(
      `You are invited to Tela · 邀请你加入 Tela: ${otp}`,
    )
    // A name and a picture sent with the code are dropped: the profile is the member's to fill,
    // and nothing of a stranger's rides in the session cookie.
    const res = await d.signIn('new@x.test', otp, {
      name: 'Someone else',
      image: 'https://tracker.example/pixel.png',
    })
    expect(res.status).toBe(200)
    const { user } = (await res.json()) as { user: { id: string } }
    expect(
      await first<{ name: string; image: string | null; email_verified: number }>(
        api.db,
        sql`select name, image, email_verified from user where id = ${user.id}`,
      ),
    ).toEqual({ name: '', image: null, email_verified: 1 })
    const me = await api.request('/api/v1/me', { cookie: cookiesOf(res) })
    expect(await me.json()).toMatchObject({ profile: { handle: expect.stringMatching(/^u_/) } })
    const now = api.clock.now()
    expect(
      await api.db.all(sql`select code, user_id, redeemed_at, settled_at from invite_redemptions`),
    ).toEqual([{ code: 'WELCOME', user_id: user.id, redeemed_at: now, settled_at: now }])
    // From now on the address is a member's, mailed a plain sign-in code.
    await d.ask('new@x.test')
    expect(api.mail.outbox.at(-1)?.subject).toContain('sign-in code')
  })

  test('a hold on a code that others filled after its code was mailed is told so, and given no account', async () => {
    const api = await createTestApi()
    const emails = ['a@x.test', 'b@x.test', 'c@x.test']
    await held(api, emails, 2)
    const d = door(api)
    for (const email of emails) await d.ask(email)
    const [a, b, c] = emails.map((email) => codeFor(api, email))
    expect((await d.signIn('a@x.test', a ?? '')).status).toBe(200)
    expect((await d.signIn('b@x.test', b ?? '')).status).toBe(200)
    const late = await d.signIn('c@x.test', c ?? '')
    expect(late.status).toBe(403)
    expect(await late.json()).toMatchObject({ code: 'INVITE_USED' })
    expect(await count(api, 'user')).toBe(2)
    // And it is mailed no more codes: nothing would admit it.
    const mailed = api.mail.outbox.length
    expect((await d.ask('c@x.test')).status).toBe(200)
    expect(api.mail.outbox).toHaveLength(mailed)
  })

  test('a hold a day old admits nobody', async () => {
    const api = await createTestApi()
    await held(api, ['new@x.test'])
    const d = door(api)
    await d.ask('new@x.test')
    api.clock.advance(24 * 60 * 60 * 1000)
    const res = await d.signIn('new@x.test', codeFor(api, 'new@x.test'))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'INVITE_REQUIRED' })
  })

  test('refuses every way in but the code sign-in, and an address not verified', async () => {
    const api = await createTestApi()
    const gate = api.auth.options.databaseHooks?.user?.create?.before
    if (!gate) throw new Error('no gate')
    // An address the operator invited, so only the way it came can be why it is turned away.
    await inviteAddress(api.db, { email: 'new@x.test', now: api.clock.now() })
    const user = (emailVerified: boolean, email = 'new@x.test') => ({
      id: 'someone',
      email,
      name: '',
      emailVerified,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const inside = (path: string) => ({ path }) as unknown as Parameters<typeof gate>[1]
    const refused = { body: { code: 'INVITE_REQUIRED' } }
    // A password sign-up and an ID token at the social sign-in would each make a user, were they
    // ever reached. They are refused, as is an address not verified, before anything is claimed.
    await expect(gate(user(true), inside('/sign-up/email'))).rejects.toMatchObject(refused)
    await expect(gate(user(true), inside('/sign-in/social'))).rejects.toMatchObject(refused)
    await expect(gate(user(false), inside('/sign-in/email-otp'))).rejects.toMatchObject(refused)
    expect(await api.db.all(sql`select redeemed_at from invite_redemptions`)).toEqual([
      { redeemed_at: null },
    ])
    // No context at all, as on the admin route, grants nothing by itself: an address the operator
    // did not invite is refused there too.
    await expect(gate(user(false, 'other@x.test'), null)).rejects.toMatchObject(refused)
    // The invited address, from the code sign-in, is admitted.
    expect(await gate(user(true), inside('/sign-in/email-otp'))).toEqual({
      data: { name: '', image: null },
    })
  })

  test('an account whose invitation could not be settled is made, and settled at the next sign-in', async () => {
    const api = await createTestApi()
    await held(api, ['new@x.test'])
    const d = door(api)
    await api.db.run(sql`create trigger refuse_settling before update of settled_at
      on invite_redemptions begin select raise(abort, 'refused by the test'); end`)
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await d.ask('new@x.test')
      const res = await d.signIn('new@x.test', codeFor(api, 'new@x.test'))
      expect(res.status).toBe(200)
      expect(logged.mock.calls.map(([what]) => what)).toContain('invitation not settled')
    } finally {
      logged.mockRestore()
    }
    expect(
      await api.db.all(
        sql`select redeemed_at is not null as redeemed, user_id from invite_redemptions`,
      ),
    ).toEqual([{ redeemed: 1, user_id: null }])
    await api.db.run(sql`drop trigger refuse_settling`)
    await d.ask('new@x.test')
    const again = await d.signIn('new@x.test', codeFor(api, 'new@x.test'))
    const { user } = (await again.json()) as { user: { id: string } }
    expect(
      await api.db.all(
        sql`select user_id, settled_at is not null as settled from invite_redemptions`,
      ),
    ).toEqual([{ user_id: user.id, settled: 1 }])
  })

  test('a member whose profile was never written is given one at their next sign-in', async () => {
    const api = await createTestApi()
    await held(api, ['new@x.test'])
    const d = door(api)
    await api.db.run(sql`create trigger refuse_profiles before insert on profiles
      begin select raise(abort, 'refused by the test'); end`)
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await d.ask('new@x.test')
      // The user row is written before the profile, and stays: the sign-in fails after it, and
      // better-auth never makes that user again, so its own hook can never retry the profile.
      const failed = await d.signIn('new@x.test', codeFor(api, 'new@x.test'))
      expect(failed.status).toBe(500)
    } finally {
      logged.mockRestore()
    }
    expect([await count(api, 'user'), await count(api, 'profiles')]).toEqual([1, 0])
    await api.db.run(sql`drop trigger refuse_profiles`)
    await d.ask('new@x.test')
    const res = await d.signIn('new@x.test', codeFor(api, 'new@x.test'))
    expect(res.status).toBe(200)
    const me = await api.request('/api/v1/me', { cookie: cookiesOf(res) })
    expect(await me.json()).toMatchObject({ profile: { handle: expect.stringMatching(/^u_/) } })
    // A sign-in that finds the profile writes nothing: the sync sequence stays where it was.
    const seq = await headSeq(api.db)
    await d.ask('new@x.test')
    expect((await d.signIn('new@x.test', codeFor(api, 'new@x.test'))).status).toBe(200)
    expect(await headSeq(api.db)).toBe(seq)
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

  test('an address with neither an account nor an invitation gets the same answer, no mail and no code', async () => {
    const api = await createTestApi()
    await invite(api, 'known@x.test')
    const known = await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: 'known@x.test', type: 'sign-in' },
    })
    const unknown = await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: 'Stranger@x.test', type: 'sign-in' },
    })
    expect(unknown.status).toBe(known.status)
    expect(await unknown.json()).toEqual(await known.json())
    expect(api.mail.outbox.filter((m) => m.to === 'stranger@x.test')).toHaveLength(0)
    // The code better-auth stored before it asked whether to mail it is gone too.
    expect(
      await first(
        api.db,
        sql`select 1 as x from verification where identifier like '%stranger@x.test'`,
      ),
    ).toBeUndefined()
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

  test('a member and a stranger hear the same wrong code, used up or expired', async () => {
    const api = await createTestApi()
    await invite(api, 'a@x.test')
    let n = 0
    const ip = () => `198.51.100.${++n}`
    const wrong = (email: string) => {
      const code = codeFor(api, email)
      return code === '000000' ? '111111' : '000000'
    }
    /** What a check answers, all of it a guesser could compare. */
    const heard = async (answer: Response) => ({
      status: answer.status,
      type: answer.headers.get('content-type'),
      body: await answer.text(),
    })
    // A member's code is stored, a stranger's never is: only the member's could be used up.
    const fourth = async (check: (email: string) => Promise<Response>, email: string) => {
      for (let i = 0; i < 3; i++) await check(email)
      return heard(await check(email))
    }
    expect((await askCode(api, 'stranger@x.test', ip())).status).toBe(200)
    const signIn = (code: string) => (email: string) => tryCode(api, code, ip(), email)
    const member = await fourth(signIn(wrong('a@x.test')), 'a@x.test')
    const stranger = await fourth(signIn('000000'), 'stranger@x.test')
    expect(member).toEqual(stranger)
    expect(member.status).toBe(400)
    expect(JSON.parse(member.body)).toMatchObject({ code: 'INVALID_OTP' })

    // The reset pair, the same way.
    const askReset = (email: string) =>
      authCall(api, 'email-otp/request-password-reset', { email }, ip())
    const reset = (otp: string) => (email: string) =>
      authCall(
        api,
        'email-otp/reset-password',
        { email, otp, password: 'a-guessed-password' },
        ip(),
      )
    expect((await askReset('a@x.test')).status).toBe(200)
    expect((await askReset('stranger@x.test')).status).toBe(200)
    expect(await fourth(reset(wrong('a@x.test')), 'a@x.test')).toEqual(
      await fourth(reset('000000'), 'stranger@x.test'),
    )

    // A code past its hour (better-auth reads the wall clock for it, not tela-api's).
    await api.request('/api/admin/invite', {
      body: { email: 'a@x.test' },
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    await api.db.run(sql`update verification set expires_at = 0`)
    expect(await heard(await tryCode(api, wrong('a@x.test'), ip()))).toEqual(
      await heard(await tryCode(api, '000000', ip(), 'stranger@x.test')),
    )
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
    // Both endpoints served that check a code, in turn, each try from an IP that never tried. The
    // plugin's others are closed (see /api/auth below) and counted all the same.
    const checks = [
      (email: string) => tryCode(api, '000000', ip(), email),
      (email: string) => reset(email, '000000'),
    ]
    const tenTries = [...checks, ...checks, ...checks, ...checks, ...checks]
    for (const check of tenTries) expect((await check('a@x.test')).status).not.toBe(429)
    // A reset code asked for now (one of the address's five sends) is refused, right as it is, and
    // the account gets no password. So is a sign-in code.
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
    // Both endpoints served that mail a code, every kind of code they mail, and a sign-in code
    // again: five sends. The plugin's deprecated `forget-password/email-otp` is closed.
    const askSignIn = (email: string) => askCode(api, email, ip())
    const sends = [
      askSignIn,
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
      askSignIn,
    ]
    for (const send of sends) expect((await send('a@x.test')).status).toBe(200)
    // The invitation, then the five but the address check, which is counted and mailed to nobody.
    // (Until its first sign-in, the account's sign-in codes come as invitations.)
    const invited = 'You are invited to Tela · 邀请你加入 Tela'
    const reset = 'Reset your Tela password · 重置 Tela 密码'
    expect(api.mail.outbox.map((m) => m.subject.split(':')[0])).toEqual([
      invited,
      invited,
      reset,
      reset,
      invited,
    ])
    // …and the address check's code is not kept either.
    expect(
      await first(
        api.db,
        sql`select 1 as x from verification where identifier like 'email-verification-otp-%'`,
      ),
    ).toBeUndefined()
    for (const send of sends) expect((await send('A@X.test')).status).toBe(429)
    expect(api.mail.outbox).toHaveLength(5)
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
    // no path, and the change-email pair needs a session and is off. Endpoints /api/auth does not
    // serve are counted too, so serving one later cannot open it uncounted.
    expect(paths.filter((p) => !PER_ADDRESS.has(p)).sort()).toEqual([
      '/email-otp/change-email',
      '/email-otp/request-email-change',
    ])
    // The password sign-in is the one better-auth's own, with a count of its own.
    expect([...PER_ADDRESS.keys()].filter((p) => !paths.includes(p))).toEqual(['/sign-in/email'])
    expect(PER_ADDRESS.get('/sign-in/email')).toBe('passwordSignIn')
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

describe('/api/auth', () => {
  // What tela-api serves, as better-auth names its endpoints; `/callback/:id` only for Google and
  // GitHub. Written out here rather than read from the app, so the test is a second opinion.
  const SERVED = new Set([
    'GET /get-session',
    'POST /email-otp/send-verification-otp',
    'POST /sign-in/email-otp',
    'POST /sign-in/email',
    'POST /email-otp/request-password-reset',
    'POST /email-otp/reset-password',
    'POST /sign-in/social',
    'GET /callback/:id',
    'POST /sign-out',
  ])
  const endpoints = (api: TestApi) =>
    Object.values(api.auth.api).flatMap((e) =>
      e.path ? [e.options.method].flat().map((method) => ({ method, path: e.path })) : [],
    )
  /** Whatever better-auth writes for any request that reaches it, or that it counts per address. */
  const traces = (api: TestApi) =>
    first<{ limited: number; counted: number; codes: number }>(
      api.db,
      sql`select (select coalesce(sum(count), 0) from rate_limit) as limited,
        (select coalesce(sum(count), 0) from action_limits) as counted,
        (select count(*) from verification) as codes`,
    )

  test('every endpoint Tela does not use is a 404, even to a member, and reaches nothing', async () => {
    const api = await createTestApi()
    const as = await signedIn(api)
    const before = await traces(api)
    const mailed = api.mail.outbox.length
    const closed = endpoints(api).filter((e) => !SERVED.has(`${e.method} ${e.path}`))
    // Some forty, and any a better-auth upgrade adds is asked too, with no change here.
    expect(closed.length).toBeGreaterThan(30)
    const asked = [
      ...closed,
      { method: 'GET', path: '/callback/twitter' },
      { method: 'GET', path: '/get-session/' },
      { method: 'GET', path: '' },
    ]
    for (const { method, path } of asked) {
      const res = await api.request(`/api/auth${path.replace(/:\w+/, 'google')}`, {
        method,
        as,
        ...(method === 'GET' ? {} : { body: { email: 'reader@x.test', otp: '000000' } }),
      })
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 })
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
    // No request got as far as better-auth's limiter, Tela's count per address, or a code.
    expect(await traces(api)).toEqual(before)
    expect(api.mail.outbox).toHaveLength(mailed)
    // The same measure sees one that does.
    await api.request('/api/auth/sign-in/social', { body: {} })
    expect(await traces(api)).not.toEqual(before)
  })

  test('a member cannot rename themselves or set a picture, and nobody can sign up', async () => {
    const api = await createTestApi()
    const as = await signedIn(api)
    const updated = await api.request('/api/auth/update-user', {
      as,
      body: { name: 'Someone else', image: 'https://tracker.example/pixel.png' },
    })
    expect(updated.status).toBe(404)
    expect(
      await first<{ name: string; image: string | null }>(
        api.db,
        sql`select name, image from user where id = ${as.userId}`,
      ),
    ).toEqual({ name: '', image: null })
    const signUp = await api.request('/api/auth/sign-up/email', {
      body: { email: 'new@x.test', password: 'a-long-enough-password', name: 'New' },
    })
    expect(signUp.status).toBe(404)
    expect(await first<{ n: number }>(api.db, sql`select count(*) as n from user`)).toEqual({
      n: 1,
    })
  })

  test('every endpoint Tela uses reaches better-auth', async () => {
    const api = await createTestApi()
    const as = await signedIn(api)
    const served = endpoints(api).filter((e) => SERVED.has(`${e.method} ${e.path}`))
    expect(served.map((e) => `${e.method} ${e.path}`).sort()).toEqual([...SERVED].sort())
    for (const { method, path } of served) {
      // Signing out last, so every other call is made with a session.
      if (path === '/sign-out') continue
      for (const provider of path === '/callback/:id' ? ['google', 'github'] : ['']) {
        const res = await api.request(`/api/auth${path.replace(':id', provider)}`, {
          method,
          as,
          ...(method === 'GET' ? {} : { body: {} }),
        })
        // better-auth's own answer: the session, a refused body, or a callback's redirect.
        const answered = [200, 302, 400].includes(res.status)
        expect({ path, provider, answered }).toEqual({ path, provider, answered: true })
      }
    }
    const out = await api.request('/api/auth/sign-out', { as, body: {} })
    expect(out.status).toBe(200)
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
