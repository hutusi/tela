/**
 * `member.pendingFeeds` (ADR 0063): an import's feeds new to Tela beyond the member's day wait,
 * and the sweep adds them on the days after, as many a day as the setting allows, within the
 * subscription cap. A waiting feed someone else added meanwhile subscribes free, at once.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { first, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { createHttpClient } from '@tela/ingest/http'
import { fakeClock, memoryBlobs, memoryJobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import type { JobQueues } from '../src/kinds'
import type { PortableContext } from '../src/portable'
import { runJob, tick } from '../src/runner'

const NOW = Date.UTC(2026, 9, 5, 10)
const DAY = 86_400_000

let db: TelaDb
let ctx: PortableContext
let clock: ReturnType<typeof fakeClock>

const url = (name: string) => `https://${name}.example/feed`

beforeEach(async () => {
  db = (await createTestDb()).db
  clock = fakeClock(NOW)
  ctx = {
    db,
    blobs: memoryBlobs(),
    http: createHttpClient({ userAgent: 'TelaTest/1.0', politenessMs: 0, timeoutMs: 300 }),
    clock,
    random: () => 0.5,
    jobs: memoryJobs<JobQueues>(),
  }
  for (const id of ['u1', 'u2']) {
    await addTestUser(db, id)
    await db.run(sql`insert into profiles (user_id, handle, created_at, updated_at)
      values (${id}, ${`reader_${id}`}, 0, 0)`)
  }
  await db.batch([
    db.run(
      sql`insert into settings (key, value, updated_at) values ('member.feedsPerDay', '2', 0)`,
    ),
    // Yesterday's import: five feeds new to Tela wait, past a day of two.
    ...['p1', 'p2', 'p3', 'p4', 'known'].map((name, i) =>
      db.run(sql`insert into pending_feeds (user_id, feed_url, queued_at)
        values ('u1', ${url(name)}, ${NOW - DAY + i})`),
    ),
    // Two feeds u1 added today already: the day is spent.
    db.run(sql`insert into sites (id, home_url, created_at, updated_at)
      values (1, 'https://mine.example', 0, 0)`),
    ...[1, 2].map((n) =>
      db.run(sql`insert into feeds (site_id, feed_url, host, next_fetch_at, added_by, created_at,
          updated_at)
        values (1, ${`https://mine.example/${n}`}, 'mine.example', ${NOW}, 'u1', ${NOW}, ${NOW})`),
    ),
  ] as never)
})

/** One sweep: claim what is due, and run what it sent of this kind. */
async function sweep() {
  const report = await tick(ctx)
  const sent = ctx.jobs.take('misc').filter((m) => m.kind === 'member.pendingFeeds')
  // The fetches of the feeds added are tela-jobs' ordinary work; nothing here needs them run.
  for (const queue of ['fetch', 'extract', 'translate'] as const) ctx.jobs.take(queue)
  const outcomes = []
  for (const message of sent) outcomes.push(await runJob(ctx, message))
  return { claimed: report['member.pendingFeeds'] ?? 0, outcomes }
}

const waiting = async () =>
  (
    await db.all<{ feed_url: string }>(
      sql`select feed_url from pending_feeds where user_id = 'u1' order by queued_at`,
    )
  ).map((r) => r.feed_url)

const following = async () =>
  (
    await db.all<{ feed_url: string; seq: number }>(sql`
      select f.feed_url, s.seq from subscriptions s join feeds f on f.id = s.feed_id
      where s.user_id = 'u1' and s.deleted_at is null order by f.feed_url
    `)
  ).map((r) => r.feed_url)

describe('member.pendingFeeds', () => {
  test('nothing is due while the day is spent and no waiting feed is one Tela has', async () => {
    expect(await sweep()).toEqual({ claimed: 0, outcomes: [] })
    expect(await waiting()).toHaveLength(5)
  })

  test('a waiting feed someone else added subscribes at once, free', async () => {
    await db.batch([
      db.run(sql`insert into sites (id, home_url, created_at, updated_at)
        values (2, 'https://known.example', 0, 0)`),
      db.run(sql`insert into feeds (site_id, feed_url, host, next_fetch_at, added_by, created_at,
          updated_at)
        values (2, ${url('known')}, 'known.example', ${NOW}, 'u2', ${NOW}, ${NOW})`),
    ] as never)
    const run = await sweep()
    expect(run.claimed).toBe(1)
    expect(run.outcomes).toMatchObject([
      { status: 'done', result: { status: 'done', added: 0, subscribed: 1, waiting: 4 } },
    ])
    expect(await following()).toEqual([url('known')])
    expect(await waiting()).toEqual([url('p1'), url('p2'), url('p3'), url('p4')])
    // Its lease is gone, and with the day spent nothing more is due.
    const leases = await first<{ n: number }>(
      db,
      sql`select count(*) as n from leases where kind = 'member.pendingFeeds'`,
    )
    expect(leases?.n).toBe(0)
    expect((await sweep()).claimed).toBe(0)
  })

  test('a feed Tela has now is reached past more waiting rows than one run reads', async () => {
    // A raised cap lets a wait grow past what a run reads; the oldest 500 all need a day's room.
    await db.batch([
      db.run(sql`insert into settings (key, value, updated_at)
        values ('member.maxSubscriptions', 'null', 0)`),
      db.run(sql`insert into pending_feeds (user_id, feed_url, queued_at)
        select 'u1', 'https://bulk' || value || '.example/feed', ${NOW - 2 * DAY} + value
        from generate_series(1, 500)`),
      db.run(sql`insert into sites (id, home_url, created_at, updated_at)
        values (2, 'https://known.example', 0, 0)`),
      db.run(sql`insert into feeds (site_id, feed_url, host, next_fetch_at, added_by, created_at,
          updated_at)
        values (2, ${url('known')}, 'known.example', ${NOW}, 'u2', ${NOW}, ${NOW})`),
    ] as never)
    expect(await waiting()).toHaveLength(505)
    const run = await sweep()
    expect(run.outcomes).toMatchObject([
      { status: 'done', result: { status: 'done', added: 0, subscribed: 1, waiting: 504 } },
    ])
    expect(await following()).toEqual([url('known')])
    // With the day spent and nothing else Tela has, nothing more is due.
    expect(await sweep()).toEqual({ claimed: 0, outcomes: [] })
  })

  test('the next day adds the day’s worth, oldest first, and the rest wait for the day after', async () => {
    clock.set(NOW + DAY)
    const run = await sweep()
    expect(run.outcomes).toMatchObject([
      { status: 'done', result: { added: 2, subscribed: 2, waiting: 3 } },
    ])
    expect(await following()).toEqual([url('p1'), url('p2')])
    expect(await waiting()).toEqual([url('p3'), url('p4'), url('known')])
    // Added as an import adds a feed: the member's, due to be fetched, under a placeholder site.
    const added = await db.all(sql`
      select f.added_by, f.next_fetch_at <= ${clock.now()} as due, s.home_url
      from feeds f join sites s on s.id = f.site_id where f.feed_url in (${url('p1')}, ${url('p2')})
      order by f.feed_url
    `)
    expect(added).toEqual([
      { added_by: 'u1', due: 1, home_url: 'https://p1.example' },
      { added_by: 'u1', due: 1, home_url: 'https://p2.example' },
    ])
    // Synced: the subscriptions carry the batch's seq, so the member's devices hear of them.
    const seqs = await db.all<{ seq: number }>(
      sql`select seq from subscriptions where user_id = 'u1'`,
    )
    expect(seqs.every((r) => r.seq > 0)).toBe(true)
    expect((await sweep()).claimed).toBe(0)
    clock.set(NOW + 2 * DAY)
    await sweep()
    expect(await waiting()).toEqual([url('known')])
    clock.set(NOW + 3 * DAY)
    await sweep()
    expect(await waiting()).toEqual([])
    expect(await following()).toHaveLength(5)
  })

  test('a member who holds the cap keeps their wait, and is not swept until there is room', async () => {
    clock.set(NOW + DAY)
    await db.run(sql`insert into settings (key, value, updated_at)
      values ('member.maxSubscriptions', '1', 0)`)
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
      values ('u1', 1, 0, 0)`)
    expect((await sweep()).claimed).toBe(0)
    await db.run(sql`update settings set value = '2' where key = 'member.maxSubscriptions'`)
    expect((await sweep()).outcomes).toMatchObject([{ result: { added: 1, subscribed: 1 } }])
    expect(await waiting()).toHaveLength(4)
  })

  test("a suspended member's wait is kept and not swept, and lifting it brings their feeds on", async () => {
    clock.set(NOW + DAY)
    await db.run(sql`update profiles set suspended_at = ${NOW} where user_id = 'u1'`)
    expect((await sweep()).claimed).toBe(0)
    expect(await waiting()).toHaveLength(5)
    await db.run(sql`update profiles set suspended_at = null where user_id = 'u1'`)
    expect((await sweep()).outcomes).toMatchObject([{ result: { added: 2, subscribed: 2 } }])
  })

  test('a member who leaves standing while a run reads their rows has nothing added', async () => {
    for (const column of ['suspended_at', 'deleted_at']) {
      clock.set(NOW + DAY)
      await tick(ctx)
      const [message] = ctx.jobs.take('misc').filter((m) => m.kind === 'member.pendingFeeds')
      if (!message) throw new Error('nothing was sent')
      // Suspended, or closed, after the claim: the run still reads the rows it was sent for.
      await db.run(sql`update profiles set ${sql.raw(column)} = ${NOW} where user_id = 'u1'`)
      expect(await runJob(ctx, message)).toEqual({ status: 'lost' })
      expect(await following()).toEqual([])
      expect(await waiting()).toHaveLength(5)
      expect(
        await first(db, sql`select 1 as x from feeds where feed_url = ${url('p1')}`),
      ).toBeUndefined()
      await db.run(sql`update profiles set ${sql.raw(column)} = null where user_id = 'u1'`)
      await db.run(sql`delete from leases`)
    }
  })

  test('a run that lost its lease adds nothing', async () => {
    clock.set(NOW + DAY)
    await tick(ctx)
    const [message] = ctx.jobs.take('misc').filter((m) => m.kind === 'member.pendingFeeds')
    if (!message) throw new Error('nothing was sent')
    // Another holder took the item over once the lease ran out.
    await db.run(sql`update leases set owner = 'someone-else' where kind = 'member.pendingFeeds'`)
    expect(await runJob(ctx, message)).toEqual({ status: 'lost' })
    expect(await following()).toEqual([])
    expect(await waiting()).toHaveLength(5)
  })
})
