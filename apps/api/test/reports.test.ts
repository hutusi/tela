/**
 * Reports and suspension in the admin console (ADR 0059): each thing members reported is queued
 * once, however many reported it, and resolved or dismissed with an undo; suspending a member signs
 * them out and takes them off every public answer (`standing.test.ts` holds what each answer
 * leaves out) until the suspension is lifted.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { currentSeq, first, nextUtcMidnight, type TelaDb, utcDay } from '@tela/data'
import type {
  AdminActResponse,
  AdminCounts,
  AdminList,
  AdminPersonRow,
  AdminReportDetail,
  AdminReportRow,
} from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { ADMIN_TOKEN, createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'
import {
  ANNA,
  annaInPublic,
  BEA,
  HIDDEN,
  pullOf,
  ROLL,
  SHOWN,
  seedAnna,
  write as writeTo,
} from './standing-fixture'

let api: TestApi
let db: TelaDb
let ops: SignedIn
let rep: SignedIn
let other: SignedIn

const write = (...statements: ReturnType<TelaDb['run']>[]) => writeTo(db, ...statements)

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  ops = await signedIn(api, 'ops@x.test')
  rep = await signedIn(api, 'rep@x.test')
  other = await signedIn(api, 'other@x.test')
  const granted = await api.request('/api/admin/admins', {
    body: { email: 'ops@x.test', admin: true },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  expect(granted.status).toBe(200)
  // Anna writes blog 1, recommends post 1 with a note and has a public blogroll; rep follows her.
  await seedAnna(api, rep)
})

const report = (body: unknown, as: SignedIn | undefined = rep) =>
  api.request('/api/v1/reports', { body, ...(as ? { as } : {}) })

const reportRows = () =>
  db.all<{
    reporter_id: string
    target_kind: string
    target_key: string
    reason: string
    details: string | null
    url: string | null
    state: string
  }>(sql`select reporter_id, target_kind, target_key, reason, details, url, state from reports
    order by id`)

const act = async (body: unknown) => {
  const res = await api.request('/api/v1/admin/act', { as: ops, body })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminActResponse
}
const undo = (group: string) => api.request('/api/v1/admin/undo', { as: ops, body: { group } })

async function get<T>(path: string, as: SignedIn = ops): Promise<{ status: number; body: T }> {
  const res = await api.request(path, { as })
  return { status: res.status, body: (await res.json()) as T }
}
const queue = async (f = 'open', q = '') =>
  (
    await get<AdminList<AdminReportRow, 'reports'>>(
      `/api/v1/admin/reports?f=${f}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    )
  ).body

describe('the Reports area', () => {
  test('lists each thing once, counting its reporters, and names them only in its record', async () => {
    api.clock.advance(1000)
    await report({ targetKind: 'profile', targetKey: ANNA, reason: 'spam', details: 'Old words' })
    api.clock.advance(1000)
    await report(
      { targetKind: 'profile', targetKey: ANNA, reason: 'impersonation', details: 'Newer words' },
      other,
    )
    api.clock.advance(1000)
    await report({ targetKind: 'site', targetKey: '2', reason: 'copyright' })

    const open = await queue()
    expect(open.counts).toEqual({ open: 2, resolved: 0, dismissed: 0 })
    expect(open.rows.map((r) => r.id)).toEqual(['site:2', `profile:${ANNA}`])
    const anna = open.rows[1]
    expect(anna).toMatchObject({
      actions: ['report.resolve', 'report.dismiss'],
      state: 'open',
      reason: 'impersonation',
      reasons: ['spam', 'impersonation'],
      details: 'Newer words',
      reporters: 2,
      decidedAt: null,
      decidedBy: null,
      target: {
        kind: 'profile',
        key: ANNA,
        label: 'Name anna',
        path: '/@anna',
        member: { id: ANNA, handle: 'anna', name: 'Name anna', standing: 'ok' },
        actions: [
          { action: 'member.suspend', id: ANNA },
          { action: 'member.delete', id: ANNA },
        ],
      },
    })
    // The row never names who reported it; the record does, to the operator.
    expect(JSON.stringify(open)).not.toContain(rep.userId)
    const { body: detail } = await get<AdminReportDetail>(
      `/api/v1/admin/reports/${encodeURIComponent(`profile:${ANNA}`)}`,
    )
    expect(detail.reports.map((r) => [r.reporter?.id, r.reason, r.details])).toEqual([
      [other.userId, 'impersonation', 'Newer words'],
      [rep.userId, 'spam', 'Old words'],
    ])
    expect(detail.report.id).toBe(`profile:${ANNA}`)
    // Searched by the reported member's handle, or the words.
    expect((await queue('open', 'ANNA')).rows.map((r) => r.id)).toEqual([`profile:${ANNA}`])
    expect((await queue('open', 'newer')).rows.map((r) => r.id)).toEqual([`profile:${ANNA}`])
    expect((await queue('open', 'two.example')).rows.map((r) => r.id)).toEqual(['site:2'])
    // The sidebar's badge counts things, not reports.
    expect((await get<AdminCounts>('/api/v1/admin/counts')).body.reports).toBe(2)
    expect((await api.request('/api/v1/admin/reports?f=nope', { as: ops })).status).toBe(400)
    expect((await api.request('/api/v1/admin/reports/site:99', { as: ops })).status).toBe(404)
    expect((await api.request('/api/v1/admin/reports/bogus', { as: ops })).status).toBe(404)
    expect((await api.request('/api/v1/admin/reports?f=open', { as: rep })).status).toBe(403)
  })

  test('says what can be done to each thing, and what has been', async () => {
    await report({ targetKind: 'blogroll', targetKey: ROLL, reason: 'spam' })
    await report({ targetKind: 'site', targetKey: '1', reason: 'spam' })
    await report({ targetKind: 'recommendation', targetKey: `${ANNA}:1`, reason: 'abuse' })
    const rows = new Map((await queue()).rows.map((r) => [r.id, r.target]))
    expect(rows.get(`blogroll:${ROLL}`)).toMatchObject({
      label: 'Anna reads',
      path: `/l/${ROLL}`,
      member: { id: ANNA },
      actions: [
        { action: 'blogroll.hide', id: ROLL },
        { action: 'member.suspend', id: ANNA },
        { action: 'member.delete', id: ANNA },
      ],
    })
    expect(rows.get('site:1')).toMatchObject({
      label: 'Anna writes',
      path: '/s/1',
      siteId: 1,
      member: null,
      actions: [{ action: 'site.hide', id: '1' }],
    })
    expect(rows.get(`recommendation:${ANNA}:1`)).toMatchObject({
      label: 'Read this one',
      path: '/@anna',
      member: { id: ANNA, standing: 'ok' },
    })

    // Acted on from the console's other areas, the row says so.
    expect((await act({ action: 'site.hide', ids: ['1'] })).done).toEqual(['1'])
    expect((await act({ action: 'blogroll.hide', ids: [ROLL] })).done).toEqual([ROLL])
    expect((await act({ action: 'member.suspend', ids: [ANNA] })).done).toEqual([ANNA])
    const after = new Map((await queue()).rows.map((r) => [r.id, r.target]))
    expect(after.get('site:1')).toMatchObject({ path: null, actions: [] })
    expect(after.get(`blogroll:${ROLL}`)).toMatchObject({
      label: 'Anna reads',
      path: null,
      member: { standing: 'suspended' },
      actions: [
        { action: 'member.unsuspend', id: ANNA },
        { action: 'member.delete', id: ANNA },
      ],
    })
    // A note still shows to the operator once its author is suspended; taken back, it does not.
    expect(after.get(`recommendation:${ANNA}:1`)).toMatchObject({
      label: 'Read this one',
      path: null,
    })
    await write(db.run(sql`update recommendations set deleted_at = 1 where user_id = ${ANNA}`))
    const taken = (await queue()).rows.find((r) => r.id === `recommendation:${ANNA}:1`)
    expect(taken?.target.label).toBeNull()
  })

  test('Resolve and Dismiss close every open report of a thing, and an undo opens them again', async () => {
    await report({ targetKind: 'site', targetKey: '2', reason: 'spam' })
    await report({ targetKind: 'site', targetKey: '2', reason: 'copyright' }, other)
    const resolved = await act({ action: 'report.resolve', ids: ['site:2', 'site:99'] })
    expect(resolved.done).toEqual(['site:2'])
    expect(resolved.failed).toEqual([{ id: 'site:99', error: 'not_found' }])
    expect(resolved.undo).not.toBeNull()
    expect((await reportRows()).map((r) => r.state)).toEqual(['resolved', 'resolved'])
    expect((await queue()).rows).toEqual([])
    const done = await queue('resolved')
    expect(done.counts).toEqual({ open: 0, resolved: 1, dismissed: 0 })
    expect(done.rows[0]).toMatchObject({
      id: 'site:2',
      actions: [],
      reporters: 2,
      decidedAt: api.clock.now(),
      decidedBy: { id: ops.userId },
    })
    // Nothing open is left to decide.
    expect((await act({ action: 'report.dismiss', ids: ['site:2'] })).failed).toEqual([
      { id: 'site:2', error: 'not_applicable' },
    ])

    const back = await undo(resolved.undo?.group ?? '')
    expect(back.status).toBe(200)
    expect((await reportRows()).map((r) => r.state)).toEqual(['open', 'open'])
    const { body: detail } = await get<AdminReportDetail>('/api/v1/admin/reports/site:2')
    expect(detail.history.map((h) => [h.action, h.undid ?? null])).toEqual([
      ['undo', 'report.resolve'],
      ['report.resolve', null],
    ])
  })

  test('an undo is refused once a later decision closed reports of the same thing', async () => {
    await report({ targetKind: 'site', targetKey: '2', reason: 'spam' })
    const first = await act({ action: 'report.resolve', ids: ['site:2'] })
    await report({ targetKind: 'site', targetKey: '2', reason: 'spam' }, other)
    expect((await act({ action: 'report.dismiss', ids: ['site:2'] })).done).toEqual(['site:2'])
    const refused = await undo(first.undo?.group ?? '')
    expect(refused.status).toBe(409)
    expect((await reportRows()).map((r) => r.state)).toEqual(['resolved', 'dismissed'])
  })
})

const sessionsOf = async (userId: string) =>
  (await first<{ n: number }>(db, sql`select count(*) as n from session where user_id = ${userId}`))
    ?.n ?? 0

describe('suspending a member', () => {
  test('takes them off every public answer, and lifting it puts them back', async () => {
    expect(await annaInPublic(api)).toEqual(SHOWN)
    const suspended = await act({ action: 'member.suspend', ids: [ANNA] })
    expect(suspended.done).toEqual([ANNA])
    expect(await annaInPublic(api)).toEqual(HIDDEN)
    expect(
      (
        await first<{ s: number | null }>(
          db,
          sql`select suspended_at as s from profiles
        where user_id = ${ANNA}`,
        )
      )?.s,
    ).toBe(api.clock.now())
    const lifted = await act({ action: 'member.unsuspend', ids: [ANNA] })
    expect(lifted.done).toEqual([ANNA])
    expect(await annaInPublic(api)).toEqual(SHOWN)
  })

  test('a closed account has nothing to suspend or lift', async () => {
    await write(db.run(sql`update profiles set deleted_at = 1 where user_id = ${ANNA}`))
    expect(await annaInPublic(api)).toEqual(HIDDEN)
    expect((await act({ action: 'member.suspend', ids: [ANNA] })).failed).toEqual([
      { id: ANNA, error: 'not_applicable' },
    ])
  })

  test('signs them out everywhere, and counts them out of others’ follows', async () => {
    expect(await sessionsOf(other.userId)).toBe(1)
    await write(
      db.run(sql`insert into follows (follower_id, followee_id, created_at, updated_at, seq)
        values (${other.userId}, ${rep.userId}, 0, 0, ${currentSeq}),
          (${rep.userId}, ${other.userId}, 0, 0, ${currentSeq})`),
    )
    const repHandle = await handle(rep.userId)
    const counts = async () => {
      const res = await api.request(`/api/v1/public/profiles/${repHandle}`)
      return ((await res.json()) as { counts: { following: number; followers: number } }).counts
    }
    expect(await counts()).toEqual(expect.objectContaining({ following: 2, followers: 1 }))
    expect((await act({ action: 'member.suspend', ids: [other.userId] })).done).toEqual([
      other.userId,
    ])
    expect(await sessionsOf(other.userId)).toBe(0)
    expect((await api.request('/api/v1/account', { as: other })).status).toBe(401)
    expect(await counts()).toEqual(expect.objectContaining({ following: 1, followers: 0 }))
    const people = await get<AdminList<AdminPersonRow, 'people'>>(
      '/api/v1/admin/people?f=suspended',
    )
    expect(people.body.counts).toMatchObject({ suspended: 1 })
    expect(people.body.rows.map((r) => [r.userId, r.actions, r.suspendedAt])).toEqual([
      // A suspension can be lifted, and the account can still be deleted (ADR 0058).
      [other.userId, ['member.unsuspend', 'member.delete'], api.clock.now()],
    ])
  })

  test('ends the translations they asked for that have not started, and gives them back', async () => {
    const today = utcDay(api.clock.now())
    const tomorrow = utcDay(nextUtcMidnight(api.clock.now()))
    // As this round's tela-api reserves them: counted, and marked so (ADR 0057).
    const ask = (ck: string, state: string, by: string, reserved: number, day: string) =>
      db.run(sql`insert into body_translations (content_key, lang, state, request_id, requested_by,
          reserved_tokens, reserved_spend, reserved_day, due_at, updated_at, seq)
        values (${ck}, 'fr', ${state}, ${`r-${ck}`}, ${by}, ${reserved}, 1, ${day},
          ${day === tomorrow ? nextUtcMidnight(api.clock.now()) : null}, 0, ${currentSeq})`)
    await write(
      // One waits for tomorrow, one is due and not begun, one runs; and the operator's own.
      ask('waits', 'requested', other.userId, 5000, tomorrow),
      ask('due', 'requested', other.userId, 3000, today),
      ask('runs', 'running', other.userId, 2000, today),
      ask('ops', 'requested', ops.userId, 1000, today),
      db.run(sql`insert into usage_daily (subject, day, reserved, used, requests)
        values (${other.userId}, ${today}, 5000, 0, 2), (${other.userId}, ${tomorrow}, 5000, 0, 1),
          (${ops.userId}, ${today}, 1000, 0, 1)`),
      db.run(sql`insert into leases (kind, key, owner, until)
        values ('translate.body', 'due:fr', 'claimed', ${api.clock.now() + 60_000})`),
    )
    expect((await act({ action: 'member.suspend', ids: [ops.userId] })).done).toEqual([])
    expect((await act({ action: 'member.suspend', ids: [other.userId] })).done).toEqual([
      other.userId,
    ])
    expect(
      await db.all(sql`select content_key, state, reserved_tokens, due_at from body_translations
        order by content_key`),
    ).toEqual([
      { content_key: 'due', state: 'failed', reserved_tokens: 0, due_at: null },
      { content_key: 'ops', state: 'requested', reserved_tokens: 1000, due_at: null },
      { content_key: 'runs', state: 'running', reserved_tokens: 2000, due_at: null },
      { content_key: 'waits', state: 'failed', reserved_tokens: 0, due_at: null },
    ])
    // What the running one holds stays until it settles; the others' tokens and counts go back.
    expect(
      await db.all(sql`select subject = ${ops.userId} as ops, day, reserved, requests
        from usage_daily order by ops, day`),
    ).toEqual([
      { ops: 0, day: today, reserved: 2000, requests: 1 },
      { ops: 0, day: tomorrow, reserved: 0, requests: 0 },
      { ops: 1, day: today, reserved: 1000, requests: 1 },
    ])
    // A run that claimed the one due writes nothing more.
    expect(await first(db, sql`select 1 as x from leases where key = 'due:fr'`)).toBeUndefined()
  })

  test('is refused for an admin, yourself and nobody, and undone while nothing moved', async () => {
    await api.request('/api/admin/admins', {
      body: { email: 'other@x.test', admin: true },
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(
      await act({ action: 'member.suspend', ids: [ops.userId, other.userId, 'nobody'] }),
    ).toEqual({
      done: [],
      failed: [
        { id: ops.userId, error: 'not_applicable' },
        { id: other.userId, error: 'not_applicable' },
        { id: 'nobody', error: 'not_found' },
      ],
      undo: null,
    })
    const suspended = await act({ action: 'member.suspend', ids: [ANNA] })
    const back = await undo(suspended.undo?.group ?? '')
    expect(back.status).toBe(200)
    expect(await annaInPublic(api)).toEqual(SHOWN)
    // Undoing a lift suspends again, and signs out whoever signed in meanwhile.
    expect((await act({ action: 'member.suspend', ids: [rep.userId] })).done).toEqual([rep.userId])
    const lifted = await act({ action: 'member.unsuspend', ids: [rep.userId] })
    await db.run(sql`insert into session (id, expires_at, token, created_at, updated_at, user_id)
      values ('s-again', ${Date.now() + 86_400_000}, 'tok-again', 0, 0, ${rep.userId})`)
    expect((await undo(lifted.undo?.group ?? '')).status).toBe(200)
    expect(await sessionsOf(rep.userId)).toBe(0)
    const audit = await db.all<{ action: string }>(sql`select action from admin_actions
      where target_kind = 'member' and target_key = ${rep.userId} order by id`)
    expect(audit.map((a) => a.action)).toEqual(['member.suspend', 'member.unsuspend', 'undo'])
  })

  test('a follower’s device drops the follow, Following leaves them out, and nobody new can follow', async () => {
    const before = await pullOf(api, rep, 0)
    expect(before.rows.follows.map((f) => f.userId)).toEqual([ANNA])
    const cursor = before.cursor
    await act({ action: 'member.suspend', ids: [ANNA, BEA] })
    const delta = await pullOf(api, rep, cursor)
    expect(delta.rows.follows.map((f) => [f.userId, f.deletedAt])).toEqual([
      [ANNA, api.clock.now()],
    ])
    expect((await pullOf(api, rep, 0)).rows.follows).toEqual([])
    const following = await get<{ items: { person: { id: string } }[] }>('/api/v1/following', rep)
    expect(following.body.items.map((i) => i.person.id)).not.toContain(ANNA)

    // A follow of a suspended member is acknowledged, and writes nothing.
    const pushed = await api.request('/api/v1/mutations', {
      as: rep,
      body: {
        mutations: [{ mid: 'follow-bea-0001', at: api.clock.now(), type: 'follow', userId: BEA }],
      },
    })
    expect(pushed.status).toBe(200)
    expect(await db.all(sql`select 1 from follows where followee_id = ${BEA}`)).toEqual([])

    // Lifted, the follow comes back on the next pull, as it was.
    const at = (await pullOf(api, rep, 0)).cursor
    await act({ action: 'member.unsuspend', ids: [ANNA] })
    expect((await pullOf(api, rep, at)).rows.follows.map((f) => [f.userId, f.deletedAt])).toEqual([
      [ANNA, null],
    ])
  })
})

async function handle(userId: string) {
  return (
    (
      await first<{ handle: string }>(
        db,
        sql`select handle from profiles where user_id = ${userId}`,
      )
    )?.handle ?? ''
  )
}
