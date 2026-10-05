/**
 * The admin console's write path on D1 (ADR 0039): an audit row read by `insert … select` with
 * `json_set`, an undo whose guards abort the batch through `lease_fence`, and the invite
 * allowance's subquery, which names `invite_codes` again inside a statement over `invite_codes`.
 * libSQL takes all of it; this is where D1 would disagree.
 */
import { env } from 'cloudflare:test'
import { type JobQueues, schema } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'
import { type Blobs, type Jobs, memoryMail } from '@tela/platform'
import { d1Db } from '@tela/platform/cloudflare'
import { CLIENT_HEADER, MEMBER_HEADER, MIN_CLIENT } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createApp } from '../../src/app'

const ORIGIN = 'http://tela.test'

it('audits, undoes and holds the invite allowance on D1', async () => {
  const db = d1Db(env.DB, schema)
  const mail = memoryMail()
  const jobs: Jobs<JobQueues> = { send: async () => {}, sendBatch: async () => {} }
  const now = Date.now()
  const { app } = createApp({
    db,
    blobs: {} as Blobs,
    jobs,
    clock: { now: () => now },
    mail,
    ingest: {} as Ingest,
    config: {
      publicUrl: ORIGIN,
      authSecret: 'a-test-secret-that-is-long-enough-for-hmac',
      adminToken: 'admin',
      mailFrom: 'Tela <noreply@tela.test>',
    },
  })
  const call = (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(`${ORIGIN}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        [CLIENT_HEADER]: String(MIN_CLIENT),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  const operator = { authorization: 'Bearer admin' }
  await call('/api/admin/invite', { body: { email: 'ops@x.test' }, headers: operator })
  const code = mail.outbox.at(-1)?.text.match(/^\d{6}$/m)?.[0]
  const signIn = await call('/api/auth/sign-in/email-otp', {
    body: { email: 'ops@x.test', otp: code },
  })
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const me = (await (await call('/api/v1/me', { headers: { cookie } })).json()) as { id: string }
  await call('/api/admin/admins', { body: { email: 'ops@x.test', admin: true }, headers: operator })
  const as = { cookie, [MEMBER_HEADER]: me.id }
  const act = async (action: string, ids: string[]) =>
    (await (await call('/api/v1/admin/act', { body: { action, ids }, headers: as })).json()) as {
      done: string[]
      failed: { id: string; error: string }[]
      undo: { group: string } | null
    }
  const undo = (group: string) => call('/api/v1/admin/undo', { body: { group }, headers: as })

  // A listing, audited with the value it replaced, and undone.
  await db.run(sql`insert into sites (id, home_url, listing, created_at, updated_at)
    values (1, 'https://a.example', 'listed', 0, 0)`)
  const hidden = await act('site.hide', ['1'])
  expect(hidden.done).toEqual(['1'])
  const [row] = await db.all<{ detail: string }>(
    sql`select detail from admin_actions where action = 'site.hide'`,
  )
  expect(JSON.parse(row?.detail ?? '{}')).toEqual({
    from: { listing: 'listed' },
    to: { listing: 'rejected' },
  })
  expect((await undo(hidden.undo?.group ?? '')).status).toBe(200)
  expect(await db.all(sql`select listing from sites where id = 1`)).toEqual([{ listing: 'listed' }])
  // Undone once, the group is spent: the guard aborts the batch.
  expect((await undo(hidden.undo?.group ?? '')).status).toBe(409)

  // Five codes of the member's own count; a sixth cannot be opened by restoring one.
  await db.run(sql`insert into invite_codes (code, created_by, max_uses, created_at)
    select 'MEMBERCODE0' || value, ${me.id}, 1, 0 from json_each('[1,2,3,4,5]')`)
  const revoked = await act('code.revoke', ['code:MEMBERCODE01'])
  expect(revoked.done).toEqual(['code:MEMBERCODE01'])
  await db.run(sql`insert into invite_codes (code, created_by, max_uses, created_at)
    values ('MEMBERCODE06', ${me.id}, 1, 0)`)
  expect(await act('code.restore', ['code:MEMBERCODE01'])).toMatchObject({
    failed: [{ id: 'code:MEMBERCODE01', error: 'limit' }],
  })
  expect((await undo(revoked.undo?.group ?? '')).status).toBe(409)
  await db.run(sql`delete from invite_codes where code = 'MEMBERCODE06'`)
  expect(await (await undo(revoked.undo?.group ?? '')).json()).toEqual({ restored: 1 })
  expect(
    await db.all(sql`select revoked_at from invite_codes where code = 'MEMBERCODE01'`),
  ).toEqual([{ revoked_at: null }])
})
