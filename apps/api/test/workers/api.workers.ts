import { env } from 'cloudflare:test'
import { bumpSeq, currentSeq, type JobQueues, schema } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'
import { type Blobs, type Jobs, memoryMail } from '@tela/platform'
import { d1Db } from '@tela/platform/cloudflare'
import { CLIENT_HEADER, MIN_CLIENT, type PullResponse, type PushResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createApp } from '../../src/app'

const ORIGIN = 'http://tela.test'
const unused = () => {
  throw new Error('not used here')
}

it('invites, signs in, pushes and pulls on D1', async () => {
  const db = d1Db(env.DB, schema)
  const mail = memoryMail()
  const sent: unknown[] = []
  const jobs: Jobs<JobQueues> = {
    send: async (_q, body) => void sent.push(body),
    sendBatch: async (_q, messages) => void sent.push(...messages),
  }
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
    clock: { now: () => Date.now() },
    mail,
    ingest: {} as Ingest,
    config: {
      publicUrl: ORIGIN,
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

  // Sign-in through better-auth's Drizzle adapter, on D1.
  const invited = await call('/api/admin/invite', {
    body: { email: 'reader@x.test' },
    headers: { authorization: 'Bearer admin' },
  })
  expect(invited.status).toBe(200)
  const code = mail.outbox.at(-1)?.text.match(/^\d{6}$/m)?.[0]
  expect(code).toMatch(/^\d{6}$/)
  const signIn = await call('/api/auth/sign-in/email-otp', {
    body: { email: 'reader@x.test', otp: code },
  })
  expect(signIn.status).toBe(200)
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const me = (await (await call('/api/v1/me', { cookie })).json()) as {
    profile: { handle: string }
  }
  expect(me.profile.handle).toMatch(/^u_[0-9a-f]{10}$/)

  // A feed with an article, written the way every writer of synced rows writes.
  const now = Date.now()
  await db.batch([
    bumpSeq(db),
    db.run(
      sql`insert into sites (id, home_url, created_at, updated_at, seq) values (1, 'https://b.example', 0, 0, ${currentSeq})`,
    ),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (1, 1, 'https://b.example/feed', 'b.example', 0, 0, 0, ${currentSeq})`),
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, seq)
      values (1, 1, 'k1', 'Post', ${now}, ${now}, ${currentSeq})`),
  ])

  // A guarded push, then its replay.
  const push = {
    mutations: [
      { mid: 'workers-sub-1', at: now, type: 'subscribe', feedId: 1 },
      { mid: 'workers-like-1', at: now, type: 'setLiked', articleId: 1, liked: true },
      { mid: 'workers-missing', at: now, type: 'markRead', articleId: 999 },
    ],
  }
  const pushed = (await (
    await call('/api/v1/mutations', { body: push, cookie })
  ).json()) as PushResponse
  expect(pushed.applied).toHaveLength(3)
  const again = (await (
    await call('/api/v1/mutations', { body: push, cookie })
  ).json()) as PushResponse
  expect(again.applied).toHaveLength(3)
  const likes = await db.all<{ like_count: number }>(
    sql`select like_count from articles where id = 1`,
  )
  expect(likes).toEqual([{ like_count: 1 }])

  // A snapshot pull, then an empty delta.
  const snap = (await (await call('/api/v1/sync?cursor=0', { cookie })).json()) as PullResponse
  expect(snap.rows.articles.map((a) => a.id)).toEqual([1])
  expect(snap.rows.states).toMatchObject([{ articleId: 1, likedAt: now }])
  expect(snap.rows.subscriptions).toMatchObject([{ feedId: 1 }])
  const delta = (await (
    await call(`/api/v1/sync?cursor=${snap.cursor}`, { cookie })
  ).json()) as PullResponse
  expect(delta.rows.articles).toEqual([])
  expect(delta.more).toBe(false)
})
