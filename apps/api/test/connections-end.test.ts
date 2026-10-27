/**
 * An app stops wherever Tela ends a member's other sessions (ADR 0064), in the same batch: a
 * password set, changed or reset, a provider linked, "sign out everywhere", the console's sign-out
 * and suspension, and closing the account. Each path is followed by the app's token, refused, its
 * refresh token too, and the reason recorded; a member who keeps their standing keeps nothing else
 * of an ended connection, and another member's apps are untouched.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { AdminActResponse } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { endConnectionsAfterReset } from '../src/auth'
import {
  connect,
  meStatus,
  refresh,
  registerApp,
  type TestApp,
  type TokenAnswer,
} from './apps-helpers'
import { codeFor, cookiesOf, createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

const GITHUB = { clientId: 'github-client', clientSecret: 'github-secret' }
const PASSWORD = 'correct horse battery'

let api: TestApi
let ann: SignedIn
/** Someone else connected to the same app, whose connection no path of ann's may touch. */
let bo: SignedIn
let app: TestApp
let annTokens: TokenAnswer
let boTokens: TokenAnswer

/** GitHub's token and profile endpoints, for a link's return (as in `account.test.ts`). */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
async function github(input: Request | URL | string): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  switch (`${url.origin}${url.pathname}`) {
    case 'https://github.com/login/oauth/access_token':
      return json({ access_token: 'gho_access-token', token_type: 'bearer', scope: 'user:email' })
    case 'https://api.github.com/user':
      return json({ id: 4242, login: 'octo', email: null })
    case 'https://api.github.com/user/emails':
      return json([
        { email: 'octo@elsewhere.test', primary: true, verified: true, visibility: null },
      ])
  }
  throw new Error(`GitHub does not answer ${url}`)
}

let realFetch: typeof fetch
let quiet: { mockRestore(): void }[] = []
beforeEach(async () => {
  realFetch = globalThis.fetch
  globalThis.fetch = github as typeof fetch
  // better-auth warns at refused passwords and logs refused states; the answers are what count.
  quiet = [spyOn(console, 'warn').mockImplementation(() => {})]
  api = await createTestApi({ oauth: { github: GITHUB } })
  ann = await signedIn(api, 'ann@x.test')
  bo = await signedIn(api, 'bo@x.test')
  app = await registerApp(api)
  annTokens = await connect(api, ann, app)
  boTokens = await connect(api, bo, app)
})
afterEach(() => {
  globalThis.fetch = realFetch
  for (const spy of quiet) spy.mockRestore()
})

let requests = 0
const ip = () => `198.51.100.${++requests % 250}`

/** Ann's connection ended for `reason`: her tokens refused, Bo's untouched. */
async function endedFor(reason: string) {
  expect(await meStatus(api, annTokens.access_token)).toBe(401)
  expect((await refresh(api, app, annTokens.refresh_token)).status).toBe(400)
  expect(
    await api.db.all(sql`select t.end_reason as token, g.end_reason as grant from app_tokens t
      join app_grants g on g.id = t.grant_id where g.user_id = ${ann.userId}`),
  ).toEqual([{ token: reason, grant: reason }])
  expect(await meStatus(api, boTokens.access_token)).toBe(200)
}

/** Make ann an operator, and act in the console as her on bo, or as bo on ann. */
async function console_(action: string, actor: SignedIn, target: SignedIn) {
  await api.db.run(sql`update profiles set is_admin = 1 where user_id = ${actor.userId}`)
  const res = await api.request('/api/v1/admin/act', {
    as: actor,
    body: { action, ids: [target.userId] },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminActResponse
}

describe('a connection ends', () => {
  test('when the member sets a password', async () => {
    const res = await api.request('/api/v1/account/password', {
      as: ann,
      body: { newPassword: PASSWORD },
    })
    expect(res.status).toBe(200)
    await endedFor('password')
  })

  test('when the member changes it', async () => {
    await api.auth.api.setPassword({
      headers: new Headers({ cookie: ann.cookie }),
      body: { newPassword: PASSWORD },
    })
    // Setting it through better-auth alone ends nothing; changing it through Settings does.
    expect(await meStatus(api, annTokens.access_token)).toBe(200)
    const res = await api.request('/api/v1/account/password', {
      as: ann,
      body: { newPassword: 'a brand new password', currentPassword: PASSWORD },
    })
    expect(res.status).toBe(200)
    await endedFor('password')
  })

  test('when the member resets it by code', async () => {
    const door = (path: string, body: unknown) =>
      api.request(`/api/auth/${path}`, { body, headers: { 'cf-connecting-ip': ip() } })
    await door('email-otp/request-password-reset', { email: 'ann@x.test' })
    const reset = await door('email-otp/reset-password', {
      email: 'ann@x.test',
      otp: codeFor(api, 'ann@x.test'),
      password: PASSWORD,
    })
    expect(reset.status).toBe(200)
    await endedFor('password')
  })

  test('when the member links a provider', async () => {
    const started = await api.request('/api/v1/account/link', {
      as: ann,
      body: { provider: 'github' },
    })
    expect(started.status).toBe(200)
    const { url } = (await started.clone().json()) as { url: string }
    const state = encodeURIComponent(new URL(url).searchParams.get('state') ?? '')
    const back = await api.request(`/api/auth/callback/github?code=from-github&state=${state}`, {
      headers: {
        origin: undefined,
        cookie: `${ann.cookie}; ${cookiesOf(started)}`,
        'cf-connecting-ip': ip(),
      },
    })
    expect(back.headers.get('location')).toContain('linked=github')
    await endedFor('link')
  })

  test('when the member signs out everywhere', async () => {
    const res = await api.request('/api/v1/account/sign-out-everywhere', { as: ann, body: {} })
    expect(res.status).toBe(200)
    await endedFor('signOutEverywhere')
  })

  test('when the console signs the member out, connections alone included', async () => {
    await api.db.run(sql`delete from session where user_id = ${ann.userId}`)
    const answer = await console_('member.signOut', bo, ann)
    expect(answer).toMatchObject({ done: [ann.userId], failed: [] })
    await endedFor('operatorSignOut')
    const [audit] = await api.db.all<{ detail: string }>(
      sql`select detail from admin_actions where action = 'member.signOut'`,
    )
    expect(JSON.parse(audit?.detail ?? '{}')).toEqual({
      from: { sessions: 0, connections: 1 },
      to: { sessions: 0, connections: 0 },
    })
  })

  test('when the console suspends the member, and not when the suspension is refused', async () => {
    // An admin is not suspendable: refused, it ends nothing (`onlyIf`).
    await api.db.run(sql`update profiles set is_admin = 1 where user_id = ${ann.userId}`)
    const refused = await console_('member.suspend', bo, ann)
    expect(refused.failed).toEqual([{ id: ann.userId, error: 'not_applicable' }])
    expect(await meStatus(api, annTokens.access_token)).toBe(200)
    await api.db.run(sql`update profiles set is_admin = 0 where user_id = ${ann.userId}`)

    const done = await console_('member.suspend', bo, ann)
    expect(done.done).toEqual([ann.userId])
    await endedFor('suspended')
    // Lifting the suspension gives back no connection: the app connects again.
    const lift = await api.request('/api/v1/admin/undo', {
      as: bo,
      body: { group: done.undo?.group },
    })
    expect(lift.status).toBe(200)
    expect(await meStatus(api, annTokens.access_token)).toBe(401)
  })

  test('when the account is closed', async () => {
    const asked = await api.request('/api/v1/account/delete/code', { as: ann, body: {} })
    expect(asked.status).toBe(200)
    const closed = await api.request('/api/v1/account/delete', {
      as: ann,
      body: { code: codeFor(api, 'ann@x.test') },
    })
    expect(closed.status).toBe(200)
    await endedFor('closed')
  })

  test('when the operator closes it from the console', async () => {
    const answer = await console_('member.delete', bo, ann)
    expect(answer.done).toEqual([ann.userId])
    await endedFor('closed')
  })
})

describe('after a password reset, which ends sessions in a batch of better-auth’s own', () => {
  /** Tela's database, whose next `failures` batches fail as an overloaded D1's do. */
  function flaky(failures: number) {
    let left = failures
    return new Proxy(api.db, {
      get(target, prop) {
        if (prop === 'batch') {
          return (...args: Parameters<typeof target.batch>) => {
            if (left-- > 0) return Promise.reject(new Error('D1_ERROR: overloaded'))
            return target.batch(...args)
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  test('the apps end even when the first try fails', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    expect(await endConnectionsAfterReset(flaky(1), ann.userId, api.clock.now())).toBe(true)
    await endedFor('password')
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  test('a second failure is logged as an error naming the member, not swallowed', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    expect(await endConnectionsAfterReset(flaky(2), ann.userId, api.clock.now())).toBe(false)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0]?.join(' ')).toContain(ann.userId)
    // Still connected: what the log is for.
    expect(await meStatus(api, annTokens.access_token)).toBe(200)
    errors.mockRestore()
  })
})
