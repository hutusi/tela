import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, first, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { createTestApi, type TestApi } from './helpers'

let api: TestApi
let db: TelaDb
const SECRET = 'hub-secret-for-tests'

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, created_at, updated_at, seq)
      values (1, 'https://blog.example', 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, last_fetched_at, created_at, updated_at, seq)
      values (1, 1, 'https://blog.example/feed', 'blog.example', ${api.clock.now() + 3_600_000}, 1, 0, 0, ${currentSeq})`),
    db.run(sql`insert into websub_subscriptions (feed_id, hub_url, topic_url, secret, status, updated_at)
      values (1, 'https://hub.example', 'https://blog.example/feed', ${SECRET}, 'pending', 0)`),
  ] as never)
})

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

const verify = (topic: string) =>
  api.app.request(
    `http://tela.test/api/websub/1?hub.mode=subscribe&hub.topic=${encodeURIComponent(topic)}&hub.challenge=abc123&hub.lease_seconds=600`,
  )
const ping = async (body: string, signature: string | null) =>
  api.app.request('http://tela.test/api/websub/1', {
    method: 'POST',
    headers: signature ? { 'x-hub-signature': signature } : {},
    body,
  })

describe('WebSub callback', () => {
  test('echoes the challenge for the subscription Tela asked for, and nothing else', async () => {
    expect((await verify('https://evil.example/feed')).status).toBe(404)
    const res = await verify('https://blog.example/feed')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc123')
    const row = await first<{ status: string; lease_until: number }>(
      db,
      sql`select status, lease_until from websub_subscriptions`,
    )
    expect(row).toEqual({ status: 'active', lease_until: api.clock.now() + 600_000 })
  })

  test('a signed ping marks the feed for a refetch and sends it now', async () => {
    await verify('https://blog.example/feed')
    const res = await ping('<rss/>', await sign('<rss/>'))
    expect(res.status).toBe(204)
    const feed = await first<{ refetch_requested_at: number }>(
      db,
      sql`select refetch_requested_at from feeds where id = 1`,
    )
    expect(feed?.refetch_requested_at).toBe(api.clock.now())
    expect(api.jobs.sent).toMatchObject([
      { queue: 'fetch', body: { kind: 'feed.fetch', key: '1' } },
    ])
  })

  test('refuses a bad signature, and pings for a subscription not yet verified', async () => {
    expect((await ping('<rss/>', await sign('<rss/>'))).status).toBe(404) // still pending
    await verify('https://blog.example/feed')
    expect((await ping('<rss/>', await sign('<rss/>', 'wrong'))).status).toBe(403)
    expect((await ping('<rss/>', null)).status).toBe(403)
    expect(api.jobs.sent).toEqual([])
  })
})
