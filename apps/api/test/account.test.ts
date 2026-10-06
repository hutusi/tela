/**
 * A member's ways in (ADR 0036), at `/api/v1/account`: what they have, a password set or changed,
 * a provider linked or unlinked, and every other session ended. Every call reads the session from
 * D1 rather than its signed five-minute copy, adding a way in needs a session made within the day,
 * each change is counted per member, and every change mails the member a notice. GitHub is stood
 * in for by a `fetch` that answers its token and profile endpoints, as in `oauth.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { consumeLimit, first, schema } from '@tela/data'
import { MEMBER_HEADER } from '@tela/sync'
import { sql } from 'drizzle-orm'
import {
  codeFor,
  cookiesOf,
  createTestApi,
  ORIGIN,
  type SignedIn,
  signedIn,
  type TestApi,
} from './helpers'

const GITHUB = { clientId: 'github-client', clientSecret: 'github-secret' }
const PASSWORD = 'correct horse battery'
const DAY_MS = 24 * 60 * 60 * 1000

/** Who GitHub says signed in: set per test, read by the stand-in below. */
let identity: { id: number; email: string }

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** GitHub's token and profile endpoints, which better-auth's fetch reads from the global. */
async function github(input: Request | URL | string): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  switch (`${url.origin}${url.pathname}`) {
    case 'https://github.com/login/oauth/access_token':
      return json({ access_token: 'gho_access-token', token_type: 'bearer', scope: 'user:email' })
    case 'https://api.github.com/user':
      return json({ id: identity.id, login: 'octo', email: null })
    case 'https://api.github.com/user/emails':
      return json([{ email: identity.email, primary: true, verified: true, visibility: null }])
  }
  throw new Error(`GitHub does not answer ${url}`)
}

let realFetch: typeof fetch
beforeEach(() => {
  identity = { id: 4242, email: 'octo@elsewhere.test' }
  realFetch = globalThis.fetch
  globalThis.fetch = github as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

/** better-auth logs a refused link and a refused password; its answer is what is looked at. */
async function quietly<T>(run: () => T | Promise<T>): Promise<T> {
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  const warnings = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    return await run()
  } finally {
    errors.mockRestore()
    warnings.mockRestore()
  }
}

/** Requests made so far, so each sign-in comes from an IP of its own. */
let requests = 0
const ip = () => {
  requests++
  return `198.51.${100 + (requests >> 8)}.${requests & 255}`
}

/** Another session of a member's, as a second device makes one: a code sign-in. */
async function anotherSession(api: TestApi, as: SignedIn, email: string): Promise<SignedIn> {
  await api.request('/api/auth/email-otp/send-verification-otp', {
    body: { email, type: 'sign-in' },
    headers: { 'cf-connecting-ip': ip() },
  })
  const res = await api.request('/api/auth/sign-in/email-otp', {
    body: { email, otp: codeFor(api, email) },
    headers: { 'cf-connecting-ip': ip() },
  })
  expect(res.status).toBe(200)
  return { ...as, cookie: cookiesOf(res) }
}

/** The session token a cookie carries, signed: the part before the signature. */
const tokenOf = (as: SignedIn) => {
  const signed = as.cookie.match(/tela\.session_token=([^;]+)/)?.[1] ?? ''
  return decodeURIComponent(signed).split('.')[0] ?? ''
}

/** Age a session past `freshAge` in D1. Its signed copy in the cookie still says it is new. */
const stale = (api: TestApi, as: SignedIn) =>
  api.db.run(
    sql`update session set created_at = created_at - ${2 * DAY_MS} where token = ${tokenOf(as)}`,
  )

/** Whether a session is still live, read from the database rather than the signed cookie copy. */
const live = async (api: TestApi, as: SignedIn) =>
  (await api.auth.api.getSession({
    headers: new Headers({ cookie: as.cookie }),
    query: { disableCookieCache: true },
  })) !== null

const account = (api: TestApi, as: SignedIn, path = '', body?: unknown) =>
  api.request(`/api/v1/account${path}`, { as, ...(body === undefined ? {} : { body }) })

/** The notices mailed to an address, by subject. */
const notices = (api: TestApi, email: string) =>
  api.mail.outbox.filter((m) => m.to === email && !/^\d{6}$/m.test(m.text)).map((m) => m.subject)

const logIn = (api: TestApi, email: string, password: string) =>
  api.request('/api/auth/sign-in/email', {
    body: { email, password },
    headers: { 'cf-connecting-ip': ip() },
  })

/**
 * Link GitHub as Settings does: start at `/api/v1/account/link`, then come back from GitHub.
 */
async function linkGithub(api: TestApi, as: SignedIn) {
  const started = await account(api, as, '/link', { provider: 'github' })
  expect(started.status).toBe(200)
  return backFromGithub(api, as, started)
}

/**
 * Come back from the GitHub a link `started`, with the browser's cookies: the session in `as`, and
 * the state cookie the start set.
 */
async function backFromGithub(api: TestApi, as: SignedIn, started: Response) {
  const { url } = (await started.clone().json()) as { url: string }
  const state = encodeURIComponent(new URL(url).searchParams.get('state') ?? '')
  return api.request(`/api/auth/callback/github?code=from-github&state=${state}`, {
    headers: {
      origin: undefined,
      cookie: `${as.cookie}; ${cookiesOf(started)}`,
      'cf-connecting-ip': ip(),
    },
  })
}

describe('what a member has', () => {
  test('is answered from D1, to the member the client names', async () => {
    const api = await createTestApi({ oauth: { github: GITHUB } })
    const member = await signedIn(api, 'a@x.test')
    const res = await account(api, member)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      email: 'a@x.test',
      hasPassword: false,
      linked: [],
      fresh: true,
    })
    await stale(api, member)
    expect(await (await account(api, member)).json()).toMatchObject({ fresh: false })

    // Like every member route: signed out, a client that names no one, and one that names
    // someone else.
    expect((await api.request('/api/v1/account')).status).toBe(401)
    const unnamed = await api.request('/api/v1/account', { cookie: member.cookie })
    expect(unnamed.status).toBe(409)
    expect(await unnamed.json()).toEqual({ error: 'upgrade' })
    const other = await api.request('/api/v1/account', {
      as: member,
      headers: { [MEMBER_HEADER]: 'someone-else' },
    })
    expect(other.status).toBe(409)
    expect(await other.json()).toEqual({ error: 'account_changed' })
  })

  test('is refused to a session ended elsewhere, while its signed copy still passes other routes', async () => {
    const api = await createTestApi()
    const here = await signedIn(api, 'a@x.test')
    const there = await anotherSession(api, here, 'a@x.test')
    expect((await account(api, here, '/sign-out-everywhere', {})).status).toBe(200)
    // The five-minute signed copy keeps `there` going on routes that trust it…
    expect((await api.request('/api/v1/me', { as: there })).status).toBe(200)
    // …but not here, where every call reads D1.
    expect((await account(api, there)).status).toBe(401)
    expect((await account(api, there, '/sign-out-everywhere', {})).status).toBe(401)
    expect(await live(api, here)).toBe(true)
  })
})

describe('a password', () => {
  test('is set on a fresh session, ends the other sessions, and is told to the member', async () => {
    const api = await createTestApi()
    const member = await signedIn(api, 'a@x.test')
    const other = await anotherSession(api, member, 'a@x.test')
    const bystander = await signedIn(api, 'b@x.test')

    // A session made more than a day ago adds no way in, whatever its signed copy says.
    await stale(api, member)
    const old = await account(api, member, '/password', { newPassword: PASSWORD })
    expect(old.status).toBe(403)
    expect(await old.json()).toEqual({ error: 'session_not_fresh' })

    const set = await account(api, other, '/password', { newPassword: PASSWORD })
    expect(set.status).toBe(200)
    expect(await (await account(api, other)).json()).toMatchObject({ hasPassword: true })
    // The member's other session ends; this one and another member's do not.
    expect(await live(api, member)).toBe(false)
    expect(await live(api, other)).toBe(true)
    expect(await live(api, bystander)).toBe(true)
    expect(notices(api, 'a@x.test')).toEqual([
      'A password was added to your Tela account · 你的 Tela 账号已设置密码',
    ])
    const [notice] = api.mail.outbox.filter((m) => m.subject.startsWith('A password'))
    expect(notice?.text).toContain('Every other device was signed out.')
    expect(notice?.text).toContain(`${ORIGIN}/login`)
    expect(notice?.text).not.toContain('otp=')
    expect((await logIn(api, 'a@x.test', PASSWORD)).status).toBe(200)
  })

  test('is changed with the current one, fresh session or not', async () => {
    const api = await createTestApi()
    const member = await signedIn(api, 'a@x.test')
    expect((await account(api, member, '/password', { newPassword: PASSWORD })).status).toBe(200)
    const other = await anotherSession(api, member, 'a@x.test')
    await stale(api, member)

    const without = await account(api, member, '/password', { newPassword: 'a newer password' })
    expect(without.status).toBe(400)
    expect(await without.json()).toEqual({ error: 'current_password_required' })
    const wrong = await quietly(() =>
      account(api, member, '/password', {
        newPassword: 'a newer password',
        currentPassword: 'not the password',
      }),
    )
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: 'invalid_password' })

    const changed = await account(api, member, '/password', {
      newPassword: 'a newer password',
      currentPassword: PASSWORD,
    })
    expect(changed.status).toBe(200)
    expect(await live(api, member)).toBe(true)
    expect(await live(api, other)).toBe(false)
    expect(notices(api, 'a@x.test')).toEqual([
      'A password was added to your Tela account · 你的 Tela 账号已设置密码',
      'Your Tela password was changed · 你的 Tela 密码已更改',
    ])
    expect((await quietly(() => logIn(api, 'a@x.test', PASSWORD))).status).toBe(401)
    expect((await logIn(api, 'a@x.test', 'a newer password')).status).toBe(200)
  })

  test('once set, is told to the member even when the other sessions could not be ended', async () => {
    const api = await createTestApi()
    const member = await signedIn(api, 'a@x.test')
    const other = await anotherSession(api, member, 'a@x.test')
    const remove = api.db.delete.bind(api.db)
    const failing = spyOn(api.db, 'delete').mockImplementation(((table) => {
      if (Object.is(table, schema.session)) throw new Error('D1 is away')
      return remove(table)
    }) as typeof api.db.delete)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const set = await account(api, member, '/password', { newPassword: PASSWORD })
    const logged = errors.mock.calls.map(([what]) => what)
    failing.mockRestore()
    errors.mockRestore()

    // The password is set by then, so it is answered as set, logged, and told all the same.
    expect(set.status).toBe(200)
    expect(logged).toEqual(['sessions not ended'])
    expect(await live(api, other)).toBe(true)
    expect(notices(api, 'a@x.test')).toEqual([
      'A password was added to your Tela account · 你的 Tela 账号已设置密码',
    ])
    expect((await logIn(api, 'a@x.test', PASSWORD)).status).toBe(200)
  })

  test('changes are counted per member, five in fifteen minutes, and a wrong length is not one', async () => {
    const api = await createTestApi()
    const member = await signedIn(api, 'a@x.test')
    for (let i = 0; i < 6; i++) {
      const short = await account(api, member, '/password', { newPassword: 'too short' })
      expect(await short.json()).toEqual({ error: 'password_too_short' })
    }
    const long = await account(api, member, '/password', { newPassword: 'x'.repeat(129) })
    expect(await long.json()).toEqual({ error: 'password_too_long' })
    expect(await (await account(api, member, '/password', { newPassword: 12345 })).json()).toEqual({
      error: 'new_password_required',
    })
    expect((await account(api, member, '/password', { newPassword: PASSWORD })).status).toBe(200)
    // Each wrong guess at the current password is counted: four more, then the fifth is refused
    // before anything is hashed, right password or not.
    const guess = (currentPassword: string) =>
      account(api, member, '/password', { newPassword: 'a newer password', currentPassword })
    for (let i = 0; i < 4; i++) {
      expect((await quietly(() => guess('not the password'))).status).toBe(400)
    }
    const ctx = await api.auth.$context
    const hash = spyOn(ctx.password, 'hash')
    const refused = await guess(PASSWORD)
    expect(hash).not.toHaveBeenCalled()
    hash.mockRestore()
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
    expect(
      await first<{ count: number }>(
        api.db,
        sql`select count from action_limits where key like 'passwordChange:%'`,
      ),
    ).toEqual({ count: 6 })
    api.clock.advance(15 * 60 * 1000)
    expect((await guess(PASSWORD)).status).toBe(200)
  })

  test('reset by code is told to the member too', async () => {
    const api = await createTestApi()
    await signedIn(api, 'a@x.test')
    await api.request('/api/auth/email-otp/request-password-reset', {
      body: { email: 'a@x.test' },
      headers: { 'cf-connecting-ip': ip() },
    })
    const reset = await api.request('/api/auth/email-otp/reset-password', {
      body: { email: 'a@x.test', otp: codeFor(api, 'a@x.test'), password: PASSWORD },
      headers: { 'cf-connecting-ip': ip() },
    })
    expect(reset.status).toBe(200)
    expect(notices(api, 'a@x.test')).toEqual([
      'Your Tela password was reset · 你的 Tela 密码已重置',
    ])
  })
})

describe('a provider', () => {
  test('is linked from a fresh session, back to Settings, and at its return the other sessions end and the member is told', async () => {
    const api = await createTestApi({ oauth: { github: GITHUB } })
    const member = await signedIn(api, 'a@x.test')
    const other = await anotherSession(api, member, 'a@x.test')
    const linking = await anotherSession(api, member, 'a@x.test')

    // Only a provider Tela offers, and only from a session made within the day.
    for (const provider of ['google', 'twitter', undefined]) {
      const res = await account(api, member, '/link', { provider })
      expect({ provider, status: res.status }).toEqual({ provider, status: 404 })
    }
    await stale(api, member)
    expect((await account(api, member, '/link', { provider: 'github' })).status).toBe(403)

    const started = await account(api, linking, '/link', { provider: 'github' })
    expect(started.status).toBe(200)
    expect(started.headers.get('cache-control')).toBe('no-store')
    const { url } = (await started.clone().json()) as { url: string }
    const authorize = new URL(url)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    )
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`)
    expect(authorize.searchParams.get('scope')).toBe('user:email')
    // The cookie that ties GitHub's return to this browser is passed on.
    const cookie = started.headers.getSetCookie().find((c) => c.startsWith('tela.state='))
    expect(cookie).toContain('HttpOnly')
    // Nothing is linked, and nobody signed out, until GitHub returns.
    expect(await live(api, other)).toBe(true)
    expect(notices(api, 'a@x.test')).toEqual([])

    const back = await linkGithub(api, linking)
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/settings?linked=github')
    expect(back.headers.getSetCookie().some((c) => c.startsWith('tela.session_token='))).toBe(false)
    expect(
      await api.db.all(sql`select provider_id, account_id, access_token, refresh_token, id_token
        from account where user_id = ${member.userId}`),
    ).toEqual([
      {
        provider_id: 'github',
        account_id: '4242',
        access_token: null,
        refresh_token: null,
        id_token: null,
      },
    ])
    expect([await live(api, member), await live(api, other), await live(api, linking)]).toEqual([
      false,
      false,
      true,
    ])
    expect(notices(api, 'a@x.test')).toEqual([
      'GitHub was linked to your Tela account · GitHub 已关联到你的 Tela 账号',
    ])
    const listed = (await (await account(api, linking)).json()) as {
      linked: { id: string; provider: string; since: number }[]
    }
    expect(listed.linked).toEqual([
      { id: expect.any(String), provider: 'github', since: expect.any(Number) },
    ])

    // GitHub now signs the member in, with no invite code.
    const signIn = await api.request('/api/auth/sign-in/social', {
      body: { provider: 'github', callbackURL: '/reading', disableRedirect: true },
      headers: { 'cf-connecting-ip': ip() },
    })
    const state = new URL(((await signIn.json()) as { url: string }).url).searchParams.get('state')
    const returned = await api.request(`/api/auth/callback/github?code=x&state=${state}`, {
      headers: { origin: undefined, cookie: cookiesOf(signIn), 'cf-connecting-ip': ip() },
    })
    expect(returned.headers.get('location')).toBe('/reading')
    const me = await api.request('/api/v1/me', { cookie: cookiesOf(returned) })
    expect(await me.json()).toMatchObject({ id: member.userId })
  })

  test('is linked only while the browser that returns holds a live session of the member’s', async () => {
    const api = await createTestApi({ oauth: { github: GITHUB } })
    const member = await signedIn(api, 'a@x.test')
    const stranger = await signedIn(api, 'b@x.test')

    // A session someone else holds starts a link, and the member ends it while GitHub is asking.
    const stolen = await anotherSession(api, member, 'a@x.test')
    const started = await account(api, stolen, '/link', { provider: 'github' })
    expect(started.status).toBe(200)
    expect(await (await account(api, member, '/sign-out-everywhere', {})).json()).toEqual({
      ended: 1,
    })
    const back = await quietly(() => backFromGithub(api, stolen, started))
    expect(back.headers.get('location')).toBe('/settings?error=unable_to_link_account')

    // Nor does another member's session finish it, live as that one is.
    const again = await anotherSession(api, member, 'a@x.test')
    const restarted = await account(api, again, '/link', { provider: 'github' })
    expect(restarted.status).toBe(200)
    await account(api, member, '/sign-out-everywhere', {})
    const crossed = await quietly(() => backFromGithub(api, stranger, restarted))
    expect(crossed.headers.get('location')).toBe('/settings?error=unable_to_link_account')

    // Nothing linked, nobody signed out, nobody told.
    expect(await api.db.all(sql`select user_id from account`)).toEqual([])
    expect([await live(api, member), await live(api, stranger)]).toEqual([true, true])
    expect(notices(api, 'a@x.test')).toEqual([])
    expect(notices(api, 'b@x.test')).toEqual([])
  })

  test('another member holds is refused at the return, with nothing ended or told', async () => {
    const api = await createTestApi({ oauth: { github: GITHUB } })
    const first = await signedIn(api, 'a@x.test')
    expect((await linkGithub(api, first)).headers.get('location')).toBe('/settings?linked=github')
    const second = await signedIn(api, 'b@x.test')
    const elsewhere = await anotherSession(api, second, 'b@x.test')
    const back = await quietly(() => linkGithub(api, second))
    expect(back.headers.get('location')).toBe(
      '/settings?error=account_already_linked_to_different_user',
    )
    expect(await live(api, elsewhere)).toBe(true)
    expect(notices(api, 'b@x.test')).toEqual([])
  })

  test('is unlinked from a fresh session, only one of the member’s own, and the member is told', async () => {
    const api = await createTestApi({ oauth: { github: GITHUB } })
    const member = await signedIn(api, 'a@x.test')
    expect((await account(api, member, '/password', { newPassword: PASSWORD })).status).toBe(200)
    await linkGithub(api, member)
    const other = await anotherSession(api, member, 'a@x.test')
    const stranger = await signedIn(api, 'b@x.test')
    identity = { id: 5151, email: 'b@elsewhere.test' }
    await linkGithub(api, stranger)
    const ids = await api.db.all<{ id: string; user_id: string; provider_id: string }>(
      sql`select id, user_id, provider_id from account`,
    )
    const idOf = (userId: string, provider: string) =>
      ids.find((a) => a.user_id === userId && a.provider_id === provider)?.id
    const github = idOf(member.userId, 'github')

    await stale(api, other)
    const old = await account(api, other, '/unlink', { accountId: github })
    expect(old.status).toBe(403)
    // Not the member's, not a provider (a password is not removed here), not an account at all.
    for (const accountId of [
      idOf(stranger.userId, 'github'),
      idOf(member.userId, 'credential'),
      'no-such-account',
      undefined,
    ]) {
      const res = await account(api, member, '/unlink', { accountId })
      expect({ accountId, status: res.status }).toEqual({ accountId, status: 404 })
    }
    const unlinked = await account(api, member, '/unlink', { accountId: github })
    expect(unlinked.status).toBe(200)
    expect(
      await api.db.all(sql`select provider_id from account where user_id = ${member.userId}`),
    ).toEqual([{ provider_id: 'credential' }])
    expect(await (await account(api, member)).json()).toMatchObject({
      hasPassword: true,
      linked: [],
    })
    // Taking a way away ends no session: "sign out everywhere" does that.
    expect(await live(api, other)).toBe(true)
    expect(notices(api, 'a@x.test').at(-1)).toBe(
      'GitHub was removed from your Tela account · GitHub 已从你的 Tela 账号移除',
    )
    expect(
      await first<{ count: number }>(
        api.db,
        sql`select count from action_limits where key like 'accountUnlink:%'`,
      ),
    ).toEqual({ count: 1 })
  })

  test('links and unlinks are counted per member, ten an hour each', async () => {
    const api = await createTestApi({ oauth: { github: GITHUB } })
    const member = await signedIn(api, 'a@x.test')
    for (let i = 0; i < 10; i++) {
      expect((await account(api, member, '/link', { provider: 'github' })).status).toBe(200)
    }
    const refused = await account(api, member, '/link', { provider: 'github' })
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
    // A refused start writes no OAuth state: one row for each start allowed, beside no codes.
    expect(
      await first<{ n: number }>(
        api.db,
        sql`select count(*) as n from verification where identifier not like '%-otp-%'`,
      ),
    ).toEqual({ n: 10 })

    api.clock.advance(60 * 60 * 1000)
    await linkGithub(api, member)
    const [linked] = await api.db.all<{ id: string }>(
      sql`select id from account where user_id = ${member.userId}`,
    )
    for (let i = 0; i < 10; i++) {
      await consumeLimit(api.db, 'accountUnlink', member.userId, api.clock.now())
    }
    const unlink = await account(api, member, '/unlink', { accountId: linked?.id })
    expect(unlink.status).toBe(429)
    expect(await api.db.all(sql`select id from account`)).toEqual([{ id: linked?.id }])
  })
})

describe("a notice's language", () => {
  /** The member's interface language, as Settings would have saved it. */
  const speaks = (api: TestApi, as: SignedIn, locale: string) =>
    api.db.run(sql`update profiles set ui_locale = ${locale} where user_id = ${as.userId}`)
  /**
   * The member's client, in a browser that says another language: the notice is for whoever
   * holds the address, who may not be whoever made the change.
   */
  const elsewhere = (as: SignedIn): SignedIn => ({
    ...as,
    cookie: `${as.cookie}; tela_locale=zh-Hans`,
    headers: { ...as.headers, 'accept-language': 'zh-CN' },
  })

  test("is the member's interface language, with English beside it, whatever the browser says", async () => {
    const api = await createTestApi({ oauth: { github: GITHUB } })
    const member = await signedIn(api, 'a@x.test')
    await speaks(api, member, 'fr')
    const set = await account(api, elsewhere(member), '/password', { newPassword: PASSWORD })
    expect(set.status).toBe(200)
    await speaks(api, member, 'zh-Hant')
    const back = await linkGithub(api, elsewhere(member))
    expect(back.status).toBe(302)
    expect(notices(api, 'a@x.test')).toEqual([
      'Un mot de passe a été ajouté à votre compte Tela · A password was added to your Tela account',
      'GitHub 已連結到你的 Tela 帳號 · GitHub was linked to your Tela account',
    ])
    const [french] = api.mail.outbox.filter((m) => m.subject.startsWith('Un mot de passe'))
    expect(french?.text.split('\n').slice(2, 4)).toEqual([
      'Le compte Tela de a@x.test a désormais un mot de passe. Tous les autres appareils ont été déconnectés. Si c’était vous, il n’y a rien à faire.',
      'The Tela account for a@x.test now has a password. Every other device was signed out. If that was you, there is nothing to do.',
    ])
  })

  test("of a reset, is the member's, though its code followed the browser", async () => {
    const api = await createTestApi()
    const member = await signedIn(api, 'a@x.test')
    await speaks(api, member, 'zh-Hant')
    await api.request('/api/auth/email-otp/request-password-reset', {
      body: { email: 'a@x.test' },
      headers: { 'cf-connecting-ip': ip(), cookie: 'tela_locale=fr' },
    })
    expect(api.mail.outbox.at(-1)?.subject).toMatch(/^Réinitialiser votre mot de passe Tela · /)
    const reset = await api.request('/api/auth/email-otp/reset-password', {
      body: { email: 'a@x.test', otp: codeFor(api, 'a@x.test'), password: PASSWORD },
      headers: { 'cf-connecting-ip': ip(), cookie: 'tela_locale=fr' },
    })
    expect(reset.status).toBe(200)
    expect(notices(api, 'a@x.test')).toEqual([
      '你的 Tela 密碼已重設 · Your Tela password was reset',
    ])
  })
})

describe('signing out everywhere', () => {
  test('ends every other session of the member’s, from a stale session too, and is not counted', async () => {
    const api = await createTestApi()
    const member = await signedIn(api, 'a@x.test')
    const second = await anotherSession(api, member, 'a@x.test')
    const third = await anotherSession(api, member, 'a@x.test')
    const bystander = await signedIn(api, 'b@x.test')
    await stale(api, member)
    const res = await account(api, member, '/sign-out-everywhere', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ended: 2 })
    expect([
      await live(api, member),
      await live(api, second),
      await live(api, third),
      await live(api, bystander),
    ]).toEqual([true, false, false, true])
    expect(await (await account(api, member, '/sign-out-everywhere', {})).json()).toEqual({
      ended: 0,
    })
    expect(notices(api, 'a@x.test')).toEqual([])
    expect(
      await first(api.db, sql`select 1 as x from action_limits where key like 'account%'`),
    ).toBe(undefined)
  })
})
