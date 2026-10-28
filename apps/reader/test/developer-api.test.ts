/**
 * Settings → Developer's calls to tela-api (ADR 0067), against the answers
 * `/api/v1/developer/apps` gives: each app read field by field, every call naming the member, and
 * each refusal read as the reason tela-api gave, or `failed` for one it could not read.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import type { DeveloperApp } from '@tela/shared'
import {
  deleteApp,
  editApp,
  listDeveloperApps,
  problemOf,
  readDeveloperApps,
  registerApp,
  requestReview,
  setLive,
} from '../src/lib/developer-api'
import { bindApi } from '../src/store/api'

const saved = globalThis.fetch
afterAll(() => {
  globalThis.fetch = saved
})
afterEach(() => {
  bindApi({ member: () => null, accountChanged() {}, upgrade() {} })
})

type Seen = { path: string; method: string; body: unknown; member: string | null }
function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Seen[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({
      path: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      member: new Headers(init?.headers).get('x-tela-member'),
    })
    return status === 204
      ? new Response(null, { status })
      : Response.json(body, { status, headers })
  }) as typeof fetch
  bindApi({ member: () => 'member-1', accountChanged() {}, upgrade() {} })
  return calls
}

const LOOM: DeveloperApp = {
  appId: 7,
  clientId: 'tela_app_loom',
  name: 'Loom',
  developer: 'Loom Labs',
  contactEmail: 'dev@loom.example',
  homepageUrl: 'https://loom.example',
  privacyUrl: 'https://loom.example/privacy',
  redirectUris: ['http://127.0.0.1/callback'],
  maxScope: 'write',
  status: 'approved',
  reviewed: false,
  reviewRequestedAt: null,
  reviewWantsEmail: false,
  connections: 37,
  cap: 100,
  createdAt: 1_760_000_000_000,
  approvedAt: 1_760_100_000_000,
  suspendedAt: null,
}

const SETTINGS = {
  name: 'Loom',
  developer: 'Loom Labs',
  contactEmail: 'dev@loom.example',
  homepageUrl: 'https://loom.example',
  privacyUrl: 'https://loom.example/privacy',
  redirectUris: ['http://127.0.0.1/callback'],
  maxScope: 'write' as const,
}

describe('the list', () => {
  test('is read as tela-api sends it, naming the member', async () => {
    const calls = answer(200, { apps: [LOOM] })
    expect(await listDeveloperApps()).toEqual([LOOM])
    expect(calls).toEqual([
      { path: '/api/v1/developer/apps', method: 'GET', body: undefined, member: 'member-1' },
    ])
  })

  test('each app is read on its own: one of another shape is left out, not the list', () => {
    const { reviewed: _reviewed, ...noReviewed } = LOOM
    expect(
      readDeveloperApps({
        apps: [
          LOOM,
          noReviewed,
          { ...LOOM, appId: 8, status: 'live' },
          { ...LOOM, appId: 9, cap: -1 },
          { ...LOOM, appId: 10, redirectUris: 'http://127.0.0.1/callback' },
          null,
        ],
      }),
    ).toEqual([LOOM])
    expect(readDeveloperApps({ apps: 'none' })).toBeNull()
    expect(readDeveloperApps(null)).toBeNull()
  })

  test('a reviewed app has no cap, and links that are not https are drawn as none', () => {
    const [app] =
      readDeveloperApps({
        apps: [
          {
            ...LOOM,
            reviewed: true,
            cap: null,
            homepageUrl: 'javascript:alert(1)',
            privacyUrl: 'http://loom.example/privacy',
          },
        ],
      }) ?? []
    expect(app).toEqual({ ...LOOM, reviewed: true, cap: null, homepageUrl: null, privacyUrl: null })
  })

  test('a failed answer is null, for the section to say so', async () => {
    answer(503, { error: 'unavailable' })
    expect(await listDeveloperApps()).toBeNull()
  })
})

describe('the changes', () => {
  test('register sends the settings with the rules accepted; a contact left out is the account’s', async () => {
    const { contactEmail: _contact, ...rest } = SETTINGS
    const calls = answer(200, { app: LOOM })
    expect(await registerApp({ ...rest, acceptTerms: true })).toEqual({ ok: true })
    expect(calls).toEqual([
      {
        path: '/api/v1/developer/apps',
        method: 'POST',
        body: { ...rest, acceptTerms: true },
        member: 'member-1',
      },
    ])
  })

  test('edit, live, review and delete each name the app and the member', async () => {
    let calls = answer(200, { app: LOOM })
    expect(await editApp(7, SETTINGS)).toEqual({ ok: true })
    expect(await setLive(7, false)).toEqual({ ok: true })
    expect(await requestReview(7, 'For the terminal', true)).toEqual({ ok: true })
    expect(calls.map(({ path, method, body, member }) => [method, path, body, member])).toEqual([
      ['PUT', '/api/v1/developer/apps/7', SETTINGS, 'member-1'],
      ['POST', '/api/v1/developer/apps/7/live', { live: false }, 'member-1'],
      [
        'POST',
        '/api/v1/developer/apps/7/review',
        { note: 'For the terminal', wantsEmail: true },
        'member-1',
      ],
    ])
    calls = answer(204, null)
    expect(await deleteApp(7)).toEqual({ ok: true })
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/v1/developer/apps/7' })
  })

  test('a refusal is the reason tela-api gave', async () => {
    answer(400, { error: 'invalid', field: 'redirectUris' })
    expect(await editApp(7, SETTINGS)).toEqual({
      ok: false,
      problem: { error: 'invalid', field: 'redirectUris' },
    })
    answer(409, { error: 'too_many_apps', limit: 5 })
    expect(await registerApp({ ...SETTINGS, acceptTerms: true })).toEqual({
      ok: false,
      problem: { error: 'app_limit', limit: 5 },
    })
    answer(429, { error: 'rate_limited' }, { 'retry-after': '3600' })
    expect(await editApp(7, SETTINGS)).toEqual({ ok: false, problem: { error: 'rate_limited' } })
    answer(400, { error: 'privacy_required' })
    expect(await setLive(7, true)).toEqual({ ok: false, problem: { error: 'privacy_required' } })
    answer(409, { error: 'cut_off' })
    expect(await deleteApp(7)).toEqual({ ok: false, problem: { error: 'cut_off' } })
    answer(409, { error: 'reported' })
    expect(await deleteApp(7)).toEqual({ ok: false, problem: { error: 'reported' } })
  })

  test('a reason it cannot read is failed, never shown as given', () => {
    expect(problemOf(400, { error: 'invalid', field: 'owner' })).toEqual({ error: 'failed' })
    expect(problemOf(409, { error: 'too_many_apps' })).toEqual({ error: 'failed' })
    expect(problemOf(409, { error: 'something_new' })).toEqual({ error: 'failed' })
    expect(problemOf(500, null)).toEqual({ error: 'failed' })
    expect(problemOf(404, { error: 'not_found' })).toEqual({ error: 'failed' })
  })
})
