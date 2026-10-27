/**
 * Hide from Discover for blogrolls on D1 (ADR 0050): the first library action whose target has a
 * text key, audited and undone through the same `insert … select` and `lease_fence` guard as the
 * rest, with no seq moved and the member's `updated_at` left alone; and the Blogrolls ledger,
 * whose first blogs come from a correlated subquery in a `from` inside a scalar subquery. libSQL
 * takes all of it; this is where D1 would disagree.
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

it('lists, hides, restores and undoes a blogroll by its text id on D1', async () => {
  const db = d1Db(env.DB, schema)
  const mail = memoryMail()
  const jobs: Jobs<JobQueues> = { send: async () => {}, sendBatch: async () => {} }
  let now = Date.now()
  const { app } = createApp({
    db,
    blobs: {} as Blobs,
    jobs,
    clock: { now: () => now },
    mail,
    ingest: {} as Ingest,
    config: {
      publicUrl: ORIGIN,
      apiUrl: 'http://api.tela.test',
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

  // Three blogs, one the operator hid, in a public blogroll of the operator's own, and a private
  // one beside it.
  await db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at)
    select value, 'https://' || value || '.example', 'Blog ' || value,
      case when value = 3 then 'rejected' else 'listed' end, 0, 0
    from json_each('[1,2,3,4]')`)
  await db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
      updated_at)
    select value, value, 'https://' || value || '.example/feed', value || '.example', 0, 0, 0
    from json_each('[1,2,3,4]')`)
  const id = 'AbCdEf012345'
  await db.run(sql`insert into blogrolls (id, user_id, name, is_public, public_version,
      public_since, created_at, updated_at, seq)
    values (${id}, ${me.id}, 'Essays', 1, 1, ${now - 1000}, 0, 5, 9),
      ('Private00001', ${me.id}, 'Mine', 0, 0, null, 0, 5, 9)`)
  await db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, added_at,
      updated_at, seq)
    select ${id}, value, ${me.id}, value, value, 9 from json_each('[1,2,3,4]')`)

  const ledger = async () =>
    (await (await call('/api/v1/admin/discover?f=blogrolls', { headers: as })).json()) as {
      counts: Record<string, number>
      rows: {
        id: string
        blogCount: number
        totalCount: number
        inDiscover: boolean
        actions: string[]
        blogs: { name: string | null }[]
      }[]
    }
  const listed = await ledger()
  expect(listed.counts.blogrolls).toBe(1)
  expect(listed.rows).toMatchObject([
    {
      id,
      blogCount: 3,
      totalCount: 4,
      inDiscover: true,
      actions: ['blogroll.hide'],
      blogs: [{ name: 'Blog 1' }, { name: 'Blog 2' }, { name: 'Blog 4' }],
    },
  ])

  const row = async () =>
    db.all(sql`select hidden_at, updated_at, seq from blogrolls where id = ${id}`)
  const head = async () => db.all(sql`select v from counters where k = 'seq'`)
  const seqBefore = await head()

  // Hide: audited with the null it replaced, no seq moved, the member's clock left alone.
  const hidden = await act('blogroll.hide', [id])
  expect(hidden.done).toEqual([id])
  expect(await row()).toEqual([{ hidden_at: now, updated_at: 5, seq: 9 }])
  expect(await head()).toEqual(seqBefore)
  const [audited] = await db.all<{ target_key: string; detail: string }>(
    sql`select target_key, detail from admin_actions where action = 'blogroll.hide'`,
  )
  expect(audited?.target_key).toBe(id)
  expect(JSON.parse(audited?.detail ?? '{}')).toEqual({
    from: { hiddenAt: null },
    to: { hiddenAt: now },
  })
  expect((await ledger()).rows[0]).toMatchObject({
    inDiscover: false,
    actions: ['blogroll.restore'],
  })
  expect(await (await undo(hidden.undo?.group ?? '')).json()).toEqual({ restored: 1 })
  expect(await row()).toEqual([{ hidden_at: null, updated_at: 5, seq: 9 }])
  expect((await undo(hidden.undo?.group ?? '')).status).toBe(409)

  // Restore, undone back to the moment it was hidden; refused once a Hide came since.
  const hiddenAt = now
  expect((await act('blogroll.hide', [id])).done).toEqual([id])
  now += 60_000
  const restored = await act('blogroll.restore', [id])
  expect(restored.done).toEqual([id])
  expect(await (await undo(restored.undo?.group ?? '')).json()).toEqual({ restored: 1 })
  expect(await row()).toEqual([{ hidden_at: hiddenAt, updated_at: 5, seq: 9 }])
  const again = await act('blogroll.restore', [id])
  expect((await act('blogroll.hide', [id])).done).toEqual([id])
  expect((await undo(again.undo?.group ?? '')).status).toBe(409)
  expect(await head()).toEqual(seqBefore)

  // A private blogroll is neither acted on nor opened.
  expect(await act('blogroll.hide', ['Private00001'])).toMatchObject({
    failed: [{ id: 'Private00001', error: 'not_applicable' }],
  })
  expect((await call('/api/v1/admin/blogrolls/Private00001', { headers: as })).status).toBe(404)
  const record = (await (await call(`/api/v1/admin/blogrolls/${id}`, { headers: as })).json()) as {
    blogs: { feedId: number; shown: boolean }[]
    history: { action: string }[]
  }
  expect(record.blogs.map((b) => [b.feedId, b.shown])).toEqual([
    [1, true],
    [2, true],
    [3, false],
    [4, true],
  ])
  expect(record.history.map((h) => h.action)).toEqual([
    'blogroll.hide',
    'blogroll.restore',
    'undo',
    'blogroll.restore',
    'blogroll.hide',
    'undo',
    'blogroll.hide',
  ])
})
