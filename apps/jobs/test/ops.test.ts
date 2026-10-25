import { describe, expect, test } from 'bun:test'
import { backUp, heartbeat, heartbeats, latestBackup, setSetting, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { memoryBlobs, memoryMail } from '@tela/platform/portable'
import type { SettingKey, SettingValue } from '@tela/shared'
import { sql } from 'drizzle-orm'
import {
  checkAlerts,
  checkHealth,
  digest,
  nightly,
  outboxFrom,
  pingDeadman,
  weekly,
} from '../src/ops'

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

  test('a kind the last tick could not run is a /fail, though the tick itself ran', async () => {
    const { db, blobs } = await world()
    await heartbeat(db, 'tick', NOW, {
      'feed.fetch': 0,
      errors: { 'article.extract': 'Error: D1_ERROR: overloaded' },
    })
    const calls: { url: string; body: string }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) })
      return new Response('OK')
    }) as unknown as typeof fetch
    const h = await checkHealth(db, blobs, NOW, 'https://hc-ping.com/abc', fake)
    expect(h.ok).toBe(false)
    expect(calls).toEqual([
      {
        url: 'https://hc-ping.com/abc/fail',
        body: 'the last tick could not run article.extract (Error: D1_ERROR: overloaded)',
      },
    ])
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

describe('the alerts', () => {
  const OWNER = 'owner@x.test'
  const BASE = 'https://tela.test'

  async function set<K extends SettingKey>(db: TelaDb, key: K, value: SettingValue<K>) {
    await db.batch([...setSetting(db, { key, value, actor: null, group: 'g', now: 1 })] as never)
  }
  async function spend(
    db: TelaDb,
    subject: string,
    used: number,
    reserved = 0,
    day = '2026-09-28',
  ) {
    await db.run(sql`insert into usage_daily (subject, day, used, reserved)
      values (${subject}, ${day}, ${used}, ${reserved})`)
  }
  async function join(db: TelaDb, n: number, at: number) {
    for (let i = 0; i < n; i++) {
      await db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
        values (${`j${at}-${i}`}, 'x', ${`j${at}-${i}@x.test`}, 1, ${at}, ${at})`)
      await db.run(sql`insert into profiles (user_id, handle, created_at, updated_at)
        values (${`j${at}-${i}`}, ${`joiner_${at}_${i}`}, ${at}, ${at})`)
    }
  }
  async function report(db: TelaDb, at: number, state = 'open') {
    await db.run(sql`insert into reports (target_kind, target_key, reason, state, created_at)
      values ('site', '1', 'spam', ${state}, ${at})`)
  }
  const markers = async (db: TelaDb) =>
    (
      await db.all<{ day: string; name: string }>(
        sql`select day, name from ops_alerts order by name`,
      )
    ).map((r) => `${r.day} ${r.name}`)
  const none = { sent: [], failed: [] }

  test('the budget is mailed once a day at each share, the highest when reached together', async () => {
    const { db } = await world()
    await set(db, 'translation.siteDailyTokens', 1000)
    const mail = memoryMail()
    const outbox = { mail, to: OWNER }
    // Everyone's together: a member's day and the background's, used and reserved.
    await spend(db, '*', 500)
    await spend(db, 'member-1', 200, 100)
    // Another day's tokens are not today's.
    await spend(db, 'member-1', 5000, 0, '2026-09-27')
    expect(await checkAlerts(db, NOW, outbox, BASE)).toEqual({ sent: ['budget:80'], failed: [] })
    expect(mail.outbox).toHaveLength(1)
    expect(mail.outbox[0]).toMatchObject({
      to: OWNER,
      subject: "Tela: 80% of today's translation budget used",
    })
    expect(mail.outbox[0]?.text).toContain("used 800 of today's 1,000 tokens (80%)")
    expect(mail.outbox[0]?.text).toContain(`${BASE}/admin/settings`)
    // Asked again the same day, nothing new: no second mail.
    expect(await checkAlerts(db, NOW + 5 * 60_000, outbox, BASE)).toEqual(none)
    await db.run(sql`update usage_daily set used = used + 300 where subject = '*'`)
    expect(await checkAlerts(db, NOW + 10 * 60_000, outbox, BASE)).toEqual({
      sent: ['budget:100'],
      failed: [],
    })
    expect(mail.outbox.map((m) => m.subject)).toEqual([
      "Tela: 80% of today's translation budget used",
      "Tela: today's translation budget is spent",
    ])
    // The next UTC day starts afresh; reached at once, both shares go in one mail.
    await spend(db, '*', 2000, 0, '2026-09-29')
    expect(await checkAlerts(db, NOW + 24 * HOUR, outbox, BASE)).toEqual({
      sent: ['budget:80', 'budget:100'],
      failed: [],
    })
    expect(mail.outbox).toHaveLength(3)
    expect(mail.outbox[2]?.subject).toBe("Tela: today's translation budget is spent")
  })

  test('below every share, with no budget, or with a budget of 0, nothing is mailed', async () => {
    const { db } = await world()
    const mail = memoryMail()
    const outbox = { mail, to: OWNER }
    await set(db, 'translation.siteDailyTokens', 1000)
    await spend(db, '*', 799)
    expect(await checkAlerts(db, NOW, outbox)).toEqual(none)
    await db.run(sql`update usage_daily set used = 5000`)
    await set(db, 'translation.siteDailyTokens', null)
    expect(await checkAlerts(db, NOW, outbox)).toEqual(none)
    // 0 is translation paused on purpose: there is no share of it to warn about.
    await set(db, 'translation.siteDailyTokens', 0)
    expect(await checkAlerts(db, NOW, outbox)).toEqual(none)
    // The shares are the operator's to choose.
    await set(db, 'translation.siteDailyTokens', 10_000)
    await set(db, 'alerts.budgetPercents', [50])
    expect(await checkAlerts(db, NOW, outbox)).toEqual({ sent: ['budget:50'], failed: [] })
    expect(mail.outbox).toHaveLength(1)
  })

  test('a send that fails is not remembered, so the next run sends it', async () => {
    const { db } = await world()
    await set(db, 'translation.siteDailyTokens', 100)
    await spend(db, '*', 100)
    let down = true
    const sent: string[] = []
    const flaky = {
      send: async (m: { subject: string }) => {
        if (down) throw new Error('resend is down')
        sent.push(m.subject)
      },
    }
    const outbox = { mail: flaky, to: OWNER }
    expect(await checkAlerts(db, NOW, outbox)).toEqual({
      sent: [],
      failed: ['budget:80', 'budget:100'],
    })
    expect(await markers(db)).toEqual([])
    down = false
    expect(await checkAlerts(db, NOW + 5 * 60_000, outbox)).toEqual({
      sent: ['budget:80', 'budget:100'],
      failed: [],
    })
    expect(sent).toEqual(["Tela: today's translation budget is spent"])
  })

  test('with nowhere to send, nothing is checked or marked', async () => {
    const { db } = await world()
    await set(db, 'translation.siteDailyTokens', 100)
    await spend(db, '*', 100)
    expect(await checkAlerts(db, NOW, undefined)).toEqual(none)
    expect(await markers(db)).toEqual([])
    expect(outboxFrom({ DIGEST_TO: OWNER })).toBeUndefined()
    expect(outboxFrom({ RESEND_API_KEY: 'k' })).toBeUndefined()
    expect(outboxFrom({ DIGEST_TO: OWNER, RESEND_API_KEY: 'k' })?.to).toBe(OWNER)
  })

  test('more sign-ups in a day than the setting mail once, with counts only', async () => {
    const { db } = await world()
    await set(db, 'alerts.signupsPerDay', 3)
    const mail = memoryMail()
    const outbox = { mail, to: OWNER }
    const today = Date.UTC(2026, 8, 28)
    // Yesterday's accounts are not today's.
    await join(db, 5, today - 1)
    await join(db, 3, today)
    expect(await checkAlerts(db, NOW, outbox, BASE)).toEqual(none)
    await join(db, 1, NOW - HOUR)
    expect(await checkAlerts(db, NOW, outbox, BASE)).toEqual({ sent: ['signups'], failed: [] })
    await join(db, 10, NOW)
    expect(await checkAlerts(db, NOW + 5 * 60_000, outbox, BASE)).toEqual(none)
    expect(mail.outbox).toHaveLength(1)
    const [sent] = mail.outbox
    expect(sent?.subject).toBe('Tela: 4 new accounts today')
    expect(sent?.text).toContain('more than the 3 that sends this mail')
    expect(sent?.text).toContain('once 200 accounts have joined (signup.maxPerDay)')
    // No address, no name: the mail says how many, never who.
    expect(sent?.text).not.toContain('@x.test')
    // Null is never.
    await set(db, 'alerts.signupsPerDay', null)
    expect(await checkAlerts(db, NOW + 24 * HOUR, outbox, BASE)).toEqual(none)
  })

  test('open reports mail at most once an hour, and only when one is new', async () => {
    const { db } = await world()
    const mail = memoryMail()
    const outbox = { mail, to: OWNER }
    await report(db, NOW - 2 * HOUR, 'resolved')
    expect(await checkAlerts(db, NOW, outbox, BASE)).toEqual(none)
    await report(db, NOW - HOUR)
    await report(db, NOW - 1)
    expect(await checkAlerts(db, NOW, outbox, BASE)).toEqual({ sent: ['reports:12'], failed: [] })
    expect(mail.outbox[0]?.subject).toBe('Tela: 2 reports wait for a look')
    expect(mail.outbox[0]?.text).toContain(`${BASE}/admin/reports`)
    // A new one within the hour waits for the next hour.
    await report(db, NOW + 10 * 60_000)
    expect(await checkAlerts(db, NOW + 20 * 60_000, outbox, BASE)).toEqual(none)
    expect(await checkAlerts(db, NOW + HOUR, outbox, BASE)).toEqual({
      sent: ['reports:13'],
      failed: [],
    })
    expect(mail.outbox[1]?.text).toContain('3 reports are open, 1 of them new since the last mail')
    // Still open, nothing new: the queue already mailed is not mailed again.
    expect(await checkAlerts(db, NOW + 2 * HOUR, outbox, BASE)).toEqual(none)
    expect(mail.outbox).toHaveLength(2)
    expect(await markers(db)).toEqual(['2026-09-28 reports:12', '2026-09-28 reports:13'])
  })
})
