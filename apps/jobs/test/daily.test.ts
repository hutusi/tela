import { describe, expect, test } from 'bun:test'
import { createOperatorCode, first, holdJoin, inviteAddress } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { type SQL, sql } from 'drizzle-orm'
import { daily } from '../src/daily'

const NOW = Date.UTC(2026, 8, 20, 3, 17)
const DAY = 24 * 3600 * 1000

describe('daily', () => {
  test('re-probes week-old relay feeds, revives week-dead feeds, prunes, and compacts', async () => {
    const { db } = await createTestDb()
    await db.run(
      sql`insert into sites (home_url, created_at, updated_at) values ('https://a.example', 1, 1)`,
    )
    await db.run(sql`
      insert into feeds (site_id, feed_url, host, next_fetch_at, created_at, updated_at, fetch_region, region_flipped_at, status, last_fetched_at, error_count)
      values
        (1, 'https://a.example/relay-old', 'a.example', 0, 1, 1, 'cn', ${NOW - 8 * DAY}, 'active', ${NOW}, 0),
        (1, 'https://a.example/relay-new', 'a.example', 0, 1, 1, 'cn', ${NOW - 2 * DAY}, 'active', ${NOW}, 0),
        (1, 'https://a.example/dead-old', 'a.example', 0, 1, 1, 'global', null, 'dead', ${NOW - 8 * DAY}, 30),
        (1, 'https://a.example/dead-new', 'a.example', 0, 1, 1, 'global', null, 'dead', ${NOW - DAY}, 30)
    `)
    await addTestUser(db, 'u')
    await db.run(sql`
      insert into articles (feed_id, dedup_key, fetched_at, sort_at) values
        (1, 'g:1', 1, 1), (1, 'g:2', 1, 1), (1, 'g:3', 1, 1), (1, 'g:4', 1, 1)
    `)
    await db.run(
      sql`insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at) values ('u', 1, 3, 1, 1)`,
    )
    await db.run(sql`
      insert into user_article_states (user_id, article_id, read_at, liked_at, liked_updated_at) values
        ('u', 1, 5, null, null), ('u', 2, 5, 9, 9), ('u', 3, 5, null, 8), ('u', 4, 5, null, null)
    `)
    await db.run(
      sql`insert into action_limits (key, window_start, count) values ('old', ${NOW - 2 * DAY}, 1), ('new', ${NOW}, 1)`,
    )
    await db.run(
      sql`insert into applied_mutations (user_id, mid, applied_at) values ('u', 'old', ${NOW - 40 * DAY}), ('u', 'new', ${NOW})`,
    )

    expect(await daily(db, NOW)).toEqual({
      reprobed: 1,
      revived: 1,
      prunedRateLimits: 1,
      prunedMutations: 1,
      compacted: 1,
      prunedHolds: 0,
      prunedSessions: 0,
      prunedAuthLimits: 0,
      prunedVerifications: 0,
    })
    const feeds = await db.all<{
      feed_url: string
      fetch_region: string
      status: string
      error_count: number
    }>(sql`select feed_url, fetch_region, status, error_count from feeds order by id`)
    expect(feeds.map((f) => [f.fetch_region, f.status])).toEqual([
      ['global', 'active'],
      ['cn', 'active'],
      ['global', 'active'],
      ['global', 'dead'],
    ])
    expect(feeds[2]?.error_count).toBe(25)
    // Article 1 is read and under the watermark: its row goes. 2 is liked; 3 was liked and then
    // unliked, and a like made earlier on another device is still to be compared with when that
    // was; 4 is above the watermark.
    const states = await db.all<{ article_id: number }>(
      sql`select article_id from user_article_states order by article_id`,
    )
    expect(states.map((s) => s.article_id)).toEqual([2, 3, 4])
    expect(await first(db, sql`select 1 as x from action_limits where key = 'old'`)).toBeUndefined()
  })

  test('prunes what has no further use: lapsed holds, ended sessions, old counters, spent codes', async () => {
    const { db } = await createTestDb()
    await addTestUser(db, 'u')
    await createOperatorCode(db, { code: 'WELCOME', maxUses: 5, now: NOW - 3 * DAY })
    // Held three days ago, a day past its expiry, like the operator's invitation of two days ago;
    // held yesterday, lapsed but still within the day after.
    await holdJoin(db, { code: 'WELCOME', email: 'old@x.test', now: NOW - 3 * DAY })
    await holdJoin(db, { code: 'WELCOME', email: 'recent@x.test', now: NOW - DAY })
    await inviteAddress(db, { email: 'op@x.test', now: NOW - 2 * DAY })
    await db.run(sql`
      insert into session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
      values ('ended', ${NOW - 1}, 't1', 0, 0, '192.0.2.1', 'ua', 'u'),
        ('live', ${NOW + DAY}, 't2', 0, 0, '192.0.2.1', 'ua', 'u')
    `)
    await db.run(sql`
      insert into rate_limit (id, key, count, last_request)
      values ('a', '192.0.2.1/sign-in', 3, ${NOW - DAY - 1}), ('b', '192.0.2.2/sign-in', 1, ${NOW - 1})
    `)
    await db.run(sql`
      insert into verification (id, identifier, value, expires_at, created_at, updated_at)
      values ('spent', 'sign-in-otp-a@x.test', '123456:0', ${NOW - 1}, 0, 0),
        ('fresh', 'sign-in-otp-b@x.test', '654321:0', ${NOW + 60_000}, 0, 0)
    `)

    expect(await daily(db, NOW)).toMatchObject({
      prunedHolds: 2,
      prunedSessions: 1,
      prunedAuthLimits: 1,
      prunedVerifications: 1,
    })
    const left = async (query: SQL) => (await db.all<{ k: string }>(query)).map((r) => r.k)
    expect(await left(sql`select email as k from invite_redemptions`)).toEqual(['recent@x.test'])
    expect(await left(sql`select id as k from session`)).toEqual(['live'])
    expect(await left(sql`select id as k from rate_limit`)).toEqual(['b'])
    expect(await left(sql`select id as k from verification`)).toEqual(['fresh'])
  })
})
