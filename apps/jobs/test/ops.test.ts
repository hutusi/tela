import { describe, expect, test } from 'bun:test'
import { backUp, heartbeats, latestBackup } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { memoryBlobs, memoryMail } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { checkHealth, digest, nightly, pingDeadman, weekly } from '../src/ops'

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

describe('the scheduled health check', () => {
  test('keeps its answer as a heartbeat and tells the switch', async () => {
    const { db, blobs } = await world()
    await feeds(db, 4, NOW - 3 * HOUR)
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return new Response('OK')
    }) as unknown as typeof fetch
    const h = await checkHealth(db, blobs, NOW, 'https://hc-ping.com/abc', fake)
    expect(h.ok).toBe(false)
    expect(calls).toEqual(['https://hc-ping.com/abc/fail'])
    expect(await heartbeats(db)).toMatchObject({
      health: {
        at: NOW,
        info: { ok: false, problems: ['4 feeds are more than two hours past due'] },
      },
    })
  })
})

describe('the nightly run', () => {
  test('sweeps, exports, and says so in its heartbeat', async () => {
    const { db, blobs } = await world()
    const run = await nightly(db, blobs, () => NOW)
    expect(run.backup).toMatchObject({ date: '2026-09-28', verified: true })
    const beat = (await heartbeats(db)).daily
    expect(beat?.at).toBe(NOW)
    expect(beat?.info).toMatchObject({
      revived: 0,
      backup: { date: '2026-09-28', verified: true },
      pruned: 0,
    })
    expect((await latestBackup(blobs))?.date).toBe('2026-09-28')
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
    expect(mail.text).toContain('0 of them resolved in the admin console')
    expect(mail.text).toContain('1200 input and 300 output tokens in 1 calls')
    expect(mail.text).toContain('last backup 2026-09-28')
    expect(mail.text).toContain('verified')
    expect(mail.text).toContain('the case for the relay')
    expect(mail.text).toContain('5 timeouts in a row')
    expect(mail.text).toContain('no blog members added waits for review')
  })

  test('counts the blogs members added that wait for review, with the way to them', async () => {
    const { db, blobs } = await world()
    await feeds(db, 1, NOW + HOUR)
    // Site 1 is read and has a post; site 2 was judged not for Discover already.
    await db.run(sql`update sites set reader_count = 1 where id = 1`)
    await db.run(sql`insert into sites (id, home_url, reader_count, review, reviewed_at,
      created_at, updated_at) values (2, 'https://b.example', 2, 'dismissed', ${NOW - HOUR}, 1, 1)`)
    await db.run(sql`insert into feeds (site_id, feed_url, host, next_fetch_at, created_at,
      updated_at) values (2, 'https://b.example/feed', 'b.example', ${NOW + HOUR}, 1, 1)`)
    await db.run(sql`insert into articles (feed_id, dedup_key, fetched_at, sort_at)
      select id, 'a', ${NOW - HOUR}, 1 from feeds`)
    const mail = await digest(db, blobs, NOW, 'https://tela.example/')
    expect(mail.text).toContain(
      'Discover\n  1 blogs members added wait for review: https://tela.example/admin/discover',
    )
  })
})

describe('the weekly run', () => {
  test('counts the dead letters an operator resolved, and leaves a heartbeat once sent', async () => {
    const { db, blobs } = await world()
    for (const resolved of [null, NOW - HOUR]) {
      await db.run(sql`insert into dead_letters (kind, key, attempts, error, at, resolved_at, resolution)
        values ('site.assets', '1', 3, 'x', ${NOW - 2 * HOUR}, ${resolved},
          ${resolved === null ? null : 'dismissed'})`)
    }
    const mail = memoryMail()
    const sent = await weekly(db, blobs, NOW, { mail, to: 'owner@x.test' })
    expect(sent.sent).toBe(true)
    expect(sent.text).toContain('2 site.assets')
    expect(sent.text).toContain('1 of them resolved in the admin console')
    expect(mail.outbox.map((m) => m.to)).toEqual(['owner@x.test'])
    expect((await heartbeats(db)).digest).toEqual({
      at: NOW,
      info: { sent: true, subject: sent.subject },
    })
  })

  test('a send that fails leaves the last heartbeat as it was', async () => {
    const { db, blobs } = await world()
    const broken = {
      send: async () => {
        throw new Error('resend is down')
      },
    }
    await expect(weekly(db, blobs, NOW, { mail: broken, to: 'owner@x.test' })).rejects.toThrow()
    expect((await heartbeats(db)).digest).toBeUndefined()
  })
})
