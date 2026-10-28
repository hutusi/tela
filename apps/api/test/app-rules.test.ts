/**
 * The rules an app a member registered is held to (ADR 0067), each in one place and applied
 * wherever an app is shown or acts: how many members its developer's unreviewed apps hold
 * together (`effectiveMaxConnections`), never the email permission until Tela reviews it
 * (`emailAllowed`), its developer's standing, and what closing the developer's account ends.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { approveConnection, effectiveMaxConnections, exchangeCode, first } from '@tela/data'
import type { Connection, ConnectRequest } from '@tela/shared'
import { sql } from 'drizzle-orm'
import {
  approve,
  askConsent,
  authorizationParams,
  connect,
  decide,
  gateway,
  LISTENING,
  meStatus,
  pkce,
  refresh,
  registerApp,
  type TestApp,
} from './apps-helpers'
import { createTestApi, operatorSets, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
/** The developer, who registered the apps below in Settings → Developer. */
let dev: SignedIn
let ann: SignedIn
let bo: SignedIn
let cy: SignedIn

beforeEach(async () => {
  api = await createTestApi()
  dev = await signedIn(api, 'dev@x.test')
  ann = await signedIn(api, 'ann@x.test')
  bo = await signedIn(api, 'bo@x.test')
  // better-auth allows three sign-ins a minute from one address, and every test signs in from one.
  await api.db.run(sql`delete from rate_limit`)
  cy = await signedIn(api, 'cy@x.test')
})

/** A live app `dev` registered, not reviewed unless said. */
const devApp = (input: Parameters<typeof registerApp>[1] = {}) =>
  registerApp(api, { developerId: dev.userId, ownerUserId: dev.userId, reviewed: false, ...input })

/** What the consent page says to `who` about `app`: its error, or null when it may be shown. */
async function consentError(who: SignedIn, app: TestApp): Promise<string | null> {
  const { challenge } = await pkce()
  const res = await askConsent(api, who, authorizationParams(app, challenge))
  const body = (await res.json()) as { error?: string }
  return body.error ?? null
}

/** `approveConnection` straight, as a second approval racing past the page's check would. */
async function raceApproval(who: SignedIn, app: TestApp) {
  const { challenge } = await pkce()
  return approveConnection(api.db, {
    appId: app.id,
    userId: who.userId,
    scope: 'read',
    email: false,
    redirectUri: LISTENING,
    codeChallenge: challenge,
    now: api.clock.now(),
  })
}

const liveGrants = async (app: TestApp) =>
  (
    await api.db.all<{ user_id: string }>(
      sql`select user_id from app_grants where app_id = ${app.id} and ended_at is null
        order by user_id`,
    )
  ).map((r) => r.user_id)

describe('effectiveMaxConnections', () => {
  const capOf = async (app: TestApp) =>
    (
      await first<{ cap: number | null }>(
        api.db,
        sql`select ${effectiveMaxConnections('a')} as cap from apps a where a.id = ${app.id}`,
      )
    )?.cap

  test('is a reviewed app’s own cap, and the lower of its own and the setting’s until then, either null', async () => {
    const cases: [Parameters<typeof registerApp>[1], number | null][] = [
      [{ reviewed: true, maxConnections: null }, null],
      [{ reviewed: true, maxConnections: 500 }, 500],
      [{ reviewed: false, maxConnections: null }, 100],
      [{ reviewed: false, maxConnections: 3 }, 3],
      [{ reviewed: false, maxConnections: 300 }, 100],
    ]
    for (const [input, cap] of cases) {
      expect([input, await capOf(await devApp(input))]).toEqual([input, cap])
    }
    // No setting at all: an unreviewed app keeps its own, which may be none. `min()` would have
    // said null for both, which reads as no cap.
    await operatorSets(api, 'apps.unreviewedMaxConnections', null)
    expect(await capOf(await devApp({ maxConnections: 3 }))).toBe(3)
    expect(await capOf(await devApp({ maxConnections: null }))).toBeNull()
    await operatorSets(api, 'apps.unreviewedMaxConnections', 0)
    expect(await capOf(await devApp({ maxConnections: 3 }))).toBe(0)
  })
})

describe('an unreviewed app’s cap', () => {
  test('at 1, a second member is refused, on the page, in the answer, and racing the check', async () => {
    await operatorSets(api, 'apps.unreviewedMaxConnections', 1)
    const app = await devApp()
    await connect(api, ann, app)
    expect(await consentError(bo, app)).toBe('max_connections')
    const { challenge } = await pkce()
    const answer = await decide(api, bo, authorizationParams(app, challenge))
    expect([answer.status, await answer.json()]).toEqual([400, { error: 'max_connections' }])
    expect(await raceApproval(bo, app)).toBeNull()
    // A member already connected still is, and may connect again.
    expect(await consentError(ann, app)).toBeNull()
    expect(await raceApproval(ann, app)).not.toBeNull()
    expect(await liveGrants(app)).toEqual([ann.userId])
  })

  test('two approvals racing for the last place: one connects', async () => {
    await operatorSets(api, 'apps.unreviewedMaxConnections', 1)
    const app = await devApp()
    const answers = await Promise.all([raceApproval(bo, app), raceApproval(cy, app)])
    expect(answers.filter((a) => a !== null)).toHaveLength(1)
    expect(await liveGrants(app)).toHaveLength(1)
  })

  test('counts members across all of the developer’s unreviewed apps, each once', async () => {
    await operatorSets(api, 'apps.unreviewedMaxConnections', 2)
    const one = await devApp()
    const two = await devApp()
    await connect(api, ann, one)
    await connect(api, bo, two)
    expect(await consentError(cy, one)).toBe('max_connections')
    expect(await consentError(cy, two)).toBe('max_connections')
    expect(await raceApproval(cy, two)).toBeNull()
    // Ann already counts, so a second of the developer's apps costs no place.
    expect(await consentError(ann, two)).toBeNull()
    await connect(api, ann, two)
    // Another developer's apps are counted apart, and the operator's are not counted at all.
    const theirs = await registerApp(api, { developerId: bo.userId, reviewed: false })
    expect(await consentError(cy, theirs)).toBeNull()
    const operators = await registerApp(api)
    expect(await consentError(cy, operators)).toBeNull()
  })

  test('a reviewed app of the developer’s holds no place, and has only its own cap', async () => {
    await operatorSets(api, 'apps.unreviewedMaxConnections', 1)
    const reviewed = await devApp({ reviewed: true, maxConnections: 2 })
    const unreviewed = await devApp()
    await connect(api, ann, reviewed)
    await connect(api, bo, reviewed)
    expect(await consentError(cy, reviewed)).toBe('max_connections')
    expect(await consentError(cy, unreviewed)).toBeNull()
    const uncapped = await devApp({ reviewed: true })
    for (const who of [ann, bo, cy]) await connect(api, who, uncapped)
    expect(await liveGrants(uncapped)).toHaveLength(3)
  })

  test('the developer’s own connection is neither counted nor refused', async () => {
    await operatorSets(api, 'apps.unreviewedMaxConnections', 1)
    const app = await devApp()
    await connect(api, dev, app)
    await connect(api, ann, app)
    expect(await consentError(bo, app)).toBe('max_connections')
    // Full, and still the developer's to connect, here and on their next app.
    const next = await devApp()
    expect(await consentError(dev, next)).toBeNull()
    expect(await raceApproval(dev, next)).not.toBeNull()
    await operatorSets(api, 'apps.unreviewedMaxConnections', 0)
    expect(await consentError(dev, app)).toBeNull()
    expect(await consentError(ann, app)).toBeNull()
    expect(await consentError(bo, app)).toBe('max_connections')
  })
})

describe('the email permission', () => {
  const list = async (who: SignedIn) =>
    (
      (await (await api.request('/api/v1/connections', { as: who })).json()) as {
        connections: Connection[]
      }
    ).connections
  const exported = async (who: SignedIn) =>
    (
      (await (await api.request('/api/v1/export', { as: who })).json()) as {
        connectedApps: { seesEmail: boolean }[]
      }
    ).connectedApps
  const meOf = async (accessToken: string) =>
    (await (await gateway(api, '/v1/me', { token: accessToken })).json()) as { email?: string }
  const offered = async (app: TestApp) => {
    const { challenge } = await pkce()
    const res = await askConsent(
      api,
      ann,
      authorizationParams(app, challenge, { scope: 'read email' }),
    )
    return ((await res.json()) as ConnectRequest).email
  }

  test('reaches no app Tela has not reviewed, anywhere, and a review gives it back', async () => {
    const app = await devApp({ reviewed: true, allowEmail: true })
    const tokens = await connect(api, ann, app, { scope: 'read email', email: true })
    expect((await meOf(tokens.access_token)).email).toBe('ann@x.test')
    expect((await list(ann))[0]?.email).toBe(true)
    expect((await exported(ann))[0]?.seesEmail).toBe(true)

    // An edit that clears the review takes the permission with it, wherever it is read.
    await api.db.run(sql`update apps set reviewed_at = null where id = ${app.id}`)
    expect(await offered(app)).toBe(false)
    const { challenge } = await pkce()
    const asking = authorizationParams(app, challenge, { scope: 'read email' })
    const refused = await decide(api, ann, asking, { email_granted: true })
    expect([refused.status, await refused.json()]).toEqual([400, { error: 'invalid_scope' }])
    expect((await meOf(tokens.access_token)).email).toBeUndefined()
    expect((await list(ann))[0]?.email).toBe(false)
    expect((await exported(ann))[0]?.seesEmail).toBe(false)

    await api.db.run(sql`update apps set reviewed_at = ${api.clock.now()} where id = ${app.id}`)
    expect(await offered(app)).toBe(true)
    expect((await meOf(tokens.access_token)).email).toBe('ann@x.test')
    expect((await list(ann))[0]?.email).toBe(true)
    expect((await exported(ann))[0]?.seesEmail).toBe(true)
  })

  test('the export says no address where the operator took the permission away', async () => {
    const app = await registerApp(api, { allowEmail: true })
    await connect(api, ann, app, { scope: 'read email', email: true })
    await api.db.run(sql`update apps set allow_email = 0 where id = ${app.id}`)
    expect((await exported(ann))[0]?.seesEmail).toBe(false)
  })
})

describe('a developer out of good standing', () => {
  const suspend = (who: SignedIn, at: number | null) =>
    api.db.run(sql`update profiles set suspended_at = ${at} where user_id = ${who.userId}`)

  test('has their apps answer as cut off, keeping every token, until the suspension is lifted', async () => {
    const app = await devApp({ status: 'approved' })
    const tokens = await connect(api, ann, app)
    const pending = await approve(api, bo, app)
    await suspend(dev, api.clock.now())

    const me = await gateway(api, '/v1/me', { token: tokens.access_token })
    expect([me.status, await me.json()]).toEqual([403, { error: 'app_suspended' }])
    const swapped = await refresh(api, app, tokens.refresh_token)
    expect([swapped.status, await swapped.json()]).toMatchObject([
      400,
      { error: 'unauthorized_client' },
    ])
    expect(await consentError(cy, app)).toBe('app_unavailable')
    expect(await raceApproval(cy, app)).toBeNull()
    // The data layer refuses on its own, past the token endpoint's first answer.
    expect(
      await exchangeCode(api.db, {
        code: pending.code,
        clientId: app.clientId,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.verifier,
        now: api.clock.now(),
      }),
    ).toBeNull()
    expect(
      await api.db.all(sql`select ended_at from app_tokens union all
        select ended_at from app_grants where app_id = ${app.id}`),
    ).toEqual([{ ended_at: null }, { ended_at: null }, { ended_at: null }])

    await suspend(dev, null)
    expect(await meStatus(api, tokens.access_token)).toBe(200)
    expect((await refresh(api, app, tokens.refresh_token)).status).toBe(200)
    expect(await consentError(cy, app)).toBeNull()
  })

  test('a draft of theirs is cut off for them too, and the operator’s apps are untouched', async () => {
    const draft = await devApp({ status: 'draft' })
    const operators = await registerApp(api)
    const own = await connect(api, dev, draft)
    const annTokens = await connect(api, ann, operators)
    await suspend(dev, api.clock.now())
    expect((await gateway(api, '/v1/me', { token: own.access_token })).status).toBe(403)
    expect(await meStatus(api, annTokens.access_token)).toBe(200)
  })
})
