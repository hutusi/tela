/**
 * Invite codes over HTTP (ADR 0034): a visitor's join, a member's five, and the operator's codes.
 * The statements under them are run on libSQL and D1 by the data contract suite; this is what the
 * routes make of them, through the code sign-in that turns a hold into an account.
 */
import { describe, expect, test } from 'bun:test'
import { first } from '@tela/data'
import { groupInviteCode, INVITE_ALLOWANCE, INVITE_ALPHABET } from '@tela/shared'
import { sql } from 'drizzle-orm'
import {
  ADMIN_TOKEN,
  codeFor,
  cookiesOf,
  createTestApi,
  memberHeaders,
  type SignedIn,
  signedIn,
  type TestApi,
} from './helpers'

const HOUR = 60 * 60 * 1000
const MEMBER_CODE = new RegExp(`^[${INVITE_ALPHABET}]{12}$`)

/**
 * A visitor's requests as the reader's browser sends them: no session, and each from an IP of its
 * own unless one is given, so the per-IP limits stay out of the way of what is being tested.
 */
function door(api: TestApi) {
  let n = 0
  const ip = () => {
    n++
    return `198.51.${100 + (n >> 8)}.${n & 255}`
  }
  return {
    join: (code: unknown, email: unknown, from = ip()) =>
      api.request('/api/v1/join', {
        body: { code, email },
        headers: { 'cf-connecting-ip': from },
      }),
    /** Ask for a sign-in code as the login page does. */
    ask: (email: string) =>
      api.request('/api/auth/email-otp/send-verification-otp', {
        body: { email, type: 'sign-in' },
        headers: { 'cf-connecting-ip': ip() },
      }),
    /** Sign in with the newest code mailed to `email`. */
    signIn: (email: string) =>
      api.request('/api/auth/sign-in/email-otp', {
        body: { email, otp: codeFor(api, email) },
        headers: { 'cf-connecting-ip': ip() },
      }),
  }
}

/** A new code of the member's, as Settings makes it. */
async function newCode(api: TestApi, as: SignedIn): Promise<string> {
  const res = await api.request('/api/v1/invites', { method: 'POST', as })
  expect(res.status).toBe(200)
  return ((await res.json()) as { code: string }).code
}

type Listed = {
  allowance: number
  codes: { code: string; createdAt: number; joinedAt: number | null; handle: string | null }[]
}
const listOf = async (api: TestApi, as: SignedIn) =>
  (await (await api.request('/api/v1/invites', { as })).json()) as Listed

const revoke = (api: TestApi, as: SignedIn, code: string) =>
  api.request(`/api/v1/invites/${encodeURIComponent(code)}`, { method: 'DELETE', as })

const operator = (
  api: TestApi,
  init: { method?: string; path?: string; body?: unknown; token?: string } = {},
) =>
  api.request(`/api/admin/codes${init.path ?? ''}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
    headers: { authorization: `Bearer ${init.token ?? ADMIN_TOKEN}` },
  })

const mailsTo = (api: TestApi, email: string) => api.mail.outbox.filter((m) => m.to === email)
const isMember = async (api: TestApi, email: string) =>
  (await first(api.db, sql`select 1 as x from user where email = ${email}`)) !== undefined
const count = async (api: TestApi, table: 'user' | 'invite_redemptions' | 'action_limits') =>
  (await first<{ n: number }>(api.db, sql`select count(*) as n from ${sql.raw(table)}`))?.n

describe("joining with a member's code", () => {
  test('a visitor joins, signs in, and the inviter sees their handle, never their address', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    expect(await listOf(api, inviter)).toEqual({ allowance: INVITE_ALLOWANCE, codes: [] })
    const made = await api.request('/api/v1/invites', { method: 'POST', as: inviter })
    const now = api.clock.now()
    const answer = (await made.json()) as Listed['codes'][number]
    expect(answer).toEqual({
      code: expect.any(String),
      createdAt: now,
      joinedAt: null,
      handle: null,
    })
    expect(answer.code).toMatch(MEMBER_CODE)
    expect((await listOf(api, inviter)).codes).toEqual([
      { code: answer.code, createdAt: now, joinedAt: null, handle: null },
    ])

    // Typed as people type a code read out to them: in groups, in lower case.
    const d = door(api)
    const joined = await d.join(groupInviteCode(answer.code).toLowerCase(), ' New@X.test ')
    expect(joined.status).toBe(200)
    expect(await joined.json()).toEqual({ ok: true })
    expect(mailsTo(api, 'new@x.test').map((m) => m.subject)).toEqual([
      `You are invited to Tela · 邀请你加入 Tela: ${codeFor(api, 'new@x.test')}`,
    ])
    // A hold takes no place, and a pending address is never shown.
    const pending = await listOf(api, inviter)
    expect(pending.codes).toEqual([
      { code: answer.code, createdAt: now, joinedAt: null, handle: null },
    ])
    expect(JSON.stringify(pending)).not.toContain('new@x.test')

    api.clock.advance(HOUR)
    const signIn = await d.signIn('new@x.test')
    expect(signIn.status).toBe(200)
    const me = (await (await api.request('/api/v1/me', { cookie: cookiesOf(signIn) })).json()) as {
      id: string
      profile: { handle: string }
    }
    expect((await listOf(api, inviter)).codes).toEqual([
      { code: answer.code, createdAt: now, joinedAt: now + HOUR, handle: me.profile.handle },
    ])
    expect(
      await api.db.all(sql`select code, user_id, settled_at is not null as settled
        from invite_redemptions where email = 'new@x.test'`),
    ).toEqual([{ code: answer.code, user_id: me.id, settled: 1 }])

    // The invitee has five of their own.
    const invitee = { cookie: cookiesOf(signIn), userId: me.id, headers: memberHeaders(me.id) }
    expect(await newCode(api, invitee)).toMatch(MEMBER_CODE)
  })

  test('an unknown or revoked code is refused, and mails nothing', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    const d = door(api)
    const unknown = await d.join('ABCD-EFGH-JKMN', 'new@x.test')
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({ error: 'invalid_code' })

    const code = await newCode(api, inviter)
    expect((await revoke(api, inviter, code)).status).toBe(200)
    const revoked = await d.join(code, 'new@x.test')
    expect(revoked.status).toBe(400)
    expect(await revoked.json()).toEqual({ error: 'invalid_code' })
    expect(mailsTo(api, 'new@x.test')).toEqual([])
    expect(await count(api, 'invite_redemptions')).toBe(1) // the inviter's own, from the operator
  })

  test('revoking a code cancels a pending joiner: their code then signs nobody in', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    const d = door(api)
    const code = await newCode(api, inviter)
    expect((await d.join(code, 'new@x.test')).status).toBe(200)
    expect((await revoke(api, inviter, code)).status).toBe(200)
    const late = await d.signIn('new@x.test')
    expect(late.status).toBe(403)
    expect(await late.json()).toMatchObject({ code: 'INVITE_REQUIRED' })
    expect(await isMember(api, 'new@x.test')).toBe(false)
    // Nor is the address mailed again.
    const mailed = api.mail.outbox.length
    await d.ask('new@x.test')
    expect(api.mail.outbox).toHaveLength(mailed)
  })

  test('a used code is 409, for a newcomer and a member alike, and mails nothing', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    await signedIn(api, 'member@x.test')
    const d = door(api)
    const code = await newCode(api, inviter)
    await d.join(code, 'a@x.test')
    expect((await d.signIn('a@x.test')).status).toBe(200)
    const mailed = api.mail.outbox.length
    for (const email of ['b@x.test', 'member@x.test']) {
      const used = await d.join(code, email)
      expect(used.status).toBe(409)
      expect(await used.json()).toEqual({ error: 'code_used' })
    }
    expect(api.mail.outbox).toHaveLength(mailed)
    expect(await isMember(api, 'b@x.test')).toBe(false)
  })

  test('two addresses on one code: the later join moves the hold, and one account results', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    const d = door(api)
    const code = await newCode(api, inviter)
    // A typo first, then the address meant: both are mailed, and only the later can finish.
    expect((await d.join(code, 'friend@x.tset')).status).toBe(200)
    expect((await d.join(code, 'friend@x.test')).status).toBe(200)
    expect(mailsTo(api, 'friend@x.tset')).toHaveLength(1)
    const typo = await d.signIn('friend@x.tset')
    expect(typo.status).toBe(403)
    expect(await typo.json()).toMatchObject({ code: 'INVITE_REQUIRED' })
    expect((await d.signIn('friend@x.test')).status).toBe(200)
    expect([await isMember(api, 'friend@x.tset'), await isMember(api, 'friend@x.test')]).toEqual([
      false,
      true,
    ])
    expect(await count(api, 'user')).toBe(2)
  })

  test('an address that has an account is mailed a plain code, and leaves the code alone', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    await signedIn(api, 'member@x.test')
    const d = door(api)
    const code = await newCode(api, inviter)
    const member = await d.join(code, 'Member@x.test')
    const newcomer = await d.join(code, 'new@x.test')
    // The same answer for both, so a join says nothing of who has an account.
    expect([member.status, newcomer.status]).toEqual([200, 200])
    expect(await member.json()).toEqual(await newcomer.json())
    expect(mailsTo(api, 'member@x.test').at(-1)?.subject).toContain('sign-in code')
    expect(
      await api.db.all(sql`select email from invite_redemptions where code = ${code}`),
    ).toEqual([{ email: 'new@x.test' }])
    expect((await d.signIn('member@x.test')).status).toBe(200)
    // The member signed in, and the code still had its place for the newcomer.
    expect((await listOf(api, inviter)).codes[0]?.joinedAt).toBeNull()
    expect((await d.signIn('new@x.test')).status).toBe(200)
    expect((await listOf(api, inviter)).codes[0]?.handle).toMatch(/^u_/)
  })

  test("the code mail is in the joiner's language, with English beside it", async () => {
    const api = await createTestApi()
    expect((await operator(api, { body: { code: 'WELCOME', uses: 5 } })).status).toBe(200)
    let n = 0
    const join = (email: string, headers: Record<string, string>) =>
      api.request('/api/v1/join', {
        body: { code: 'WELCOME', email },
        headers: { 'cf-connecting-ip': `203.0.113.${++n}`, ...headers },
      })
    const subjectOf = (email: string) => mailsTo(api, email).at(-1)?.subject
    // The language the visitor picked here, over what their browser says…
    const picked = await join('tw@x.test', {
      cookie: 'tela.session_data=x; tela_locale=zh-Hant',
      'accept-language': 'fr',
    })
    expect(picked.status).toBe(200)
    expect(subjectOf('tw@x.test')).toBe(
      `邀請你加入 Tela · You are invited to Tela: ${codeFor(api, 'tw@x.test')}`,
    )
    // …else what their browser says…
    await join('fr@x.test', { 'accept-language': 'fr-FR,fr;q=0.9' })
    expect(subjectOf('fr@x.test')).toBe(
      `Votre invitation à rejoindre Tela · You are invited to Tela: ${codeFor(api, 'fr@x.test')}`,
    )
    // …else English and Simplified, as before.
    await join('en@x.test', { cookie: 'theme=dark' })
    expect(subjectOf('en@x.test')).toBe(
      `You are invited to Tela · 邀请你加入 Tela: ${codeFor(api, 'en@x.test')}`,
    )
    // A member who joins again is mailed a plain code, in their language too.
    await signedIn(api, 'member@x.test')
    await join('member@x.test', { cookie: 'tela_locale=zh-Hans' })
    expect(subjectOf('member@x.test')).toBe(
      `Tela 登录验证码 · Your Tela sign-in code: ${codeFor(api, 'member@x.test')}`,
    )
  })
})

describe("the operator's codes", () => {
  test('a code with two places admits two people, and the third is told it is used', async () => {
    const api = await createTestApi()
    const made = await operator(api, { body: { code: 'Welcome-2026', uses: 2 } })
    expect(made.status).toBe(200)
    expect(await made.json()).toEqual({ code: 'WELCOME2026', maxUses: 2 })
    const d = door(api)
    for (const email of ['a@x.test', 'b@x.test']) {
      expect((await d.join('welcome 2026', email)).status).toBe(200)
      expect((await d.signIn(email)).status).toBe(200)
    }
    const third = await d.join('WELCOME2026', 'c@x.test')
    expect(third.status).toBe(409)
    expect(await third.json()).toEqual({ error: 'code_used' })
    expect(mailsTo(api, 'c@x.test')).toEqual([])
    const listed = await operator(api)
    expect(listed.headers.get('cache-control')).toBe('no-store')
    expect(await listed.json()).toEqual({
      codes: [
        {
          code: 'WELCOME2026',
          maxUses: 2,
          uses: 2,
          holds: 0,
          createdAt: api.clock.now(),
          revokedAt: null,
        },
      ],
    })
  })

  test('a mistyped address holds no place on it', async () => {
    const api = await createTestApi()
    await operator(api, { body: { code: 'PAIR', uses: 2 } })
    const d = door(api)
    expect((await d.join('PAIR', 'a@x.tset')).status).toBe(200)
    for (const email of ['a@x.test', 'b@x.test']) {
      expect((await d.join('PAIR', email)).status).toBe(200)
      expect((await d.signIn(email)).status).toBe(200)
    }
    // Both places went to people who signed in; the typo, which never could, is told it is used.
    const typo = await d.signIn('a@x.tset')
    expect(typo.status).toBe(403)
    expect(await typo.json()).toMatchObject({ code: 'INVITE_USED' })
  })

  test('revoking one stops new joins and cancels holds; who joined stays', async () => {
    const api = await createTestApi()
    await operator(api, { body: { code: 'SPRING', uses: 5 } })
    const d = door(api)
    await d.join('SPRING', 'a@x.test')
    expect((await d.signIn('a@x.test')).status).toBe(200)
    await d.join('SPRING', 'b@x.test')
    const revoked = await operator(api, { method: 'DELETE', path: '/spring' })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ ok: true })
    expect((await d.signIn('b@x.test')).status).toBe(403)
    expect((await d.join('SPRING', 'c@x.test')).status).toBe(400)
    expect(await isMember(api, 'a@x.test')).toBe(true)
    expect(await (await operator(api)).json()).toMatchObject({
      codes: [{ code: 'SPRING', uses: 1, holds: 0, revokedAt: api.clock.now() }],
    })
    // Once is enough: an unknown, revoked or member's code is a 404.
    expect((await operator(api, { method: 'DELETE', path: '/SPRING' })).status).toBe(404)
    expect((await operator(api, { method: 'DELETE', path: '/NOPE' })).status).toBe(404)
    const inviter = await signedIn(api, 'inviter@x.test')
    const members = await newCode(api, inviter)
    expect((await operator(api, { method: 'DELETE', path: `/${members}` })).status).toBe(404)
    expect((await listOf(api, inviter)).codes).toHaveLength(1)
  })

  test('are made one of a kind, of a shape no member code has, with a sensible number of places', async () => {
    const api = await createTestApi()
    const refused = async (body: unknown) => {
      const res = await operator(api, { body })
      expect(res.status).toBe(400)
      return ((await res.json()) as { error: string }).error
    }
    expect(await refused({ code: 'ab' })).toBe('invalid_code')
    expect(await refused({ code: 'x'.repeat(33) })).toBe('invalid_code')
    expect(await refused({ code: 'café' })).toBe('invalid_code')
    // Twelve of a member code's symbols would say it is a member's.
    expect(await refused({ code: 'ABCD-EFGH-JKMN' })).toBe('member_shaped')
    for (const uses of [0, 100_001, 1.5, '2', null]) {
      expect(await refused({ code: 'OKAY', uses })).toBe('invalid_uses')
    }
    expect(await count(api, 'invite_redemptions')).toBe(0)
    // One place unless told, and one code of a text however it is typed.
    expect(await (await operator(api, { body: { code: 'once' } })).json()).toEqual({
      code: 'ONCE',
      maxUses: 1,
    })
    const again = await operator(api, { body: { code: 'O-N-C-E', uses: 3 } })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'code_exists' })
  })

  test('need the admin token', async () => {
    const api = await createTestApi()
    const calls = [
      { body: { code: 'WELCOME' } },
      {},
      { method: 'DELETE', path: '/WELCOME' },
    ] as const
    for (const init of calls) {
      expect((await operator(api, { ...init, token: 'wrong' })).status).toBe(403)
    }
    const closed = await createTestApi({ adminToken: undefined })
    for (const init of calls) expect((await operator(closed, init)).status).toBe(403)
    expect(await first(api.db, sql`select 1 as x from invite_codes`)).toBeUndefined()
  })
})

describe("a member's five", () => {
  test('five codes, then 409; an unused one revoked frees its place, a used one counts for good', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    const codes: string[] = []
    for (let i = 0; i < INVITE_ALLOWANCE; i++) codes.push(await newCode(api, inviter))
    expect(new Set(codes).size).toBe(INVITE_ALLOWANCE)
    const sixth = await api.request('/api/v1/invites', { method: 'POST', as: inviter })
    expect(sixth.status).toBe(409)
    expect(await sixth.json()).toEqual({ error: 'allowance_used' })

    const [used, unused] = codes as [string, string]
    const d = door(api)
    await d.join(used, 'a@x.test')
    expect((await d.signIn('a@x.test')).status).toBe(200)
    expect((await revoke(api, inviter, used)).status).toBe(404)
    const revoked = await revoke(api, inviter, groupInviteCode(unused))
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ ok: true })
    expect((await revoke(api, inviter, unused)).status).toBe(404)
    const replacement = await newCode(api, inviter)
    expect((await api.request('/api/v1/invites', { method: 'POST', as: inviter })).status).toBe(409)
    const listed = (await listOf(api, inviter)).codes.map((c) => c.code)
    expect(listed).toHaveLength(INVITE_ALLOWANCE)
    expect(listed).toContain(used)
    expect(listed).toContain(replacement)
    expect(listed).not.toContain(unused)
  })

  test('a member can revoke only their own, and lists only their own', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    const other = await signedIn(api, 'other@x.test')
    const code = await newCode(api, inviter)
    const theirs = await revoke(api, other, code)
    expect(theirs.status).toBe(404)
    expect(await theirs.json()).toEqual({ error: 'not_found' })
    expect((await revoke(api, other, 'not a code!')).status).toBe(404)
    expect((await listOf(api, other)).codes).toEqual([])
    expect((await listOf(api, inviter)).codes.map((c) => c.code)).toEqual([code])
  })

  test('making codes is limited per member, since every revoked one stays a row', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    for (let i = 0; i < 20; i++)
      expect((await revoke(api, inviter, await newCode(api, inviter))).status).toBe(200)
    const refused = await api.request('/api/v1/invites', { method: 'POST', as: inviter })
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
    api.clock.advance(HOUR)
    expect(await newCode(api, inviter)).toMatch(MEMBER_CODE)
  })

  test('the routes need a session; joining needs none', async () => {
    const api = await createTestApi()
    const inviter = await signedIn(api, 'inviter@x.test')
    const code = await newCode(api, inviter)
    for (const init of [{}, { method: 'POST' }]) {
      const res = await api.request('/api/v1/invites', init)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
    expect((await api.request(`/api/v1/invites/${code}`, { method: 'DELETE' })).status).toBe(401)
    expect((await listOf(api, inviter)).codes).toHaveLength(1)
    expect((await door(api).join(code, 'new@x.test')).status).toBe(200)
  })
})

describe('the join request', () => {
  test('a malformed address or code is refused before anything is counted, held or mailed', async () => {
    const api = await createTestApi()
    await operator(api, { body: { code: 'WELCOME', uses: 5 } })
    const d = door(api)
    const refused = async (code: unknown, email: unknown) => {
      const res = await d.join(code, email)
      expect(res.status).toBe(400)
      return ((await res.json()) as { error: string }).error
    }
    expect(await refused('WELCOME', undefined)).toBe('invalid_email')
    expect(await refused('WELCOME', 'not-an-address')).toBe('invalid_email')
    // What better-auth would refuse to mail or sign in is refused here, before a hold is written.
    expect(await refused('WELCOME', 'a..b@x.test')).toBe('invalid_email')
    expect(await refused('WELCOME', `${'a'.repeat(250)}@x.test`)).toBe('invalid_email')
    expect(await refused(undefined, 'a@x.test')).toBe('invalid_code')
    expect(await refused('ab', 'a@x.test')).toBe('invalid_code')
    expect(await refused(42, 'a@x.test')).toBe('invalid_code')
    const junk = await api.request('/api/v1/join', {
      raw: 'null',
      headers: { 'content-type': 'application/json' },
    })
    expect(junk.status).toBe(400)
    expect(await count(api, 'action_limits')).toBe(0)
    expect(await count(api, 'invite_redemptions')).toBe(0)
    expect(api.mail.outbox).toEqual([])
  })

  test('joining again refreshes the one hold', async () => {
    const api = await createTestApi()
    await operator(api, { body: { code: 'WELCOME', uses: 5 } })
    const d = door(api)
    await d.join('WELCOME', 'a@x.test')
    api.clock.advance(HOUR)
    await d.join('WELCOME', 'A@x.test')
    expect(await api.db.all(sql`select email, expires_at from invite_redemptions`)).toEqual([
      { email: 'a@x.test', expires_at: api.clock.now() + 24 * HOUR },
    ])
    expect(mailsTo(api, 'a@x.test')).toHaveLength(2)
  })
})

describe('the join limits', () => {
  /** A refused join: the same answer whichever limit it was, and nothing held or mailed. */
  const refusedQuietly = async (api: TestApi, res: Response, email: string) => {
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    expect(mailsTo(api, email)).toEqual([])
    expect(
      await first(api.db, sql`select 1 as x from invite_redemptions where email = ${email}`),
    ).toBeUndefined()
  }

  test('ten an hour from one IP, whatever the codes and addresses', async () => {
    const api = await createTestApi()
    await operator(api, { body: { code: 'WELCOME', uses: 100 } })
    const d = door(api)
    // Guesses at codes count like anything else.
    for (let i = 0; i < 10; i++)
      expect((await d.join(`GUESS${i}`, `g${i}@x.test`, '203.0.113.9')).status).toBe(400)
    await refusedQuietly(api, await d.join('WELCOME', 'a@x.test', '203.0.113.9'), 'a@x.test')
    // Another visitor is not held up by them, and the next hour starts afresh.
    expect((await d.join('WELCOME', 'b@x.test', '203.0.113.10')).status).toBe(200)
    api.clock.advance(HOUR)
    expect((await d.join('WELCOME', 'a@x.test', '203.0.113.9')).status).toBe(200)
  })

  test('an IPv6 client is counted by its /64, as better-auth counts it', async () => {
    const api = await createTestApi()
    await operator(api, { body: { code: 'WELCOME', uses: 100 } })
    const d = door(api)
    for (let i = 1; i <= 10; i++)
      expect((await d.join(`GUESS${i}`, `g${i}@x.test`, `2001:db8:1:2::${i}`)).status).toBe(400)
    const next = await d.join('WELCOME', 'a@x.test', '2001:db8:1:2:ffff:ffff:ffff:ffff')
    await refusedQuietly(api, next, 'a@x.test')
    expect((await d.join('WELCOME', 'a@x.test', '2001:db8:1:3::1')).status).toBe(200)
  })

  test('twenty an hour with a code, or as many as it has places, from however many IPs', async () => {
    const api = await createTestApi()
    await operator(api, { body: { code: 'WELCOME', uses: 5 } })
    await operator(api, { body: { code: 'OTHER', uses: 5 } })
    await operator(api, { body: { code: 'CROWD', uses: 30 } })
    const d = door(api)
    for (let i = 0; i < 20; i++) expect((await d.join('welcome', `p${i}@x.test`)).status).toBe(200)
    await refusedQuietly(api, await d.join('WELCOME', 'a@x.test'), 'a@x.test')
    expect((await d.join('OTHER', 'a@x.test')).status).toBe(200)
    // A code handed to a crowd lets the crowd in.
    for (let i = 0; i < 30; i++) expect((await d.join('CROWD', `c${i}@x.test`)).status).toBe(200)
    await refusedQuietly(api, await d.join('CROWD', 'b@x.test'), 'b@x.test')
  })

  test("junk spends no address's hour or code's, and one client alone cannot spend a code's", async () => {
    const api = await createTestApi()
    const d = door(api)
    // A word that is no code yet, and a member's address, tried from one IP until it is spent.
    for (let i = 0; i < 10; i++)
      expect((await d.join('SPRING', 'member@x.test', '203.0.113.9')).status).toBe(400)
    expect((await d.join('SPRING', 'member@x.test', '203.0.113.9')).status).toBe(429)
    expect(await api.db.all(sql`select key from action_limits`)).toEqual([
      { key: 'joinIp:203.0.113.9' },
    ])
    await operator(api, { body: { code: 'SPRING', uses: 1 } })
    expect((await d.join('SPRING', 'member@x.test')).status).toBe(200)
    // Every join one IP may send in an hour, all with one code, leaves room for someone else.
    for (let i = 0; i < 10; i++)
      expect((await d.join('SPRING', `x${i}@junk.test`, '203.0.113.10')).status).toBe(200)
    expect((await d.join('SPRING', 'late@x.test')).status).toBe(200)
  })

  test('three an hour for one address, from however many IPs and codes', async () => {
    const api = await createTestApi()
    for (const code of ['FIRST', 'SECOND']) await operator(api, { body: { code, uses: 100 } })
    const d = door(api)
    for (const code of ['FIRST', 'SECOND', 'FIRST'])
      expect((await d.join(code, 'a@x.test')).status).toBe(200)
    const mailed = mailsTo(api, 'a@x.test').length
    const fourth = await d.join('SECOND', 'A@x.test')
    expect(fourth.status).toBe(429)
    expect(await fourth.json()).toEqual({ error: 'rate_limited' })
    expect(mailsTo(api, 'a@x.test')).toHaveLength(mailed)
    // An unknown code is told so first, which says nothing a join with another address would not.
    expect((await d.join('UNKNOWN', 'a@x.test')).status).toBe(400)
    expect((await d.join('SECOND', 'b@x.test')).status).toBe(200)
  })

  test("the codes a join mails count with the login page's: five an hour for an address", async () => {
    const api = await createTestApi()
    await operator(api, { body: { code: 'WELCOME', uses: 100 } })
    const d = door(api)
    for (let i = 0; i < 2; i++) expect((await d.join('WELCOME', 'a@x.test')).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await d.ask('a@x.test')).status).toBe(200)
    expect(mailsTo(api, 'a@x.test')).toHaveLength(5)
    expect((await d.ask('a@x.test')).status).toBe(429)
    const join = await d.join('WELCOME', 'a@x.test')
    expect(join.status).toBe(429)
    expect(await join.json()).toEqual({ error: 'rate_limited' })
    expect(mailsTo(api, 'a@x.test')).toHaveLength(5)
  })
})
