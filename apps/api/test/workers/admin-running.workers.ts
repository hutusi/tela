/**
 * The admin console's running areas on D1 (ADR 0039): their reads lean on what the bun suite's
 * libSQL could take differently (window functions for the median, `json_group_array(distinct …)`,
 * integer division into UTC days, `json_each` lookups), and a retry's batch opens with the fence.
 */
import { env } from 'cloudflare:test'
import { bumpSeq, currentSeq, type JobQueues, schema } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'
import { type Blobs, type Jobs, memoryMail } from '@tela/platform'
import { d1Db } from '@tela/platform/cloudflare'
import type {
  AdminList,
  AdminOverview,
  AdminSystemReport,
  AdminSystemRow,
  AdminTranslationReport,
  AdminTranslationRow,
} from '@tela/shared/admin'
import { CLIENT_HEADER, MEMBER_HEADER, MIN_CLIENT } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createApp } from '../../src/app'

const ORIGIN = 'http://tela.test'
const unused = () => {
  throw new Error('not used here')
}

it('reads the running areas and retries a dead letter on D1', async () => {
  const db = d1Db(env.DB, schema)
  const mail = memoryMail()
  const jobs: Jobs<JobQueues> = { send: async () => {}, sendBatch: async () => {} }
  const now = Date.now()
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
  expect(
    (
      await call('/api/admin/admins', {
        body: { email: 'ops@x.test', admin: true },
        headers: operator,
      })
    ).status,
  ).toBe(200)
  const as = { cookie, [MEMBER_HEADER]: me.id }
  const get = async <T>(path: string) => {
    const res = await call(`/api/v1/admin/${path}`, { headers: as })
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }

  const DAY = 86_400_000
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, title, created_at, updated_at, seq)
      values (1, 'https://a.example', 'A', 0, 0, ${currentSeq})`),
    db.run(sql`insert into site_topics (site_id, topic) values (1, 'tech')`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, error_count,
        created_at, updated_at, seq)
      values (1, 1, 'https://a.example/feed', 'a.example', ${now + DAY}, 2, ${now}, 0,
        ${currentSeq})`),
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at,
        content_key, seq)
      values (1, 1, 'a', 'Post', 0, 0, 'ck', ${currentSeq})`),
    db.run(sql`insert into llm_calls (job, model, feed_id, target_lang, input_tokens,
        output_tokens, latency_ms, created_at)
      values ('translate.title', 'glm', 1, 'fr', 10, 5, 100, ${now - DAY}),
        ('translate.title', 'glm', 1, 'fr', 10, 5, 300, ${now}),
        ('translate.body', 'glm', 1, 'zh-Hans', 100, 50, 900, ${now}),
        ('translate.title', 'glm', null, 'en', 1, 1, 50, ${now})`),
    db.run(sql`insert into dead_letters (id, kind, key, attempts, error, at)
      values (1, 'feed.fetch', '1', 5, 'boom', ${now}), (2, 'translate.body', 'ck:fr', 3, 'x', ${now})`),
    db.run(sql`insert into leases (kind, key, owner, until, attempts, not_before)
      values ('translate.body', 'ck:en', 'x', 0, 1, ${now + DAY})`),
  ])

  const overview = await get<AdminOverview>('overview')
  expect(overview.queues.dead.rows.map((r) => r.target?.label)).toEqual([
    'https://a.example/feed',
    'https://a.example/feed',
  ])
  expect(overview.queues.candidates.rows[0]).toMatchObject({
    topics: ['tech'],
    feedHealth: 'failing',
  })
  expect(overview.week.tokens[0]).toBe(182)

  const blogs = await get<AdminList<AdminTranslationRow, 'translation'>>('translation?f=blogs')
  expect(blogs.rows).toMatchObject([
    { id: '1', targets: ['fr', 'zh-Hans'], calls: 3, medianLatencyMs: 300 },
  ])
  const report = await get<AdminTranslationReport>('translation/report')
  expect(report.days.at(-1)).toMatchObject({ title: 17, body: 150 })
  expect(report.unattributed).toBe(2)

  const retrying = await get<AdminList<AdminSystemRow, 'system'>>('system?f=retrying')
  expect(retrying.rows).toMatchObject([{ id: 'lease:translate.body:ck:en', target: { id: '1' } }])
  const system = await get<AdminSystemReport>('system/report')
  expect(system.kinds.find((k) => k.kind === 'translate.body')).toMatchObject({ retrying: 1 })

  const retried = await call('/api/v1/admin/act', {
    body: { action: 'dead.retry', ids: ['dead:1', 'dead:1x'] },
    headers: as,
  })
  expect(await retried.json()).toMatchObject({ done: ['dead:1'] })
  const again = await call('/api/v1/admin/act', {
    body: { action: 'dead.retry', ids: ['dead:1'] },
    headers: as,
  })
  expect(await again.json()).toMatchObject({ failed: [{ id: 'dead:1', error: 'not_applicable' }] })
  expect(await db.all(sql`select next_fetch_at = ${now} as due from feeds where id = 1`)).toEqual([
    { due: 1 },
  ])
})
