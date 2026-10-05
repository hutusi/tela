import { describe, expect, test } from 'bun:test'
import { memoryBlobs } from '@tela/platform/portable'
import { HEALTH_CHECKS } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { LATEST_BACKUP } from './backup'
import { HEARTBEATS, health, heartbeat, heartbeats, THRESHOLDS } from './health'
import { createTestDb } from './testing'

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

async function deadLetters(db: Awaited<ReturnType<typeof world>>['db'], n: number, at: number) {
  for (let i = 0; i < n; i++) {
    await db.run(sql`insert into dead_letters (kind, key, attempts, error, at)
      values ('feed.fetch', ${String(i)}, 5, 'boom', ${at})`)
  }
}

describe('the health check', () => {
  test('is quiet while work gets done, and says so question by question', async () => {
    const { db, blobs } = await world()
    await feeds(db, 10, NOW + HOUR)
    const h = await health(db, blobs, NOW)
    expect(h.ok).toBe(true)
    expect(h.problems).toEqual([])
    expect(h.checks.map((c) => c.name)).toEqual([...HEALTH_CHECKS])
    expect(h.checks.every((c) => c.ok)).toBe(true)
    // No backup yet is a new deployment: nothing to measure, nothing wrong.
    expect(h.checks.find((c) => c.name === 'backupAge')).toEqual({
      name: 'backupAge',
      value: null,
      limit: THRESHOLDS.backupAgeHours,
      ok: true,
    })
  })

  test('speaks up when feeds sit past due, but not for one a fetch is holding', async () => {
    const { db, blobs } = await world()
    await feeds(db, THRESHOLDS.overdueFeeds + 1, NOW - 3 * HOUR)
    const h = await health(db, blobs, NOW)
    expect(h.problems).toEqual(['4 feeds are more than two hours past due'])
    expect(h.checks[0]).toEqual({ name: 'overdueFeeds', value: 4, limit: 3, ok: false })
    await db.run(sql`insert into leases (kind, key, owner, until, attempts, not_before)
      values ('feed.fetch', '1', 'x', ${NOW + 60_000}, 1, 0)`)
    expect((await health(db, blobs, NOW)).ok).toBe(true)
  })

  test("counts the pages waiting for the sweep, never a paused or dead feed's", async () => {
    const { db, blobs } = await world()
    await feeds(db, 2, NOW + HOUR)
    const n = THRESHOLDS.extractionBacklog + 1
    for (let i = 0; i < n; i++) {
      await db.run(sql`insert into articles (feed_id, dedup_key, url, title, fetched_at, sort_at,
          extract_state)
        values (1, ${`k${i}`}, ${`https://a.example/${i}`}, 't', ${NOW - 7 * HOUR}, 0, 'due')`)
    }
    expect((await health(db, blobs, NOW)).problems).toEqual([
      `${n} articles have waited over six hours for their full text`,
    ])
    // Paused by an operator (a writer asked to leave): the sweep will not take them, nor wait.
    await db.run(sql`update feeds set status = 'paused' where id = 1`)
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
    const h = await health(db, blobs, NOW)
    expect(h.problems).toEqual([
      '1 body translations have been waiting over 30 minutes',
      'the last backup is from 2026-09-26',
      'the 2026-09-26 backup failed its check',
    ])
    expect(h.checks.filter((c) => !c.ok)).toEqual([
      { name: 'stuckBodies', value: 1, limit: 0, ok: false },
      { name: 'backupAge', value: 50, limit: 36, ok: false },
      { name: 'backupVerified', value: 0, limit: null, ok: false },
    ])
  })

  test('counts only the dead letters nobody has resolved', async () => {
    const { db, blobs } = await world()
    await deadLetters(db, THRESHOLDS.deadLettersPerDay + 1, NOW - HOUR)
    // Yesterday's are not today's burst.
    await deadLetters(db, 5, NOW - 25 * HOUR)
    const before = await health(db, blobs, NOW)
    expect(before.problems).toEqual(['21 jobs were dead-lettered in the last day'])
    expect(before.checks[1]).toEqual({ name: 'deadLetters', value: 21, limit: 20, ok: false })

    await db.run(sql`
      update dead_letters set resolved_at = ${NOW}, resolution = 'dismissed'
      where id = (select min(id) from dead_letters)
    `)
    const after = await health(db, blobs, NOW)
    expect(after.ok).toBe(true)
    expect(after.checks[1]).toEqual({ name: 'deadLetters', value: 20, limit: 20, ok: true })
  })
})

describe('heartbeats', () => {
  test('keep the latest of each run, with what it reported', async () => {
    const { db } = await createTestDb()
    expect(await heartbeats(db)).toEqual({})
    await heartbeat(db, 'tick', 1, { 'feed.fetch': 2 })
    await heartbeat(db, 'tick', 2, { 'feed.fetch': 3 })
    await heartbeat(db, 'daily', 5, { revived: 1 })
    const beats = await heartbeats(db)
    expect(beats).toEqual({
      tick: { at: 2, info: { 'feed.fetch': 3 } },
      daily: { at: 5, info: { revived: 1 } },
    })
    expect(HEARTBEATS).toContain('health')
  })
})
