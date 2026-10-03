/**
 * Settings → Invites and Account, as the reader speaks tela-api's `/api/v1/invites` and
 * `/api/v1/account`. The answers below are written as `apps/api/src/routes/account.ts` sends them.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  accountOutcome,
  getAccount,
  inviteLink,
  linkingReturn,
  linkProvider,
  readAccount,
  setPassword,
  signOutEverywhere,
  unlinkProvider,
} from '../src/lib/account-api'
import { savePassword } from '../src/lib/use-sign-in'
import { bindApi } from '../src/store/api'

describe('an invite link', () => {
  test("carries a member's code in groups of four, which the join sheet reads back", () => {
    expect(inviteLink('ABCDEFGHJKMN', 'https://tela.example')).toBe(
      'https://tela.example/join?code=ABCD-EFGH-JKMN',
    )
  })

  test("carries an operator's word as written", () => {
    expect(inviteLink('WELCOME2026', 'https://tela.example')).toBe(
      'https://tela.example/join?code=WELCOME2026',
    )
  })
})

const saved = globalThis.fetch
afterAll(() => {
  globalThis.fetch = saved
})
afterEach(() => {
  bindApi({ member: () => null, accountChanged() {}, upgrade() {} })
})

type Seen = { path: string; method: string; body: unknown; member: string | null }
/** Answer every call with `status` and `body`, keeping what each one sent. */
function answer(status: number, body: unknown) {
  const calls: Seen[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({
      path: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      member: new Headers(init?.headers).get('x-tela-member'),
    })
    return Response.json(body, { status })
  }) as typeof fetch
  bindApi({ member: () => 'member-1', accountChanged() {}, upgrade() {} })
  return calls
}

const ACCOUNT = {
  email: 'reader@example.com',
  hasPassword: true,
  linked: [{ id: 'acc-1', provider: 'github' as const, since: 1_700_000_000_000 }],
  fresh: false,
}

describe("the member's ways in", () => {
  test('are read as tela-api names them: a password set is `hasPassword`', async () => {
    const calls = answer(200, ACCOUNT)
    expect(await getAccount()).toEqual(ACCOUNT)
    expect(calls).toEqual([
      { path: '/api/v1/account', method: 'GET', body: undefined, member: 'member-1' },
    ])
  })

  test('an answer of another shape is not shown as a member without a password', () => {
    expect(readAccount({ ...ACCOUNT, hasPassword: undefined, password: true })).toBeNull()
    expect(readAccount({ ...ACCOUNT, fresh: 'yes' })).toBeNull()
    expect(readAccount({ ...ACCOUNT, linked: null })).toBeNull()
    expect(readAccount(null)).toBeNull()
  })

  test('a provider Tela does not offer, or a malformed one, is left out', () => {
    const linked = [...ACCOUNT.linked, { id: 'acc-2', provider: 'credential', since: 1 }, 'x']
    expect(readAccount({ ...ACCOUNT, linked })?.linked).toEqual(ACCOUNT.linked)
  })
})

describe('a change refused', () => {
  test("for a stale session asks the member to confirm it's them", async () => {
    answer(403, { error: 'session_not_fresh' })
    expect(await setPassword({ newPassword: 'long enough now' })).toEqual({
      ok: false,
      error: 'not_fresh',
    })
    expect(await linkProvider('google')).toEqual({ ok: false, error: 'not_fresh' })
    expect(await unlinkProvider('acc-1')).toEqual({ ok: false, error: 'not_fresh' })
  })

  test('says why in the words tela-api uses', () => {
    for (const error of [
      'new_password_required',
      'password_too_short',
      'password_too_long',
      'current_password_required',
      'invalid_password',
    ]) {
      expect(accountOutcome(400, { error })).toEqual({ ok: false, error: 'rejected' })
    }
    expect(accountOutcome(429, { error: 'rate_limited' })).toEqual({
      ok: false,
      error: 'rate_limited',
    })
    expect(accountOutcome(404, { error: 'unknown_provider' })).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(accountOutcome(404, { error: 'not_found' })).toEqual({ ok: false, error: 'failed' })
    // Only tela-api's own refusal for freshness opens the confirmation.
    expect(accountOutcome(403, { code: 'SESSION_NOT_FRESH' })).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(accountOutcome(500, null)).toEqual({ ok: false, error: 'failed' })
  })
})

describe('a change made', () => {
  test('sends the fields tela-api reads', async () => {
    const calls = answer(200, { ok: true })
    const saved: unknown = await setPassword({
      newPassword: 'new one here',
      currentPassword: 'old one',
    })
    expect(saved).toEqual({ ok: true, body: { ok: true } })
    await unlinkProvider('acc-1')
    expect(calls.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
      {
        path: '/api/v1/account/password',
        method: 'POST',
        body: { newPassword: 'new one here', currentPassword: 'old one' },
      },
      { path: '/api/v1/account/unlink', method: 'POST', body: { accountId: 'acc-1' } },
    ])
  })

  test('a link answers where to send the browser, and nothing else will do', async () => {
    const calls = answer(200, { url: 'https://github.com/login/oauth/authorize?state=s' })
    expect(await linkProvider('github')).toEqual({
      ok: true,
      url: 'https://github.com/login/oauth/authorize?state=s',
    })
    expect(calls[0]?.body).toEqual({ provider: 'github' })
    answer(200, { ok: true })
    expect(await linkProvider('github')).toEqual({ ok: false, error: 'failed' })
  })

  test('signing out everywhere hears how many other sessions ended', async () => {
    answer(200, { ended: 2 })
    const ended: unknown = await signOutEverywhere()
    expect(ended).toEqual({ ok: true, body: { ended: 2 } })
  })
})

describe("a link's return", () => {
  test('is where tela-api sends it, for the Account section', () => {
    expect(linkingReturn('?linked=github')).toBe(true)
    expect(linkingReturn('?error=account_already_linked_to_different_user')).toBe(true)
    expect(linkingReturn('')).toBe(false)
    expect(linkingReturn('?tab=reading')).toBe(false)
  })
})

describe("the sheet's password, chosen at a join's code step", () => {
  test('is a first password on the fresh session the code made, for the member', async () => {
    const calls = answer(200, { ok: true })
    expect(await savePassword('joined on a monday')).toBe(true)
    expect(calls).toEqual([
      {
        path: '/api/v1/account/password',
        method: 'POST',
        body: { newPassword: 'joined on a monday' },
        member: 'member-1',
      },
    ])
  })

  test('refused for any reason, leaves the member signed in without one', async () => {
    for (const [status, error] of [
      [403, 'session_not_fresh'],
      [400, 'current_password_required'],
      [400, 'password_too_long'],
      [429, 'rate_limited'],
    ] as const) {
      answer(status, { error })
      expect(await savePassword('joined on a monday')).toBe(false)
    }
  })
})
