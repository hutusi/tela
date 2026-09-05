import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { consumeRateLimit, pruneRateLimits, RATE_LIMITS } from '../src/queries'
import { resetDatabase, startTestDb, type TestDb } from '../src/testing'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)
afterAll(async () => {
  await t?.stop()
})
beforeEach(async () => {
  await resetDatabase(t.db)
})

describe('consumeRateLimit', () => {
  test('allows up to the limit per window, then refuses until the window ends', async () => {
    const now = new Date('2026-09-04T10:15:00Z')
    const rule = RATE_LIMITS.opmlImport
    for (let i = 1; i <= rule.limit; i++) {
      const r = await consumeRateLimit(t.db, 'opmlImport', 'user-a', now)
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBe(rule.limit - i)
    }
    const denied = await consumeRateLimit(t.db, 'opmlImport', 'user-a', now)
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterSec: 45 * 60 })

    // Other subjects and other actions have their own counters.
    expect((await consumeRateLimit(t.db, 'opmlImport', 'user-b', now)).allowed).toBe(true)
    expect((await consumeRateLimit(t.db, 'discover', 'user-a', now)).allowed).toBe(true)
    expect(await consumeRateLimit(t.db, 'translate', 'user-a', now)).toMatchObject({
      allowed: true,
      remaining: RATE_LIMITS.translate.limit - 1,
    })

    // The next fixed window starts fresh.
    const later = new Date('2026-09-04T11:00:00Z')
    const fresh = await consumeRateLimit(t.db, 'opmlImport', 'user-a', later)
    expect(fresh).toMatchObject({ allowed: true, remaining: rule.limit - 1, retryAfterSec: 3600 })
  })

  test('pruneRateLimits drops windows older than a day and keeps the rest', async () => {
    const now = new Date('2026-09-04T10:15:00Z')
    await consumeRateLimit(t.db, 'discover', 'user-a', new Date('2026-09-02T10:00:00Z'))
    await consumeRateLimit(t.db, 'discover', 'user-a', new Date('2026-09-04T09:00:00Z'))
    await consumeRateLimit(t.db, 'discover', 'user-a', now)
    expect(await pruneRateLimits(t.db, now)).toBe(1)
    const [row] = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from rate_limits`)
    expect(row?.n).toBe(2)
  })

  test('is invisible to the anon and authenticated roles', async () => {
    await consumeRateLimit(t.db, 'discover', 'user-a')
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local role authenticated`)
      const rows = await tx.execute(sql`select * from rate_limits`)
      expect(rows).toHaveLength(0)
    })
  })
})
