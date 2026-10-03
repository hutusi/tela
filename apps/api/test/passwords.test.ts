/**
 * Passwords (ADR 0036): set only on a member whose address a code proved, tried at
 * `/api/auth/sign-in/email` under limits per IP and per address, and reset by a code of its own.
 * Setting one is tela-api's own call (`setPassword` is server-only), which Settings makes through
 * `/api/v1/account/password` (`account.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createOperatorCode, first } from '@tela/data'
import { sql } from 'drizzle-orm'
import { codeFor, cookiesOf, createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

const PASSWORD = 'correct horse battery'

// better-auth warns at every refused password ("Invalid password", "User not found"); what it
// answered is what these tests look at.
let quiet: { mockRestore(): void } | undefined
beforeEach(() => {
  quiet = spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => quiet?.mockRestore())

/** Each request from an IP of its own unless one is given, clear of the per-IP limits. */
function door(api: TestApi) {
  let n = 0
  const ip = () => `198.51.100.${++n}`
  const call = (path: string, body: Record<string, unknown>, from = ip()) =>
    api.request(`/api/auth/${path}`, { body, headers: { 'cf-connecting-ip': from } })
  return {
    logIn: (email: string, password: string, from?: string) =>
      call('sign-in/email', { email, password }, from),
    askReset: (email: string) => call('email-otp/request-password-reset', { email }),
    reset: (email: string, otp: string, password: string) =>
      call('email-otp/reset-password', { email, otp, password }),
  }
}

/** A password set as `/api/v1/account/password` sets it: tela-api's own call, with the session. */
const setPassword = (api: TestApi, as: SignedIn, newPassword: string) =>
  api.auth.api.setPassword({ headers: new Headers({ cookie: as.cookie }), body: { newPassword } })

const credential = (api: TestApi, userId: string) =>
  first<{ password: string }>(
    api.db,
    sql`select password from account where user_id = ${userId} and provider_id = 'credential'`,
  )

/** Whether a session is still live, read from the database rather than the signed cookie copy. */
const live = async (api: TestApi, cookie: string) =>
  (await api.auth.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableCookieCache: true },
  })) !== null

describe('a password', () => {
  test('is set once a code has proved the address at join, and logs the member in', async () => {
    const api = await createTestApi()
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 5, now: api.clock.now() })
    const joined = await api.request('/api/v1/join', {
      body: { code: 'WELCOME', email: 'new@x.test' },
      headers: { 'cf-connecting-ip': '198.51.100.200' },
    })
    expect(joined.status).toBe(200)
    const signIn = await api.request('/api/auth/sign-in/email-otp', {
      body: { email: 'new@x.test', otp: codeFor(api, 'new@x.test') },
      headers: { 'cf-connecting-ip': '198.51.100.201' },
    })
    expect(signIn.status).toBe(200)
    const { user } = (await signIn.json()) as { user: { id: string } }
    const as = { cookie: cookiesOf(signIn), userId: user.id, headers: {} }
    // Server-only: better-auth mounts no path for it, so only tela-api's own call sets one.
    expect(api.auth.api.setPassword.path).toBeUndefined()
    // Ten characters at least, and 128 at most.
    await expect(setPassword(api, as, 'too short')).rejects.toMatchObject({
      body: { code: 'PASSWORD_TOO_SHORT' },
    })
    await expect(setPassword(api, as, 'x'.repeat(129))).rejects.toMatchObject({
      body: { code: 'PASSWORD_TOO_LONG' },
    })
    expect(await setPassword(api, as, PASSWORD)).toEqual({ status: true })
    // better-auth's scrypt, salt and key in hex: never the password itself.
    expect((await credential(api, user.id))?.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)

    const res = await door(api).logIn('New@X.test', PASSWORD)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { id: user.id } })
    const me = await api.request('/api/v1/me', { cookie: cookiesOf(res) })
    expect(await me.json()).toMatchObject({ id: user.id, email: 'new@x.test' })
  })

  test('never makes an account: signing up with one is closed inside better-auth too', async () => {
    const api = await createTestApi()
    await expect(
      api.auth.api.signUpEmail({
        body: { email: 'new@x.test', password: PASSWORD, name: 'New' },
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(await first(api.db, sql`select 1 as x from user`)).toBeUndefined()
  })

  test('an unknown address, an account without a password and a wrong one get the same 401, each after one hash', async () => {
    const api = await createTestApi()
    const withPassword = await signedIn(api, 'a@x.test')
    await setPassword(api, withPassword, PASSWORD)
    await signedIn(api, 'b@x.test')
    const d = door(api)
    const ctx = await api.auth.$context
    const hash = spyOn(ctx.password, 'hash')
    const verify = spyOn(ctx.password, 'verify')
    const hashes = async (attempt: () => Response | Promise<Response>) => {
      hash.mockClear()
      verify.mockClear()
      const res = await attempt()
      expect(res.status).toBe(401)
      expect(res.headers.getSetCookie()).toEqual([])
      return { body: await res.json(), hashed: hash.mock.calls.length + verify.mock.calls.length }
    }
    try {
      const wrong = await hashes(() => d.logIn('a@x.test', 'not the password'))
      const unknown = await hashes(() => d.logIn('stranger@x.test', 'not the password'))
      const none = await hashes(() => d.logIn('b@x.test', 'not the password'))
      expect(wrong).toEqual({
        body: { code: 'INVALID_EMAIL_OR_PASSWORD', message: expect.any(String) },
        hashed: 1,
      })
      expect(unknown).toEqual(wrong)
      expect(none).toEqual(wrong)
    } finally {
      hash.mockRestore()
      verify.mockRestore()
    }
  })
})

describe('password sign-ins are limited', () => {
  test('to five a minute from one IP', async () => {
    const api = await createTestApi()
    const as = await signedIn(api, 'a@x.test')
    await setPassword(api, as, PASSWORD)
    const d = door(api)
    for (let i = 0; i < 5; i++)
      expect((await d.logIn('a@x.test', 'not the password', '203.0.113.9')).status).toBe(401)
    expect((await d.logIn('a@x.test', PASSWORD, '203.0.113.9')).status).toBe(429)
    // Another reader behind the same Cloudflare edge is not throttled with them.
    expect((await d.logIn('a@x.test', PASSWORD, '203.0.113.10')).status).toBe(200)
  })

  test('to ten in fifteen minutes for one address, however many IPs try it, and never its code', async () => {
    const api = await createTestApi()
    const as = await signedIn(api, 'a@x.test')
    await setPassword(api, as, PASSWORD)
    const d = door(api)
    for (let i = 0; i < 10; i++)
      expect((await d.logIn('a@x.test', 'not the password')).status).toBe(401)
    // The eleventh is refused from an IP that never tried, right password or not, before anything
    // is hashed.
    const ctx = await api.auth.$context
    const hash = spyOn(ctx.password, 'hash')
    const verify = spyOn(ctx.password, 'verify')
    const refused = await d.logIn('A@X.test', PASSWORD)
    expect([hash.mock.calls.length, verify.mock.calls.length]).toEqual([0, 0])
    hash.mockRestore()
    verify.mockRestore()
    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-retry-after')).toBe('900')
    // An address with no account is refused the same way, so the limit says nothing of who has one.
    for (let i = 0; i < 10; i++) await d.logIn('stranger@x.test', 'not the password')
    const stranger = await d.logIn('stranger@x.test', 'not the password')
    expect(stranger.status).toBe(429)
    expect(await stranger.json()).toEqual(await refused.json())
    // The member's code still signs them in: guessing their password locks nobody out.
    await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: 'a@x.test', type: 'sign-in' },
      headers: { 'cf-connecting-ip': '198.51.100.250' },
    })
    const byCode = await api.request('/api/auth/sign-in/email-otp', {
      body: { email: 'a@x.test', otp: codeFor(api, 'a@x.test') },
      headers: { 'cf-connecting-ip': '198.51.100.251' },
    })
    expect(byCode.status).toBe(200)
    // And the next quarter of an hour starts afresh.
    api.clock.advance(15 * 60 * 1000)
    expect((await d.logIn('a@x.test', PASSWORD)).status).toBe(200)
  })
})

describe('a forgotten password', () => {
  test('is reset by a code of its own, mailed only to an address that has an account', async () => {
    const api = await createTestApi()
    await signedIn(api, 'a@x.test')
    const d = door(api)
    const known = await d.askReset('A@x.test')
    const unknown = await d.askReset('stranger@x.test')
    expect(unknown.status).toBe(known.status)
    expect(await unknown.json()).toEqual(await known.json())
    expect(api.mail.outbox.filter((m) => m.to === 'stranger@x.test')).toEqual([])
    expect(
      await first(api.db, sql`select 1 as x from verification where identifier like '%stranger%'`),
    ).toBeUndefined()
    // The code ends the subject, as a sign-in code's does, and its link asks for a new password:
    // opened, it signs nobody in.
    const mail = api.mail.outbox.at(-1)
    const code = codeFor(api, 'a@x.test')
    expect(mail?.to).toBe('a@x.test')
    expect(mail?.subject).toBe(`Reset your Tela password · 重置 Tela 密码: ${code}`)
    expect(mail?.text).toContain(`/login?reset=1&email=a%40x.test&otp=${code}`)
    expect(mail?.html).toContain(`/login?reset=1&#38;email=a%40x.test&#38;otp=${code}`)
    expect(mail?.text).not.toContain('/login?email=')
    // It is no sign-in code.
    const asSignIn = await api.request('/api/auth/sign-in/email-otp', {
      body: { email: 'a@x.test', otp: code },
      headers: { 'cf-connecting-ip': '198.51.100.250' },
    })
    expect(asSignIn.status).toBe(400)
  })

  test('gives a member who never had a password their first', async () => {
    const api = await createTestApi()
    const as = await signedIn(api, 'a@x.test')
    expect(await credential(api, as.userId)).toBeUndefined()
    const d = door(api)
    await d.askReset('a@x.test')
    const code = codeFor(api, 'a@x.test')
    // Ten characters at least here too; the code is not spent on a refusal.
    expect((await d.reset('a@x.test', code, 'too short')).status).toBe(400)
    expect((await d.reset('a@x.test', code, PASSWORD)).status).toBe(200)
    expect((await credential(api, as.userId))?.password).toMatch(/^[0-9a-f]{32}:/)
    expect((await d.logIn('a@x.test', PASSWORD)).status).toBe(200)
    // A code is good once.
    expect((await d.reset('a@x.test', code, 'another long password')).status).toBe(400)
  })

  test('ends every session the member had, and only the new password works', async () => {
    const api = await createTestApi()
    const member = await signedIn(api, 'a@x.test')
    await setPassword(api, member, PASSWORD)
    const d = door(api)
    const second = cookiesOf(await d.logIn('a@x.test', PASSWORD))
    const other = await signedIn(api, 'b@x.test')
    expect(await live(api, member.cookie)).toBe(true)
    expect(await live(api, second)).toBe(true)

    await d.askReset('a@x.test')
    const res = await d.reset('a@x.test', codeFor(api, 'a@x.test'), 'a brand new password')
    expect(res.status).toBe(200)
    // Someone who had the old password, or a session, is out; another member is not.
    expect(await live(api, member.cookie)).toBe(false)
    expect(await live(api, second)).toBe(false)
    expect(await live(api, other.cookie)).toBe(true)
    expect(
      await first<{ n: number }>(
        api.db,
        sql`select count(*) as n from session where user_id = ${member.userId}`,
      ),
    ).toEqual({ n: 0 })
    expect((await d.logIn('a@x.test', PASSWORD)).status).toBe(401)
    expect((await d.logIn('a@x.test', 'a brand new password')).status).toBe(200)
  })
})
