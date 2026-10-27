/**
 * Blogrolls' push and pull on D1 (ADR 0050). Every statement is a raw one with bound parameters in
 * a seq-stamped batch, which drizzle's own D1 batch could not bind (AGENTS.md); the upserts are
 * insert-selects with ON CONFLICT, a show's version a bound parameter in a CASE, and the pull
 * joins blogrolls to send a blog's feed to an owner who does not subscribe to it. libSQL takes
 * all of it; this is where D1 would disagree.
 */
import { env } from 'cloudflare:test'
import { bumpSeq, currentSeq, type JobQueues, schema } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'
import { type Blobs, type Jobs, memoryMail } from '@tela/platform'
import { d1Db } from '@tela/platform/cloudflare'
import {
  CLIENT_HEADER,
  MEMBER_HEADER,
  MIN_CLIENT,
  type PullResponse,
  type PushResponse,
} from '@tela/sync'
import { sql } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createApp } from '../../src/app'

const ORIGIN = 'http://tela.test'
const ID = 'RollD1D1D1D1'

it('puts, switches, fills, notes, empties and deletes a blogroll on D1', async () => {
  const db = d1Db(env.DB, schema)
  const mail = memoryMail()
  const jobs: Jobs<JobQueues> = { send: async () => {}, sendBatch: async () => {} }
  const { app } = createApp({
    db,
    blobs: {} as Blobs,
    jobs,
    clock: { now: () => Date.now() },
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
  const call = (
    path: string,
    init: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
  ) =>
    app.request(`${ORIGIN}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        [CLIENT_HEADER]: String(MIN_CLIENT),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

  await call('/api/admin/invite', {
    body: { email: 'roller@x.test' },
    headers: { authorization: 'Bearer admin' },
  })
  const code = mail.outbox.at(-1)?.text.match(/^\d{6}$/m)?.[0]
  const signIn = await call('/api/auth/sign-in/email-otp', {
    body: { email: 'roller@x.test', otp: code },
  })
  expect(signIn.status).toBe(200)
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const me = (await (await call('/api/v1/me', { cookie })).json()) as { id: string }
  const member = { cookie, headers: { [MEMBER_HEADER]: me.id } }
  const push = async (mutations: unknown[]) =>
    (await (
      await call('/api/v1/mutations', { body: { mutations }, ...member })
    ).json()) as PushResponse
  const pull = async (cursor: number) =>
    (await (await call(`/api/v1/sync?cursor=${cursor}`, member)).json()) as PullResponse

  // Two blogs the member does not subscribe to; the second merged into the first.
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, title, created_at, updated_at, seq)
      values (71, 'https://rolled.example', 'Rolled', 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (71, 71, 'https://rolled.example/feed', 'rolled.example', 0, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at,
      status, merged_into, seq)
      values (72, 71, 'https://rolled.example/atom', 'rolled.example', 0, 0, 0, 'paused', 71, ${currentSeq})`),
  ])

  const now = Date.now()
  const first = [
    {
      mid: 'roll-put-0001',
      at: now,
      type: 'putBlogroll',
      id: ID,
      name: 'On D1',
      description: 'Two\nlines',
      isPublic: false,
    },
    // Through the feed a merged one became, into a live blogroll, held to the limit.
    { mid: 'roll-roll-0001', at: now, type: 'rollBlog', blogrollId: ID, feedId: 72 },
    { mid: 'roll-note-0001', at: now, type: 'noteBlog', blogrollId: ID, feedId: 71, note: 'Hi' },
    { mid: 'roll-show-0001', at: now, type: 'setBlogrollPublic', id: ID, isPublic: true, base: 0 },
    // Refused one by one: the rest of the push applies.
    {
      mid: 'roll-bad-00001',
      at: now,
      type: 'putBlogroll',
      id: 'RollBADBADBA',
      name: 'Bell\u0007',
      description: '',
      isPublic: false,
    },
  ]
  const pushed = await push(first)
  expect(pushed.applied).toHaveLength(4)
  expect(pushed.rejected).toEqual([{ mid: 'roll-bad-00001', error: 'invalid_name' }])
  // A replay changes nothing.
  expect((await push(first)).applied).toHaveLength(4)
  expect(
    await db.all(
      sql`select is_public, public_version, public_since is not null as since from blogrolls where id = ${ID}`,
    ),
  ).toEqual([{ is_public: 1, public_version: 1, since: 1 }])

  const snap = await pull(0)
  expect(snap.rows.blogrolls).toMatchObject([
    { id: ID, name: 'On D1', description: 'Two\nlines', isPublic: true, publicVersion: 1 },
  ])
  expect(snap.rows.blogrollBlogs).toMatchObject([
    { blogrollId: ID, feedId: 71, note: 'Hi', removedAt: null },
  ])
  // Its feed and site, though the member subscribes to neither, and no posts.
  expect(snap.rows.feeds.map((f) => f.id)).toEqual([71])
  expect(snap.rows.sites.map((s) => s.id)).toEqual([71])
  expect(snap.rows.subscriptions).toEqual([])

  // A stale show after a hide is refused; a take-out moves the clock; delete wins.
  await push([
    {
      mid: 'roll-hide-0001',
      at: now + 1,
      type: 'setBlogrollPublic',
      id: ID,
      isPublic: false,
      base: 0,
    },
    {
      mid: 'roll-show-0002',
      at: now + 2,
      type: 'setBlogrollPublic',
      id: ID,
      isPublic: true,
      base: 1,
    },
    { mid: 'roll-out-00001', at: now + 3, type: 'unrollBlog', blogrollId: ID, feedId: 72 },
  ])
  const delta = await pull(snap.cursor)
  expect(delta.rows.blogrolls).toMatchObject([{ id: ID, isPublic: false, publicVersion: 2 }])
  expect(delta.rows.blogrollBlogs).toMatchObject([{ feedId: 71, note: 'Hi' }])
  expect(delta.rows.blogrollBlogs[0]?.removedAt).not.toBeNull()
  await push([{ mid: 'roll-del-00001', at: now + 4, type: 'deleteBlogroll', id: ID }])
  const deleted = await pull(delta.cursor)
  expect(deleted.rows.blogrolls[0]?.deletedAt).not.toBeNull()
  const after = await pull(0)
  expect(after.rows.blogrolls).toEqual([])
  expect(after.rows.blogrollBlogs).toEqual([])
  expect(after.rows.feeds).toEqual([])
})
