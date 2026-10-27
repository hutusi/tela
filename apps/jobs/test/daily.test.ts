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
      prunedOpens: 0,
      prunedAppCodes: 0,
      prunedAppTokens: 0,
      prunedSpentRefresh: 0,
      prunedAppGrants: 0,
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

  test('keeps two days of posts opened from blogs a member does not follow (ADR 0066)', async () => {
    const { db } = await createTestDb()
    await addTestUser(db, 'u')
    const key = 'a'.repeat(32)
    await db.run(sql`
      insert into post_opens (user_id, day, content_key, opened_at) values
        ('u', '2026-09-17', ${key}, 0), ('u', '2026-09-18', ${key}, 0),
        ('u', '2026-09-19', ${key}, 0), ('u', '2026-09-20', ${key}, 0)
    `)
    expect((await daily(db, NOW)).prunedOpens).toBe(2)
    const days = await db.all<{ day: string }>(sql`select day from post_opens order by day`)
    expect(days.map((r) => r.day)).toEqual(['2026-09-19', '2026-09-20'])
  })

  test("clears apps' credentials past any use (ADR 0064)", async () => {
    const { db } = await createTestDb()
    await addTestUser(db, 'u')
    await db.batch([
      db.run(sql`insert into apps (id, client_id, name, developer, contact_email, created_at, updated_at)
        values (1, 'tela_app_x', 'App', 'Dev', 'dev@example.com', 0, 0)`),
      db.run(sql`insert into app_grants (id, app_id, user_id, scope, created_at, updated_at)
        values (1, 1, 'u', 'read', 0, 0)`),
      // Ended five weeks ago, ended yesterday, live.
      db.run(sql`insert into app_tokens (id, grant_id, scope, access_hash, access_expires_at, created_at, ended_at)
        values (1, 1, 'read', 'a1', 0, 0, ${NOW - 35 * DAY}), (2, 1, 'read', 'a2', 0, 0, ${NOW - DAY}),
          (3, 1, 'read', 'a3', ${NOW + DAY}, 0, null)`),
      // Token 1's goes with it; on the live token, one past the idle limit and one recent.
      db.run(sql`insert into app_refresh_spent (hash, token_id, replaced_at)
        values ('s1', 1, ${NOW - 35 * DAY}), ('s3old', 3, ${NOW - 100 * DAY}), ('s3', 3, ${NOW - DAY})`),
      db.run(sql`insert into app_codes (hash, app_id, user_id, scope, created_at, expires_at)
        values ('c-old', 1, 'u', 'read', 0, ${NOW - 1}), ('c-new', 1, 'u', 'read', 0, ${NOW + 60_000})`),
    ] as never)
    const report = await daily(db, NOW)
    expect([report.prunedAppCodes, report.prunedAppTokens, report.prunedSpentRefresh]).toEqual([
      1, 1, 1,
    ])
    const ids = async (q: ReturnType<typeof sql>) =>
      (await db.all<{ k: unknown }>(q)).map((r) => r.k)
    expect(await ids(sql`select id as k from app_tokens order by id`)).toEqual([2, 3])
    expect(await ids(sql`select hash as k from app_refresh_spent order by hash`)).toEqual(['s3'])
    expect(await ids(sql`select hash as k from app_codes`)).toEqual(['c-new'])
  })

  test('clears tokens no one can use again, and a connection’s record a month after it ended', async () => {
    const { db } = await createTestDb()
    await addTestUser(db, 'u')
    const past = (days: number) => NOW - days * DAY
    await db.batch([
      db.run(sql`insert into apps (id, client_id, name, developer, contact_email, created_at, updated_at)
        values (1, 'tela_app_x', 'App', 'Dev', 'dev@example.com', 0, 0)`),
      // Live; ended five weeks ago; ended a week ago.
      db.run(sql`insert into app_grants (id, app_id, user_id, scope, created_at, updated_at, ended_at,
          end_reason)
        values (1, 1, 'u', 'read', 0, 0, null, null), (2, 1, 'u', 'read', 0, 0, ${past(35)}, 'revoked'),
          (3, 1, 'u', 'read', 0, 0, ${past(7)}, 'revoked')`),
      // Never ended, on the live connection: an access token and a refresh token both a month and
      // more past use (1); one whose refresh token still swaps (2); one with no refresh token, its
      // access token a month past (3); one whose refresh token lapsed only a week ago (4).
      db.run(sql`insert into app_tokens (id, grant_id, scope, access_hash, access_expires_at,
          refresh_hash, refresh_idle_expires_at, created_at)
        values (1, 1, 'read', 'a1', ${past(120)}, 'r1', ${past(31)}, 0),
          (2, 1, 'read', 'a2', ${past(120)}, 'r2', ${NOW + DAY}, 0),
          (3, 1, 'read', 'a3', ${past(31)}, null, null, 0),
          (4, 1, 'read', 'a4', ${past(120)}, 'r4', ${past(7)}, 0)`),
      db.run(sql`insert into app_refresh_spent (hash, token_id, replaced_at)
        values ('s1', 1, ${past(1)})`),
    ] as never)
    const report = await daily(db, NOW)
    expect([report.prunedAppTokens, report.prunedAppGrants]).toEqual([2, 1])
    const ids = async (q: SQL) => (await db.all<{ k: unknown }>(q)).map((r) => r.k)
    expect(await ids(sql`select id as k from app_tokens order by id`)).toEqual([2, 4])
    expect(await ids(sql`select hash as k from app_refresh_spent`)).toEqual([])
    expect(await ids(sql`select id as k from app_grants order by id`)).toEqual([1, 3])
  })

  test('counts the rate counters it prunes, however many there are', async () => {
    const { db } = await createTestDb()
    await db.run(sql`
      insert into action_limits (key, window_start, count)
      select 'app:' || value, ${NOW - 2 * DAY}, 1 from json_each(${JSON.stringify(
        Array.from({ length: 300 }, (_, i) => i),
      )}) where true
    `)
    expect((await daily(db, NOW)).prunedRateLimits).toBe(300)
    expect(await first(db, sql`select 1 as x from action_limits`)).toBeUndefined()
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
