/**
 * Settings → Developer's routes (ADR 0067): a member registers their own app, edits it, makes it
 * Live or takes it back to Testing, asks for a review and deletes it. Only their own: anyone
 * else's app, the operator's included, is a 404. Each write is in the console's history, with the
 * member as its actor and never the app's contact address.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { first, historyOf } from '@tela/data'
import type { DeveloperApp } from '@tela/shared'
import { sql } from 'drizzle-orm'
import {
  askConsent,
  authorizationParams,
  connect,
  meStatus,
  pkce,
  registerApp,
} from './apps-helpers'
import { createTestApi, operatorSets, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let dev: SignedIn
let bo: SignedIn
let ann: SignedIn

beforeEach(async () => {
  api = await createTestApi()
  dev = await signedIn(api, 'dev@x.test')
  bo = await signedIn(api, 'bo@x.test')
  ann = await signedIn(api, 'ann@x.test')
})

const SETTINGS = {
  name: 'Loom',
  developer: 'Loom Labs',
  contactEmail: 'hi@loom.example',
  homepageUrl: 'https://loom.example',
  privacyUrl: null,
  redirectUris: ['http://127.0.0.1/callback'],
  maxScope: 'read' as const,
}

const BASE = '/api/v1/developer/apps'

const register = (who: SignedIn, body: Record<string, unknown> = {}) =>
  api.request(BASE, { as: who, body: { ...SETTINGS, acceptTerms: true, ...body } })

/** Register an app as `who`, and what the answer says of it. */
async function registered(who: SignedIn, body: Record<string, unknown> = {}) {
  const res = await register(who, body)
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { app: DeveloperApp }).app
}

const edit = (who: SignedIn, id: number, body: Record<string, unknown>) =>
  api.request(`${BASE}/${id}`, { as: who, method: 'PUT', body: { ...SETTINGS, ...body } })
const goLive = (who: SignedIn, id: number, live: unknown) =>
  api.request(`${BASE}/${id}/live`, { as: who, body: { live } })
const askReview = (who: SignedIn, id: number, body: Record<string, unknown>) =>
  api.request(`${BASE}/${id}/review`, { as: who, body })
const remove = (who: SignedIn, id: number) =>
  api.request(`${BASE}/${id}`, { as: who, method: 'DELETE' })

const list = async (who: SignedIn) => {
  const res = await api.request(BASE, { as: who })
  expect(res.status).toBe(200)
  return ((await res.json()) as { apps: DeveloperApp[] }).apps
}

/** An app the routes answered with, as the OAuth helpers name one. */
const testApp = (app: DeveloperApp) => ({ id: app.appId, clientId: app.clientId })

/** A status and body, to compare in one `toEqual`. */
const answer = async (res: Response) => [res.status, await res.json()]

const row = (id: number) =>
  first<Record<string, unknown>>(
    api.db,
    sql`select status, developer_id, owner_user_id, contact_email, terms_at, allow_email,
      reviewed_at, reviewed_by, approved_at, review_requested_at, review_note, review_wants_email
      from apps where id = ${id}`,
  )

const appCount = async () =>
  (await first<{ n: number }>(api.db, sql`select count(*) as n from apps`))?.n

describe('registering an app', () => {
  test('makes it the member’s, in Testing, with its client_id at once', async () => {
    const res = await register(dev)
    expect(res.status).toBe(201)
    const { app } = (await res.json()) as { app: DeveloperApp }
    expect(app).toEqual({
      ...SETTINGS,
      appId: expect.any(Number),
      clientId: expect.stringMatching(/^tela_app_/),
      status: 'draft',
      reviewed: false,
      reviewRequestedAt: null,
      reviewWantsEmail: false,
      connections: 0,
      cap: 100,
      createdAt: api.clock.now(),
      approvedAt: null,
      suspendedAt: null,
    })
    expect(await row(app.appId)).toMatchObject({
      developer_id: dev.userId,
      owner_user_id: dev.userId,
      terms_at: api.clock.now(),
      allow_email: 0,
      reviewed_at: null,
    })
    // Only its developer can connect it while it is in Testing.
    const { challenge } = await pkce()
    const params = authorizationParams(testApp(app), challenge, { scope: 'read' })
    expect((await askConsent(api, dev, params)).status).toBe(200)
    expect(await (await askConsent(api, bo, params)).json()).toEqual({ error: 'invalid_client' })
  })

  test('the contact address is the account’s unless another is given', async () => {
    const app = await registered(dev, { contactEmail: undefined })
    expect(app.contactEmail).toBe('dev@x.test')
  })

  test('needs the developer rules accepted, and no "Tela" in a name', async () => {
    expect(await answer(await register(dev, { acceptTerms: undefined }))).toEqual([
      400,
      { error: 'terms' },
    ])
    expect(await answer(await register(dev, { acceptTerms: 'yes' }))).toEqual([
      400,
      { error: 'terms' },
    ])
    expect(await answer(await register(dev, { name: 'Tela Sync' }))).toEqual([
      400,
      { error: 'invalid', field: 'name' },
    ])
    expect(await answer(await register(dev, { developer: 'Ｔｅｌａ Labs' }))).toEqual([
      400,
      { error: 'invalid', field: 'developer' },
    ])
    expect(await answer(await register(dev, { redirectUris: ['https://x.example/cb'] }))).toEqual([
      400,
      { error: 'invalid', field: 'redirectUris' },
    ])
    expect(await appCount()).toBe(0)
  })

  test('counts apps.perMember inside the insert, and an admin is exempt', async () => {
    await operatorSets(api, 'apps.perMember', 2)
    await registered(dev)
    await registered(dev)
    expect(await answer(await register(dev))).toEqual([409, { error: 'too_many_apps', limit: 2 }])
    // Two at once for the last place: one is registered.
    await operatorSets(api, 'apps.perMember', 1)
    const raced = await Promise.all([register(bo), register(bo)])
    expect(raced.map((r) => r.status).sort()).toEqual([201, 409])
    await operatorSets(api, 'apps.perMember', 0)
    expect((await register(ann)).status).toBe(409)
    await api.db.run(sql`update profiles set is_admin = 1 where user_id = ${dev.userId}`)
    expect((await register(dev)).status).toBe(201)
    expect(await appCount()).toBe(4)
  })

  test('registering and editing are counted, ten a day', async () => {
    await operatorSets(api, 'apps.perMember', null)
    const app = await registered(dev)
    for (let i = 1; i < 5; i++) await registered(dev)
    for (let i = 0; i < 5; i++) {
      expect((await edit(dev, app.appId, { name: `Loom ${i}` })).status).toBe(200)
    }
    const limited = await register(dev)
    expect(await answer(limited)).toEqual([429, { error: 'rate_limited' }])
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await edit(dev, app.appId, { name: 'Loom again' })).status).toBe(429)
    expect((await register(bo)).status).toBe(201)
  })
})

describe('the member’s apps', () => {
  test('are theirs alone, with how many are connected and the cap their unreviewed apps share', async () => {
    const mine = await registered(dev)
    await registered(bo)
    await registerApp(api)
    expect((await list(dev)).map((a) => a.appId)).toEqual([mine.appId])
    await connect(api, dev, testApp(mine), { scope: 'read' })
    await operatorSets(api, 'apps.unreviewedMaxConnections', 7)
    expect(await list(dev)).toMatchObject([{ connections: 1, cap: 7 }])
    // A reviewed app is held only to the cap the operator gives it, which this does not show.
    await api.db.run(sql`update apps set reviewed_at = 1, max_connections = 3
      where id = ${mine.appId}`)
    expect(await list(dev)).toMatchObject([{ reviewed: true, cap: null }])
  })

  test('a suspended member reads none of them, contact addresses included, and changes nothing', async () => {
    const app = await registered(dev)
    await api.db.run(sql`update profiles set suspended_at = 1 where user_id = ${dev.userId}`)
    expect((await api.request(BASE, { as: dev })).status).toBe(401)
    expect((await edit(dev, app.appId, { name: 'Loom 2' })).status).toBe(401)
    expect((await remove(dev, app.appId)).status).toBe(401)
    expect(await appCount()).toBe(1)
  })

  test('anyone else’s app, and the operator’s, is a 404 on every route', async () => {
    const theirs = await registered(bo)
    const operators = await registerApp(api)
    for (const id of [theirs.appId, operators.id, 999]) {
      // Every write spends the day's count, a refused one too: start each id afresh.
      await api.db.run(sql`delete from action_limits`)
      for (const res of [
        await edit(dev, id, { name: 'Mine now' }),
        await goLive(dev, id, true),
        await askReview(dev, id, { note: null, wantsEmail: false }),
        await remove(dev, id),
      ]) {
        expect([id, await answer(res)]).toEqual([id, [404, { error: 'not_found' }]])
      }
    }
    expect(await row(theirs.appId)).toMatchObject({ status: 'draft', review_requested_at: null })
  })
})

describe('editing an app', () => {
  test('any field members read clears its review and the email permission; the contact keeps it', async () => {
    const app = await registered(dev)
    const review = () =>
      api.db.run(sql`update apps set reviewed_at = 5, reviewed_by = ${bo.userId}, allow_email = 1
        where id = ${app.appId}`)
    await review()
    const kept = await edit(dev, app.appId, { contactEmail: 'other@loom.example' })
    expect(kept.status).toBe(200)
    expect(((await kept.json()) as { app: DeveloperApp }).app).toMatchObject({
      contactEmail: 'other@loom.example',
      reviewed: true,
    })
    expect(await row(app.appId)).toMatchObject({ reviewed_at: 5, allow_email: 1 })
    for (const change of [
      { name: 'Loom 2' },
      { developer: 'Google LLC' },
      { homepageUrl: 'https://loom.example/home' },
      { privacyUrl: 'https://loom.example/other-policy' },
      { redirectUris: ['http://127.0.0.1/other'] },
      { maxScope: 'write' },
    ]) {
      await review()
      const res = await edit(dev, app.appId, change)
      expect([change, res.status]).toEqual([change, 200])
      expect(((await res.json()) as { app: DeveloperApp }).app.reviewed).toBe(false)
      expect(await row(app.appId)).toMatchObject({
        reviewed_at: null,
        reviewed_by: null,
        allow_email: 0,
      })
    }
  })

  test('is refused while the app is cut off or reported', async () => {
    const app = await registered(dev, { privacyUrl: 'https://loom.example/privacy' })
    await goLive(dev, app.appId, true)
    await api.db.run(sql`insert into reports (reporter_id, target_kind, target_key, reason, state,
        created_at)
      values (${ann.userId}, 'app', ${app.clientId}, 'spam', 'open', 0)`)
    expect(await answer(await edit(dev, app.appId, { name: 'Harmless' }))).toEqual([
      409,
      { error: 'reported' },
    ])
    await api.db.run(sql`update reports set state = 'dismissed'`)
    await api.db.run(sql`update apps set status = 'suspended' where id = ${app.appId}`)
    expect(await answer(await edit(dev, app.appId, { name: 'Harmless' }))).toEqual([
      409,
      { error: 'cut_off' },
    ])
    expect((await list(dev)).map((a) => a.name)).toEqual([SETTINGS.name])
  })

  test('holds an edit to the rule a registration is held to', async () => {
    const app = await registered(dev)
    expect(await answer(await edit(dev, app.appId, { name: 'tela' }))).toEqual([
      400,
      { error: 'invalid', field: 'name' },
    ])
    expect(await answer(await edit(dev, app.appId, { maxScope: 'admin' }))).toEqual([
      400,
      { error: 'invalid', field: 'maxScope' },
    ])
  })
})

describe('Live and Testing', () => {
  test('Live needs a privacy policy, and makes the app anyone’s to connect', async () => {
    const app = await registered(dev)
    expect(await answer(await goLive(dev, app.appId, true))).toEqual([
      400,
      { error: 'privacy_required' },
    ])
    expect(await answer(await goLive(dev, app.appId, 'yes'))).toEqual([
      400,
      { error: 'invalid', field: 'live' },
    ])
    await edit(dev, app.appId, { privacyUrl: 'https://loom.example/privacy' })
    const res = await goLive(dev, app.appId, true)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { app: DeveloperApp }).app).toMatchObject({
      status: 'approved',
      approvedAt: api.clock.now(),
    })
    await connect(api, bo, testApp(app), { scope: 'read' })
    // Asking again changes nothing.
    expect((await goLive(dev, app.appId, true)).status).toBe(200)
  })

  test('Back to Testing clears approved_at and ends every other member’s connection', async () => {
    const app = await registered(dev, { privacyUrl: 'https://loom.example/privacy' })
    await goLive(dev, app.appId, true)
    const own = await connect(api, dev, testApp(app), { scope: 'read' })
    const theirs = await connect(api, bo, testApp(app), { scope: 'read' })
    const res = await goLive(dev, app.appId, false)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { app: DeveloperApp }).app).toMatchObject({
      status: 'draft',
      approvedAt: null,
      connections: 1,
    })
    expect(await row(app.appId)).toMatchObject({ status: 'draft', approved_at: null })
    expect(await meStatus(api, own.access_token)).toBe(200)
    expect(await meStatus(api, theirs.access_token)).toBe(401)
    expect(
      await api.db.all(sql`select user_id, end_reason from app_grants where app_id = ${app.appId}
        order by id`),
    ).toEqual([
      { user_id: dev.userId, end_reason: null },
      { user_id: bo.userId, end_reason: 'appEnded' },
    ])
  })

  test('never moves an app the operator cut off', async () => {
    const app = await registered(dev, { privacyUrl: 'https://loom.example/privacy' })
    await goLive(dev, app.appId, true)
    await connect(api, bo, testApp(app), { scope: 'read' })
    await api.db.run(sql`update apps set status = 'suspended', suspended_at = 9
      where id = ${app.appId}`)
    for (const live of [true, false]) {
      expect(await answer(await goLive(dev, app.appId, live))).toEqual([409, { error: 'cut_off' }])
    }
    expect(await row(app.appId)).toMatchObject({
      status: 'suspended',
      approved_at: api.clock.now(),
    })
    expect(
      await first<unknown>(
        api.db,
        sql`select ended_at from app_grants where user_id = ${bo.userId}`,
      ),
    ).toEqual({ ended_at: null })
  })
})

describe('asking for a review', () => {
  test('records the note and the wish for the email permission', async () => {
    const app = await registered(dev)
    const res = await askReview(dev, app.appId, {
      note: '  For readers of Loom.  ',
      wantsEmail: true,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { app: DeveloperApp }).app).toMatchObject({
      reviewRequestedAt: api.clock.now(),
      reviewWantsEmail: true,
    })
    expect(await row(app.appId)).toMatchObject({
      review_note: 'For readers of Loom.',
      review_wants_email: 1,
    })
    expect(await answer(await askReview(dev, app.appId, { note: 'x'.repeat(501) }))).toEqual([
      400,
      { error: 'invalid', field: 'note' },
    ])
    expect(await answer(await askReview(dev, app.appId, { note: null, wantsEmail: 1 }))).toEqual([
      400,
      { error: 'invalid', field: 'wantsEmail' },
    ])
    await api.db.run(sql`update apps set status = 'suspended' where id = ${app.appId}`)
    expect(
      await answer(await askReview(dev, app.appId, { note: null, wantsEmail: false })),
    ).toEqual([409, { error: 'cut_off' }])
  })
})

describe('deleting an app', () => {
  test('is refused while it is cut off or reported, and otherwise takes everything with it', async () => {
    const app = await registered(dev, { privacyUrl: 'https://loom.example/privacy' })
    await goLive(dev, app.appId, true)
    await connect(api, bo, testApp(app), { scope: 'read' })
    await api.db.run(sql`insert into reports (reporter_id, target_kind, target_key, reason, state,
        created_at)
      values (${ann.userId}, 'app', ${app.clientId}, 'spam', 'open', 0)`)
    expect(await answer(await remove(dev, app.appId))).toEqual([409, { error: 'reported' }])
    await api.db.run(sql`update reports set state = 'dismissed'`)
    await api.db.run(sql`update apps set status = 'suspended' where id = ${app.appId}`)
    expect(await answer(await remove(dev, app.appId))).toEqual([409, { error: 'cut_off' }])
    await api.db.run(sql`update apps set status = 'approved' where id = ${app.appId}`)

    expect(await answer(await remove(dev, app.appId))).toEqual([200, { ok: true }])
    expect(await list(dev)).toEqual([])
    for (const table of ['apps', 'app_grants', 'app_tokens', 'app_codes']) {
      const count = await first<unknown>(api.db, sql.raw(`select count(*) as n from ${table}`))
      expect([table, count]).toEqual([table, { n: 0 }])
    }
    expect(await answer(await remove(dev, app.appId))).toEqual([404, { error: 'not_found' }])
  })
})

describe('what the name rule and the day’s count also hold', () => {
  test('a member whose handle says Tela registers nothing and makes nothing Live', async () => {
    const app = await registered(dev, { privacyUrl: 'https://loom.example/privacy' })
    await api.db.run(
      sql`update profiles set handle = 'tela_official' where user_id = ${dev.userId}`,
    )
    expect(await answer(await register(dev))).toEqual([400, { error: 'handle' }])
    expect(await answer(await goLive(dev, app.appId, true))).toEqual([400, { error: 'handle' }])
    // Back to Testing is never refused for it.
    expect((await goLive(dev, app.appId, false)).status).toBe(200)
  })

  test('the same review request again writes nothing', async () => {
    const app = await registered(dev)
    await askReview(dev, app.appId, { note: 'Please', wantsEmail: false })
    const audits = () =>
      first<{ n: number }>(
        api.db,
        sql`select count(*) as n from admin_actions where action = 'developer.review'`,
      )
    expect(await audits()).toEqual({ n: 1 })
    expect((await askReview(dev, app.appId, { note: 'Please', wantsEmail: false })).status).toBe(
      200,
    )
    expect(await audits()).toEqual({ n: 1 })
    await askReview(dev, app.appId, { note: 'Please, with email', wantsEmail: true })
    expect(await audits()).toEqual({ n: 2 })
  })

  test('Live, Testing, review requests and deletes spend the day’s count too', async () => {
    await operatorSets(api, 'apps.perMember', null)
    const app = await registered(dev, { privacyUrl: 'https://loom.example/privacy' })
    for (let i = 0; i < 4; i++) {
      expect((await goLive(dev, app.appId, i % 2 === 0)).status).toBe(200)
    }
    for (let i = 0; i < 5; i++) {
      expect((await askReview(dev, app.appId, { note: `n${i}`, wantsEmail: false })).status).toBe(
        200,
      )
    }
    expect((await goLive(dev, app.appId, true)).status).toBe(429)
    expect((await askReview(dev, app.appId, { note: 'x', wantsEmail: false })).status).toBe(429)
    expect((await remove(dev, app.appId)).status).toBe(429)
  })
})

describe('the member’s export', () => {
  test('lists the apps they registered, contact address and review request included', async () => {
    const app = await registered(dev, { privacyUrl: 'https://loom.example/privacy' })
    await askReview(dev, app.appId, { note: 'For readers of Loom', wantsEmail: true })
    await goLive(dev, app.appId, true)
    const res = await api.request('/api/v1/export', { as: dev })
    expect(res.status).toBe(200)
    const { registeredApps } = (await res.json()) as { registeredApps: Record<string, unknown>[] }
    expect(registeredApps).toEqual([
      expect.objectContaining({
        clientId: app.clientId,
        name: SETTINGS.name,
        contactEmail: app.contactEmail,
        status: 'live',
        reviewed: false,
        reviewNote: 'For readers of Loom',
        redirectUris: app.redirectUris,
      }),
    ])
  })
})

describe('the console’s history', () => {
  test('holds every change the member made, as theirs, and never the contact address', async () => {
    const app = await registered(dev, { privacyUrl: 'https://loom.example/privacy' })
    await edit(dev, app.appId, { name: 'Loom 2', privacyUrl: 'https://loom.example/privacy' })
    await goLive(dev, app.appId, true)
    await goLive(dev, app.appId, false)
    await askReview(dev, app.appId, { note: 'please', wantsEmail: true })
    await remove(dev, app.appId)
    const history = await historyOf(api.db, 'app', String(app.appId))
    expect(history.map((h) => [h.action, h.actor?.id])).toEqual([
      ['developer.delete', dev.userId],
      ['developer.review', dev.userId],
      ['developer.testing', dev.userId],
      ['developer.live', dev.userId],
      ['developer.edit', dev.userId],
      ['developer.register', dev.userId],
    ])
    const edited = history.find((h) => h.action === 'developer.edit')
    expect(edited?.from).toMatchObject({ name: 'Loom' })
    expect(edited?.to).toMatchObject({ name: 'Loom 2' })
    const details = await api.db.all<{ detail: string }>(sql`select detail from admin_actions`)
    expect(details.length).toBe(6)
    for (const { detail } of details) expect(detail).not.toContain(SETTINGS.contactEmail)
  })
})
