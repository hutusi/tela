import { describe, expect, test } from 'bun:test'
import { backUp, LATEST_BACKUP } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { memoryBlobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { digest, health, pingDeadman, THRESHOLDS } from '../src/ops'

const NOW = Date.UTC(2026, 8, 28, 12)
const HOUR = 3600_000

async function world() {
  const { db } = await createTestDb()
  const blobs = memoryBlobs()
  await db.run(
    sql`insert into sites (id, home_url, created_at, updated_at) values (1, 'https://a.example', 1, 1)`,
  )
  return { db, blobs }
}

async function feeds(db: Awaited<ReturnType<typeof world>>['db'], n: number, nextFetchAt: number) {
  for (let i = 0; i < n; i++) {
    await db.run(sql`insert into feeds (site_id, feed_url, host, next_fetch_at, created_at, updated_at)
      values (1, ${`https://a.example/${nextFetchAt}/${i}`}, 'a.example', ${nextFetchAt}, 1, 1)`)
  }
}

describe('the health check', () => {
  test('is quiet while work gets done', async () => {
    const { db, blobs } = await world()
    await feeds(db, 10, NOW + HOUR)
    expect(await health(db, blobs, NOW)).toEqual({ ok: true, problems: [] })
  })

  test('speaks up when feeds sit past due, but not for one a fetch is holding', async () => {
    const { db, blobs } = await world()
    await feeds(db, THRESHOLDS.overdueFeeds + 1, NOW - 3 * HOUR)
    expect((await health(db, blobs, NOW)).problems).toEqual([
      '4 feeds are more than two hours past due',
    ])
    await db.run(sql`insert into leases (kind, key, owner, until, attempts, not_before)
      values ('feed.fetch', '1', 'x', ${NOW + 60_000}, 1, 0)`)
    expect((await health(db, blobs, NOW)).ok).toBe(true)
  })

  test('speaks up when a reader waits on a translation, or the backup is old or broken', async () => {
    const { db, blobs } = await world()
    await db.run(sql`insert into body_translations (content_key, lang, state, updated_at)
      values ('k', 'en', 'running', ${NOW - 45 * 60_000})`)
    await blobs.put(
      LATEST_BACKUP,
      JSON.stringify({
        date: '2026-09-26',
        finishedAt: NOW - 50 * HOUR,
        rows: 1,
        verified: false,
        problems: ['x'],
      }),
    )
    expect((await health(db, blobs, NOW)).problems).toEqual([
      '1 body translations have been waiting over 30 minutes',
      'the last backup is from 2026-09-26',
      'the 2026-09-26 backup failed its check',
    ])
  })
})

describe("the dead-man's switch", () => {
  test('hears "ok" while healthy, and /fail with the problems when not', async () => {
    const calls: { url: string; body: string }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) })
      return new Response('OK')
    }) as unknown as typeof fetch
    await pingDeadman('https://hc-ping.com/abc', { ok: true, problems: [] }, fake)
    await pingDeadman('https://hc-ping.com/abc/', { ok: false, problems: ['a', 'b'] }, fake)
    await pingDeadman(undefined, { ok: true, problems: [] }, fake)
    expect(calls).toEqual([
      { url: 'https://hc-ping.com/abc', body: 'ok' },
      { url: 'https://hc-ping.com/abc/fail', body: 'a\nb' },
    ])
  })

  test('a switch that cannot be reached is not an error of ours', async () => {
    const broken = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await pingDeadman('https://hc-ping.com/abc', { ok: true, problems: [] }, broken)
  })
})

describe('the weekly digest', () => {
  test('says what a week of running looked like', async () => {
    const { db, blobs } = await world()
    await feeds(db, 2, NOW + HOUR)
    await db.run(sql`update feeds set error_count = 4, last_error = 'HTTP 503' where id = 1`)
    await db.run(sql`update feeds set timeout_streak = 5 where id = 2`)
    await db.run(
      sql`insert into articles (feed_id, dedup_key, fetched_at, sort_at) values (1, 'a', ${NOW - HOUR}, 1)`,
    )
    await addTestUser(db, 'u')
    await db.run(sql`insert into dead_letters (kind, key, attempts, error, at)
      values ('feed.fetch', '1', 3, 'timeout', ${NOW - HOUR})`)
    await db.run(sql`insert into llm_calls (job, model, input_tokens, output_tokens, latency_ms, created_at)
      values ('translate.title', 'glm-5.2', 1200, 300, 900, ${NOW - HOUR})`)
    await backUp(db, blobs, { date: '2026-09-28', now: () => NOW })

    const mail = await digest(db, blobs, NOW)
    expect(mail.subject).toBe('Tela weekly: 1 new posts, 1 failing feeds, 1 dead letters')
    expect(mail.text).toContain('1 new posts this week')
    expect(mail.text).toContain('4 errors: https://a.example/')
    expect(mail.text).toContain('1 feed.fetch')
    expect(mail.text).toContain('1200 input and 300 output tokens in 1 calls')
    expect(mail.text).toContain('last backup 2026-09-28')
    expect(mail.text).toContain('verified')
    expect(mail.text).toContain('the case for the relay')
    expect(mail.text).toContain('5 timeouts in a row')
  })
})
