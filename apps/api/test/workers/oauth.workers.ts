import { env } from 'cloudflare:test'
import { type JobQueues, pkceS256, randomSecret, schema } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'
import { type Blobs, type Jobs, memoryMail } from '@tela/platform'
import { d1Db } from '@tela/platform/cloudflare'
import { REFRESH_GRACE_MS } from '@tela/shared'
import { CLIENT_HEADER, MEMBER_HEADER, MIN_CLIENT } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createApp } from '../../src/app'

// The authorization server's statements on D1 (ADR 0064): the consent page's upsert through the
// partial unique index, the code exchange's conditional batch, refresh rotation with its grace and
// reuse, a token resolved in one batch that counts and stamps, and connections ended beside
// sessions. The bun suite runs all of it on libSQL; this is where D1 could disagree.

const ORIGIN = 'http://tela.test'
const API = 'http://api.tela.test'
const REDIRECT = 'http://127.0.0.1:53682/callback'
const unused = () => {
  throw new Error('not used here')
}

function stack() {
  const db = d1Db(env.DB, schema)
  const mail = memoryMail()
  const clock = { at: Date.now(), now: () => clock.at }
  const jobs: Jobs<JobQueues> = { send: async () => {}, sendBatch: async () => {} }
  const { app } = createApp({
    db,
    blobs: {
      get: unused,
      put: unused,
      head: unused,
      delete: unused,
      list: unused,
    } as unknown as Blobs,
    jobs,
    clock,
    mail,
    ingest: {} as Ingest,
    config: {
      publicUrl: ORIGIN,
      apiUrl: API,
      authSecret: 'a-test-secret-that-is-long-enough-for-hmac',
      adminToken: 'admin',
      mailFrom: 'Tela <noreply@tela.test>',
    },
  })
  const call = (
    path: string,
    init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> },
  ) =>
    app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        [CLIENT_HEADER]: String(MIN_CLIENT),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  /** The app's side: tela-gateway forwarding to `/gateway`, never with a cookie. */
  const gateway = (path: string, init: { token?: string; form?: Record<string, string> } = {}) =>
    app.request(`${API}/gateway${path}`, {
      method: init.form ? 'POST' : 'GET',
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    })

  /** Invite and sign in a member; their cookie and the headers every member call carries. */
  async function member(email: string) {
    await call('/api/admin/invite', { body: { email }, headers: { authorization: 'Bearer admin' } })
    const otp = [...mail.outbox]
      .reverse()
      .find((m) => m.to === email)
      ?.text.match(/^\d{6}$/m)?.[0]
    const res = await call('/api/auth/sign-in/email-otp', { body: { email, otp } })
    expect(res.status).toBe(200)
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    const me = (await (await call('/api/v1/me', { cookie })).json()) as { id: string }
    return { id: me.id, cookie, headers: { [MEMBER_HEADER]: me.id } }
  }
  type Member = Awaited<ReturnType<typeof member>>

  /** Approve `clientId` for a member and exchange the code: a device's tokens. */
  async function connect(who: Member, clientId: string) {
    const verifier = randomSecret(32)
    const params = {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'write',
      state: 's',
      code_challenge: await pkceS256(verifier),
      code_challenge_method: 'S256',
    }
    const decided = await call('/api/v1/connect/decide', {
      ...who,
      body: { ...params, decision: 'approve', scope_granted: 'write', email_granted: false },
    })
    expect(decided.status).toBe(200)
    const { redirect } = (await decided.json()) as { redirect: string }
    const code = new URL(redirect).searchParams.get('code') ?? ''
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }
    const res = await gateway('/oauth/token', { form })
    expect(res.status).toBe(200)
    const tokens = (await res.json()) as { access_token: string; refresh_token: string }
    return { ...tokens, form }
  }

  return { db, clock, call, gateway, member, connect }
}

it('connects, resolves, rotates and ends an app on D1', async () => {
  const { db, clock, call, gateway, member, connect } = stack()
  const ann = await member('ann.oauth@x.test')
  await db.run(sql`insert into apps (client_id, name, developer, contact_email, redirect_uris,
      max_scope, status, per_member_per_min, created_at, updated_at)
    values ('tela_app_d1', 'D1 App', 'Dev', 'dev@x.test', '["http://127.0.0.1/callback"]', 'write',
      'approved', 3, 0, 0)`)

  // Consent twice: one connection through the partial unique index, updated the second time.
  const first = await connect(ann, 'tela_app_d1')
  const device = await connect(ann, 'tela_app_d1')
  expect(
    await db.all(sql`select count(*) as n from app_grants where user_id = ${ann.id}
      and ended_at is null`),
  ).toEqual([{ n: 1 }])

  // A replayed code ends the device it made, in the exchange's batch.
  const replay = await gateway('/oauth/token', { form: first.form })
  expect(await replay.json()).toEqual({ error: 'invalid_grant' })
  expect((await gateway('/v1/me', { token: first.access_token })).status).toBe(401)

  // Resolved in one batch that counts: three a minute for this app, then 429.
  for (let i = 0; i < 3; i++) {
    expect((await gateway('/v1/me', { token: device.access_token })).status).toBe(200)
  }
  const over = await gateway('/v1/me', { token: device.access_token })
  expect(over.status).toBe(429)
  expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
  expect(
    await db.all(sql`select key, count from action_limits
      where key like 'appMember.%' or key like 'appTotal:%' order by key`),
  ).toEqual([
    { key: `appMember.1:${ann.id}`, count: 4 },
    { key: 'appTotal:1', count: 4 },
  ])
  // The device was marked used, and when, on it and its connection.
  expect(
    await db.all(sql`select t.pristine, t.last_used_at = ${clock.at} as stamped,
        g.last_used_at = ${clock.at} as grant_stamped
      from app_tokens t join app_grants g on g.id = t.grant_id where t.ended_at is null`),
  ).toEqual([{ pristine: 0, stamped: 1, grant_stamped: 1 }])
  clock.at += 60_000

  // Rotation: the swap, a lost answer retried inside the grace, then reuse ending the device.
  const refresh = (refreshToken: string) =>
    gateway('/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'tela_app_d1' },
    })
  const lost = (await (await refresh(device.refresh_token)).json()) as { refresh_token: string }
  const retried = await refresh(device.refresh_token)
  expect(retried.status).toBe(200)
  const kept = (await retried.json()) as { access_token: string; refresh_token: string }
  expect(lost.refresh_token).not.toBe(kept.refresh_token)
  expect((await gateway('/v1/me', { token: kept.access_token })).status).toBe(200)
  clock.at += REFRESH_GRACE_MS
  expect(await (await refresh(device.refresh_token)).json()).toEqual({ error: 'invalid_grant' })
  expect((await gateway('/v1/me', { token: kept.access_token })).status).toBe(401)
  expect(await db.all(sql`select end_reason from app_tokens order by id`)).toEqual([
    { end_reason: 'reuse' },
    { end_reason: 'reuse' },
  ])

  // Two swaps racing on D1: one wins the conditional update, the other is a lost answer.
  const racer = await connect(ann, 'tela_app_d1')
  clock.at += 60_000
  const [one, two] = await Promise.all([refresh(racer.refresh_token), refresh(racer.refresh_token)])
  expect([one.status, two.status]).toEqual([200, 200])
  expect(await db.all(sql`select count(*) as n from app_tokens where ended_at is null`)).toEqual([
    { n: 1 },
  ])

  // Signing out everywhere ends the connection in the batch that ends the sessions.
  const out = await call('/api/v1/account/sign-out-everywhere', { ...ann, body: {} })
  expect(out.status).toBe(200)
  expect(await db.all(sql`select end_reason from app_grants where user_id = ${ann.id}`)).toEqual([
    { end_reason: 'signOutEverywhere' },
  ])
  const two_ = (await two.json()) as { access_token: string }
  const one_ = (await one.json()) as { access_token: string }
  for (const token of [one_.access_token, two_.access_token]) {
    expect((await gateway('/v1/me', { token })).status).toBe(401)
  }
})
