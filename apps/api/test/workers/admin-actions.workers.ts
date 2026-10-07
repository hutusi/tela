/**
 * The admin console's write path on D1 (ADR 0039): an audit row read by `insert … select` with
 * `json_set`, an undo whose guards abort the batch through `lease_fence`, the unsynced review of
 * Not for Discover and the queue it leaves, a review that keeps an unfeatured blog listed (ADR
 * 0041), and the invite
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

it('audits, undoes, reviews for Discover and holds the invite allowance on D1', async () => {
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
  // Hiding decides the blog for Discover (ADR 0041): the review and stamp it found are kept,
  // nulls included, and over nothing decided it records the blog as not for Discover.
  expect(JSON.parse(row?.detail ?? '{}')).toEqual({
    from: { listing: 'listed', review: null, reviewedAt: null },
    to: { listing: 'rejected', review: 'dismissed', reviewedAt: now },
  })
  expect((await undo(hidden.undo?.group ?? '')).status).toBe(200)
  expect(await db.all(sql`select listing, review, reviewed_at from sites where id = 1`)).toEqual([
    { listing: 'listed', review: null, reviewed_at: null },
  ])
  // Undone once, the group is spent: the guard aborts the batch.
  expect((await undo(hidden.undo?.group ?? '')).status).toBe(409)

  // Not for Discover: a blog a member added leaves the review queue with no seq moved, and an
  // undo puts it back.
  await db.run(sql`insert into sites (id, home_url, listing, reader_count, created_at, updated_at)
    values (2, 'https://b.example', 'private', 1, 0, 0)`)
  await db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
    updated_at) values (2, 2, 'https://b.example/feed', 'b.example', 0, 0, 0)`)
  await db.run(sql`insert into articles (feed_id, dedup_key, title, fetched_at, sort_at)
    values (2, 'b1', 'A post', ${now}, ${now})`)
  const queue = async () =>
    (
      (await (await call('/api/v1/admin/discover', { headers: as })).json()) as {
        rows: { id: string; postsLast30d: number }[]
      }
    ).rows
  expect(await queue()).toMatchObject([{ id: '2', postsLast30d: 1 }])
  const seqBefore = await db.all(sql`select seq from sites where id = 2`)
  const dismissed = await act('site.dismiss', ['2'])
  expect(dismissed.done).toEqual(['2'])
  expect(await db.all(sql`select review, reviewed_at, seq from sites where id = 2`)).toEqual([
    { review: 'dismissed', reviewed_at: now, seq: (seqBefore[0] as { seq: number }).seq },
  ])
  expect(await queue()).toEqual([])
  expect((await undo(dismissed.undo?.group ?? '')).status).toBe(200)
  expect(await db.all(sql`select review, reviewed_at from sites where id = 2`)).toEqual([
    { review: null, reviewed_at: null },
  ])
  expect(await queue()).toMatchObject([{ id: '2' }])

  // Featured from the queue and unfeatured, it stays listed: the review says an operator listed
  // it, whatever its one reader says to the doors.
  expect((await act('site.feature', ['2'])).done).toEqual(['2'])
  const unfeatured = await act('site.restore', ['2'])
  expect(unfeatured.done).toEqual(['2'])
  expect(await db.all(sql`select listing, review from sites where id = 2`)).toEqual([
    { listing: 'listed', review: 'listed' },
  ])
  expect((await undo(unfeatured.undo?.group ?? '')).status).toBe(200)
  expect(await db.all(sql`select listing from sites where id = 2`)).toEqual([
    { listing: 'featured' },
  ])

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
