/**
 * Google and GitHub sign-in (ADR 0036), each a whole round trip through better-auth: the start at
 * `/api/auth/sign-in/social`, the provider stood in for by a `fetch` that answers its token and
 * profile endpoints, and the return at `/api/auth/callback/<id>`. Every new account still passes
 * the invitation gate (ADR 0034), admitted only by the invite code its sign-in carried, which
 * travels in the OAuth state's server context.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  consumeLimit,
  createMemberCode,
  createOperatorCode,
  first,
  holdJoin,
  liveCode,
  revokeOperatorCode,
} from '@tela/data'
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

type Provider = 'google' | 'github'

const OAUTH = {
  google: { clientId: 'google-client', clientSecret: 'google-secret' },
  github: { clientId: 'github-client', clientSecret: 'github-secret' },
}

/** Who the providers say signed in: set per test, read by the stand-in below. */
let person: { id: string; email: string; verified: boolean }
/** Every provider endpoint the server called. */
let asked: string[]

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * The providers' token and profile endpoints. Google's ID token comes unsigned: better-auth reads
 * it from the token exchange it made itself, over TLS, and only decodes it. Each token is one Tela
 * must not keep.
 */
async function providers(input: Request | URL | string): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const endpoint = `${url.origin}${url.pathname}`
  asked.push(endpoint)
  switch (endpoint) {
    case 'https://oauth2.googleapis.com/token':
      return json({
        access_token: 'ya29.access-token',
        refresh_token: '1//refresh-token',
        expires_in: 3599,
        token_type: 'Bearer',
        scope: 'openid email',
        id_token: [
          b64url({ alg: 'RS256', typ: 'JWT' }),
          b64url({
            iss: 'https://accounts.google.com',
            aud: OAUTH.google.clientId,
            sub: person.id,
            email: person.email,
            email_verified: person.verified,
            name: 'A Real Name',
            picture: 'https://photos.example/real-face.jpg',
          }),
          'signature',
        ].join('.'),
      })
    case 'https://github.com/login/oauth/access_token':
      return json({ access_token: 'gho_access-token', token_type: 'bearer', scope: 'user:email' })
    case 'https://api.github.com/user':
      return json({
        id: Number(person.id),
        login: 'octo',
        name: 'A Real Name',
        email: null,
        avatar_url: 'https://photos.example/real-face.png',
      })
    case 'https://api.github.com/user/emails':
      return json([
        { email: 'old@work.example', primary: false, verified: true, visibility: null },
        { email: person.email, primary: true, verified: person.verified, visibility: 'private' },
      ])
  }
  throw new Error(`no provider answers ${endpoint}`)
}

let realFetch: typeof fetch
beforeEach(() => {
  person = { id: '4242', email: 'new@x.test', verified: true }
  asked = []
  realFetch = globalThis.fetch
  globalThis.fetch = providers as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

/**
 * better-auth logs a refused state, an unknown provider and a refused link; the answer it gives is
 * what these tests look at.
 */
async function quietly<T>(run: () => T | Promise<T>): Promise<T> {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  try {
    return await run()
  } finally {
    logged.mockRestore()
  }
}

/** Requests made so far, so each comes from an IP of its own. */
let requests = 0
const ip = () => {
  requests++
  return `198.51.${100 + (requests >> 8)}.${requests & 255}`
}

/**
 * A visitor at the sign-in sheet, each request from an IP of its own unless one is given, so the
 * per-IP limits stay out of the way of what is being tested.
 */
function visitor(api: TestApi) {
  return {
    /** Press "Continue with …": tela-api answers where to send the browser, and sets the cookie. */
    start: (
      provider: Provider,
      options: { invite?: unknown; body?: Record<string, unknown>; from?: string } = {},
    ) =>
      api.request('/api/auth/sign-in/social', {
        body: {
          provider,
          callbackURL: '/reading',
          newUserCallbackURL: '/discover',
          errorCallbackURL: '/join',
          disableRedirect: true,
          ...(options.invite === undefined ? {} : { additionalData: { invite: options.invite } }),
          ...options.body,
        },
        headers: { 'cf-connecting-ip': options.from ?? ip() },
      }),
    /**
     * Come back from the provider, which said yes: its redirect to the callback, a top-level GET
     * with no Origin, carrying the state cookie the start set unless told otherwise.
     */
    back: async (started: Response, options: { withCookie?: boolean } = {}) => {
      const { url } = (await started.clone().json()) as { url: string }
      const authorize = new URL(url)
      const provider = authorize.hostname === 'github.com' ? 'github' : 'google'
      const state = encodeURIComponent(authorize.searchParams.get('state') ?? '')
      return api.request(`/api/auth/callback/${provider}?code=from-the-provider&state=${state}`, {
        headers: {
          origin: undefined,
          cookie: options.withCookie === false ? undefined : cookiesOf(started),
          'cf-connecting-ip': ip(),
        },
      })
    },
  }
}

/** Start, and come back: the provider's redirect to the callback, as the browser follows it. */
async function roundTrip(api: TestApi, provider: Provider, invite?: string) {
  const v = visitor(api)
  const started = await v.start(provider, invite === undefined ? {} : { invite })
  expect(started.status).toBe(200)
  return v.back(started)
}

const count = async (api: TestApi, table: 'user' | 'account' | 'verification') =>
  (await first<{ n: number }>(api.db, sql`select count(*) as n from ${sql.raw(table)}`))?.n

const redemptions = (api: TestApi) =>
  api.db.all<{ code: string | null; email: string; redeemed: number; settled: number }>(
    sql`select code, email, redeemed_at is not null as redeemed, settled_at is not null as settled
      from invite_redemptions order by id`,
  )

describe('Google and GitHub', () => {
  test('are offered only once their apps are configured', async () => {
    const none = await createTestApi()
    const offered = await none.request('/api/v1/public/auth')
    expect(offered.status).toBe(200)
    expect(offered.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await offered.json()).toEqual({ google: false, github: false })
    expect((await quietly(() => visitor(none).start('github'))).status).toBe(404)

    const github = await createTestApi({ oauth: { github: OAUTH.github } })
    expect(await (await github.request('/api/v1/public/auth')).json()).toEqual({
      google: false,
      github: true,
    })
    expect((await quietly(() => visitor(github).start('google'))).status).toBe(404)
    expect((await visitor(github).start('github')).status).toBe(200)
  })

  test('ask for an address and nothing more, and tie the return to the browser that left', async () => {
    const api = await createTestApi({ oauth: OAUTH })
    const v = visitor(api)
    const authorizeOf = async (res: Response) => {
      expect(res.status).toBe(200)
      const body = (await res.clone().json()) as { url: string; redirect: boolean }
      expect(body.redirect).toBe(false)
      return new URL(body.url)
    }
    const github = await v.start('github')
    const atGithub = await authorizeOf(github)
    expect(`${atGithub.origin}${atGithub.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    )
    expect(atGithub.searchParams.get('client_id')).toBe('github-client')
    expect(atGithub.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`)
    expect(atGithub.searchParams.get('scope')).toBe('user:email')
    // The state names a row in D1, and a signed cookie as long-lived as the row ties it to this
    // browser.
    const state = atGithub.searchParams.get('state') ?? ''
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const cookie = github.headers.getSetCookie().find((c) => c.startsWith('tela.state='))
    expect(cookie).toContain('Max-Age=600')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    const row = await first<{ expires_at: number }>(
      api.db,
      sql`select expires_at from verification where identifier = ${state}`,
    )
    expect(row?.expires_at).toBeGreaterThan(Date.now() + 9 * 60_000)

    const atGoogle = await authorizeOf(await v.start('google'))
    expect(`${atGoogle.origin}${atGoogle.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    expect(atGoogle.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`)
    expect(atGoogle.searchParams.get('scope')).toBe('openid email')
    expect(atGoogle.searchParams.get('prompt')).toBe('select_account')
    // Nothing reached either provider: the browser goes there, not tela-api.
    expect(asked).toEqual([])
  })

  test.each(['google', 'github'] as const)(
    '%s makes an account with the invite code it carried: verified, nameless, keeping no token, and told to the address',
    async (provider) => {
      const api = await createTestApi({ oauth: OAUTH })
      await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 2, now: api.clock.now() })
      // Typed as a member types it: normalized like a join's.
      const back = await roundTrip(api, provider, 'wel-come')
      expect(back.status).toBe(302)
      expect(back.headers.get('location')).toBe('/discover')
      const cookie = cookiesOf(back)
      expect(cookie).toContain('tela.session_token=')
      const me = await api.request('/api/v1/me', { cookie })
      const member = (await me.json()) as { id: string; email: string; profile: { handle: string } }
      expect(member.email).toBe('new@x.test')
      expect(member.profile.handle).toMatch(/^u_[0-9a-f]{10}$/)
      // The provider's name and picture are not the member's profile, nor in the session cookie.
      expect(
        await first<{ name: string; image: string | null; email_verified: number }>(
          api.db,
          sql`select name, image, email_verified from user where id = ${member.id}`,
        ),
      ).toEqual({ name: '', image: null, email_verified: 1 })
      const account = sql`select provider_id, account_id, access_token, refresh_token, id_token,
        access_token_expires_at, refresh_token_expires_at, password
        from account where user_id = ${member.id}`
      const kept = {
        provider_id: provider,
        account_id: '4242',
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        password: null,
      }
      expect(await api.db.all(account)).toEqual([kept])
      expect(await redemptions(api)).toEqual([
        { code: 'WELCOME', email: 'new@x.test', redeemed: 1, settled: 1 },
      ])
      // The address is told, with no code and no link that signs anyone in.
      const name = provider === 'github' ? 'GitHub' : 'Google'
      expect(api.mail.outbox).toHaveLength(1)
      const [notice] = api.mail.outbox
      expect(notice?.to).toBe('new@x.test')
      expect(notice?.subject).toBe(
        `Your Tela account was made with ${name} · 你的 Tela 账号已通过 ${name} 创建`,
      )
      expect(notice?.text).toContain(`${ORIGIN}/login with a code`)
      expect(notice?.text).not.toMatch(/^\d{6}$/m)
      expect(notice?.text).not.toContain('otp=')

      // The next time it signs straight in, to where the member was going, with no invite, no
      // place spent, no notice, and still no token.
      const again = await roundTrip(api, provider)
      expect(again.status).toBe(302)
      expect(again.headers.get('location')).toBe('/reading')
      expect(cookiesOf(again)).toContain('tela.session_token=')
      expect(await api.db.all(account)).toEqual([kept])
      expect(await redemptions(api)).toHaveLength(1)
      expect(api.mail.outbox).toHaveLength(1)
      expect(await liveCode(api.db, 'WELCOME')).toEqual({ places: 2, full: false })
    },
  )

  test('make nothing without an invite code, even for an address that holds a hold', async () => {
    const api = await createTestApi({ oauth: OAUTH })
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 5, now: api.clock.now() })
    // Anyone with a code may place a hold on any address: only a code from that mailbox spends it.
    expect(
      await holdJoin(api.db, { code: 'WELCOME', email: 'new@x.test', now: api.clock.now() }),
    ).toBe('held')
    const back = await roundTrip(api, 'github')
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/join?error=invite_required')
    expect(back.headers.getSetCookie().some((c) => c.startsWith('tela.session_token='))).toBe(false)
    expect([await count(api, 'user'), await count(api, 'account')]).toEqual([0, 0])
    expect(await redemptions(api)).toEqual([
      { code: 'WELCOME', email: 'new@x.test', redeemed: 0, settled: 0 },
    ])
    expect(api.mail.outbox).toEqual([])
  })

  test('make nothing with a code filled or withdrawn while the visitor was at the provider', async () => {
    const api = await createTestApi({ oauth: OAUTH })
    const inviter = await signedIn(api, 'inviter@x.test')
    const made = await createMemberCode(api.db, { userId: inviter.userId, now: api.clock.now() })
    if (!made.ok) throw new Error('no code')
    const v = visitor(api)
    const started = await v.start('github', { invite: made.code })
    expect(started.status).toBe(200)
    // Someone else joins with the same code, by email, and takes its one place.
    const joined = await api.request('/api/v1/join', {
      body: { code: made.code, email: 'quick@x.test' },
      headers: { 'cf-connecting-ip': '203.0.113.1' },
    })
    expect(joined.status).toBe(200)
    const quick = await api.request('/api/auth/sign-in/email-otp', {
      body: { email: 'quick@x.test', otp: codeFor(api, 'quick@x.test') },
      headers: { 'cf-connecting-ip': '203.0.113.2' },
    })
    expect(quick.status).toBe(200)
    const back = await v.back(started)
    expect(back.headers.get('location')).toBe('/join?error=invite_unavailable')
    expect(await first(api.db, sql`select 1 as x from user where email = 'new@x.test'`)).toBe(
      undefined,
    )

    // And an operator's code withdrawn meanwhile.
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 5, now: api.clock.now() })
    const later = await v.start('google', { invite: 'WELCOME' })
    await revokeOperatorCode(api.db, { code: 'WELCOME', now: api.clock.now() })
    expect((await v.back(later)).headers.get('location')).toBe('/join?error=invite_unavailable')
    expect(await first(api.db, sql`select 1 as x from user where email = 'new@x.test'`)).toBe(
      undefined,
    )
  })

  test('answer a member whose provider is not linked as they answer an address the provider has not verified', async () => {
    const api = await createTestApi({ oauth: OAUTH })
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 5, now: api.clock.now() })
    const member: SignedIn = await signedIn(api, 'member@x.test')
    const answers: (string | null)[] = []
    const answer = async (provider: Provider, invite?: string) => {
      const back = await quietly(() => roundTrip(api, provider, invite))
      expect(back.status).toBe(302)
      expect(back.headers.getSetCookie().some((c) => c.startsWith('tela.session_token='))).toBe(
        false,
      )
      answers.push(back.headers.get('location'))
    }
    // The member's own address, verified by the provider: linking is explicit only, from Settings,
    // so this is not a way into their account, invite code or not.
    person = { id: '1001', email: 'member@x.test', verified: true }
    await answer('github')
    await answer('github', 'WELCOME')
    await answer('google', 'WELCOME')
    // An address the provider has not verified: GitHub's primary one, and Google's.
    person = { id: '1002', email: 'new@x.test', verified: false }
    await answer('github', 'WELCOME')
    await answer('github')
    await answer('google', 'WELCOME')
    expect(answers).toEqual(Array(6).fill('/join?error=account_not_linked'))
    expect(await count(api, 'account')).toBe(0)
    expect(await count(api, 'user')).toBe(1)
    expect(
      await first<{ email_verified: number }>(
        api.db,
        sql`select email_verified from user where id = ${member.userId}`,
      ),
    ).toEqual({ email_verified: 1 })
    expect(await liveCode(api.db, 'WELCOME')).toEqual({ places: 5, full: false })
    expect(await redemptions(api)).toEqual([
      { code: null, email: 'member@x.test', redeemed: 1, settled: 1 },
    ])
  })

  test('refuse a return without its state cookie, and the same return twice', async () => {
    const api = await createTestApi({ oauth: OAUTH })
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 5, now: api.clock.now() })
    const v = visitor(api)
    const started = await v.start('github', { invite: 'WELCOME' })
    // Another browser, or a link someone sent: the state is right, the cookie is not there. It
    // goes back to the page that started the flow, and the flow is still the visitor's to finish.
    const elsewhere = await quietly(() => v.back(started, { withCookie: false }))
    expect(elsewhere.headers.get('location')).toBe('/join?error=state_mismatch')
    expect(await count(api, 'user')).toBe(0)
    const back = await v.back(started)
    expect(back.headers.get('location')).toBe('/discover')
    // The state row is gone with its first use: a replay is refused before anything is asked.
    asked = []
    const replayed = await quietly(() => v.back(started))
    expect(replayed.headers.get('location')).toBe(`${ORIGIN}/login?error=state_mismatch`)
    expect(asked).toEqual([])
    expect(await count(api, 'user')).toBe(1)
    expect(await count(api, 'verification')).toBe(0)
  })

  test('refuse a return URL that is not Tela’s, and every field but their own', async () => {
    const api = await createTestApi({ oauth: OAUTH })
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 5, now: api.clock.now() })
    const v = visitor(api)
    for (const field of ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL']) {
      const res = await quietly(() =>
        v.start('github', { body: { [field]: 'https://elsewhere.example/landing' } }),
      )
      expect({ field, status: res.status }).toEqual({ field, status: 403 })
    }
    const refused: Record<string, unknown>[] = [
      { scopes: ['repo', 'read:org'] },
      { additionalParams: { access_type: 'offline' } },
      { loginHint: 'someone@x.test' },
      { requestSignUp: true },
      // An ID token signs in with no state at all.
      { idToken: { token: 'header.payload.signature' } },
      { additionalData: { invite: 'WELCOME', next: '/admin' } },
      { additionalData: 'WELCOME' },
      { additionalData: { invite: 12345678 } },
    ]
    for (const body of refused) {
      const res = await v.start('google', { body })
      expect({ body, status: res.status }).toEqual({ body, status: 400 })
      expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
    // No state was written for any of them, so none can come back.
    expect(await count(api, 'verification')).toBe(0)
    // And neither provider would take an ID token were one let through.
    const ctx = await api.auth.$context
    expect(ctx.socialProviders.map((p) => [p.id, p.options?.disableIdTokenSignIn])).toEqual([
      ['google', true],
      ['github', true],
    ])
  })

  test('check the invite code before anyone is sent away, counted like a join', async () => {
    const api = await createTestApi({ oauth: OAUTH })
    const now = api.clock.now()
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 1, now })
    await createOperatorCode(api.db, { code: 'GONE', maxUses: 5, now })
    await revokeOperatorCode(api.db, { code: 'GONE', now })
    const v = visitor(api)
    for (const invite of ['NOSUCH', 'GONE', '#!', '']) {
      const res = await v.start('github', { invite })
      expect({ invite, status: res.status }).toEqual({ invite, status: 400 })
      expect(await res.json()).toMatchObject({ code: 'INVALID_CODE' })
    }
    await api.request('/api/v1/join', {
      body: { code: 'WELCOME', email: 'first@x.test' },
      headers: { 'cf-connecting-ip': '203.0.113.1' },
    })
    await api.request('/api/auth/sign-in/email-otp', {
      body: { email: 'first@x.test', otp: codeFor(api, 'first@x.test') },
      headers: { 'cf-connecting-ip': '203.0.113.2' },
    })
    const full = await v.start('github', { invite: 'welcome' })
    expect(full.status).toBe(409)
    expect(await full.json()).toMatchObject({ code: 'INVITE_USED' })
    expect(await count(api, 'verification')).toBe(0)

    // A guess here is a guess at a join: it spends the IP's ten an hour, which a join shares.
    await createOperatorCode(api.db, { code: 'SECOND', maxUses: 5, now })
    for (let i = 0; i < 10; i++) {
      await api.request('/api/v1/join', {
        body: { code: 'NOTACODE', email: 'guess@x.test' },
        headers: { 'cf-connecting-ip': '203.0.113.9' },
      })
    }
    const guessing = await v.start('github', { invite: 'SECOND', from: '203.0.113.9' })
    expect(guessing.status).toBe(429)
    // A sign-in without a code guesses nothing, and spends nothing of it.
    expect((await v.start('github', { from: '203.0.113.9' })).status).toBe(200)
    // And a live code's own hour, as many as its places and at least twenty, is a join's too.
    for (let i = 0; i < 20; i++) await consumeLimit(api.db, 'joinCode', 'SECOND', now)
    expect((await v.start('github', { invite: 'SECOND' })).status).toBe(429)
  })

  test('the gate admits a provider’s return only by the code in its OAuth state', async () => {
    const api = await createTestApi({ oauth: OAUTH })
    await createOperatorCode(api.db, { code: 'WELCOME', maxUses: 5, now: api.clock.now() })
    const gate = api.auth.options.databaseHooks?.user?.create?.before
    if (!gate) throw new Error('no gate')
    const user = (emailVerified: boolean) => ({
      id: 'someone',
      email: 'new@x.test',
      name: 'A Real Name',
      image: 'https://photos.example/real-face.jpg',
      emailVerified,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const returned = { path: '/callback/:id', params: { id: 'github' } } as unknown as Parameters<
      typeof gate
    >[1]
    // Outside a request there is no OAuth state at all: no code, so no account.
    await expect(gate(user(true), returned)).rejects.toMatchObject({
      body: { code: 'invite_required' },
    })
    await expect(gate(user(false), returned)).rejects.toMatchObject({
      body: { code: 'account_not_linked' },
    })
    expect(await redemptions(api)).toEqual([])
  })
})
