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
    id: string
    profile: { handle: string }
  }
  expect(me.profile.handle).toMatch(/^u_[0-9a-f]{10}$/)
  // Every other member call names the member, as the reader does from what /me told it.
  const member = { cookie, headers: { [MEMBER_HEADER]: me.id } }

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
    // Someone to follow (ADR 0031).
    db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
      values ('workers-anna-00001', 'Anna', 'anna@x.test', 1, 0, 0)`),
    db.run(sql`insert into profiles (user_id, handle, display_name, created_at, updated_at, seq)
      values ('workers-anna-00001', 'anna', 'Anna', 0, 0, ${currentSeq})`),
  ])

  // A guarded push, then its replay.
  const push = {
    mutations: [
      { mid: 'workers-sub-1', at: now, type: 'subscribe', feedId: 1 },
      { mid: 'workers-like-1', at: now, type: 'setLiked', articleId: 1, liked: true },
      { mid: 'workers-missing', at: now, type: 'markRead', articleId: 999 },
      // A highlight writes a column named `end`, which D1 takes only quoted.
      {
        mid: 'workers-highlight-1',
        at: now,
        type: 'putHighlight',
        id: 'workers-hl-1',
        articleId: 1,
        contentKey: 'a'.repeat(32),
        side: 'original',
        lang: null,
        leafId: 'leaf000001',
        start: 0,
        end: 4,
        quote: 'Post',
        prefix: '',
        suffix: '',
        note: 'on D1',
      },
      // A follow is an insert-select upsert, its pull a join paged by max() of two seqs.
      { mid: 'workers-follow-1', at: now, type: 'follow', userId: 'workers-anna-00001' },
      { mid: 'workers-flags-1', at: now, type: 'setPrivacy', publicLikes: true },
      // An unfollow of someone never followed is a tombstone upsert through their profile.
      { mid: 'workers-unfollow-1', at: now, type: 'unfollow', userId: 'workers-nobody-0001' },
    ],
  }
  const pushed = (await (
    await call('/api/v1/mutations', { body: push, ...member })
  ).json()) as PushResponse
  expect(pushed.applied).toHaveLength(7)
  const again = (await (
    await call('/api/v1/mutations', { body: push, ...member })
  ).json()) as PushResponse
  expect(again.applied).toHaveLength(7)
  const likes = await db.all<{ like_count: number }>(
    sql`select like_count from articles where id = 1`,
  )
  expect(likes).toEqual([{ like_count: 1 }])

  // A snapshot pull, then an empty delta.
  const snap = (await (await call('/api/v1/sync?cursor=0', member)).json()) as PullResponse
  expect(snap.rows.articles.map((a) => a.id)).toEqual([1])
  expect(snap.rows.states).toMatchObject([{ articleId: 1, likedAt: now }])
  expect(snap.rows.subscriptions).toMatchObject([{ feedId: 1 }])
  expect(snap.rows.highlights).toMatchObject([{ id: 'workers-hl-1', end: 4, note: 'on D1' }])
  expect(snap.rows.follows).toMatchObject([{ userId: 'workers-anna-00001', handle: 'anna' }])
  expect(snap.rows.profile).toMatchObject([{ publicLikes: true }])
  const delta = (await (
    await call(`/api/v1/sync?cursor=${snap.cursor}`, member)
  ).json()) as PullResponse
  expect(delta.rows.articles).toEqual([])
  expect(delta.more).toBe(false)
  // A rename sends the follow again, in a delta.
  await db.batch([
    bumpSeq(db),
    db.run(sql`update profiles set handle = 'anna_k', seq = ${currentSeq}
      where user_id = 'workers-anna-00001'`),
  ])
  const renamed = (await (
    await call(`/api/v1/sync?cursor=${delta.cursor}`, member)
  ).json()) as PullResponse
  expect(renamed.rows.follows).toMatchObject([{ handle: 'anna_k' }])

  // The Following feed: printf keys, nested window functions and the (time, key) cursor, on D1.
  await db.batch([
    bumpSeq(db),
    db.run(
      sql`update profiles set public_likes = 1, seq = ${currentSeq} where user_id = 'workers-anna-00001'`,
    ),
    db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at, seq)
      values ('workers-anna-00001', 1, 'on D1', ${now - 2000}, ${now - 2000}, ${currentSeq})`),
    db.run(sql`insert into user_article_states (user_id, article_id, read_at, liked_at, liked_updated_at, seq)
      values ('workers-anna-00001', 1, ${now - 1000}, ${now - 1000}, ${now - 1000}, ${currentSeq})`),
  ])
  const feed = (await (await call('/api/v1/following?tz=480', member)).json()) as {
    items: { kind: string; key: string }[]
    next: string | null
  }
  expect(feed.items.map((i) => i.kind)).toEqual(['liked', 'recommended'])
  expect(feed.items[1]?.key).toMatch(/^r:\d{12}$/)
  const older = (await (
    await call(
      // The offset the first page grouped under rides in the cursor, so the day keys agree.
      `/api/v1/following?cursor=${encodeURIComponent(`${now - 1000}:480:${feed.items[0]?.key}`)}`,
      member,
    )
  ).json()) as { items: { kind: string }[] }
  expect(older.items.map((i) => i.kind)).toEqual(['recommended'])
})
