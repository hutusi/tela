/**
 * `member.erase` (ADR 0058) on the portable runner: due only once the cookie cache has passed,
 * idempotent when run again, and writing nothing for a holder that lost its lease.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  bumpSeq,
  claimDue,
  closeAccount,
  currentSeq,
  ERASE_AFTER_MS,
  first,
  startLease,
  type TelaDb,
} from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { createHttpClient } from '@tela/ingest/http'
import { fakeClock, memoryBlobs, memoryJobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { eraseMemberJob } from '../src/erase'
import { type JobQueues, KINDS } from '../src/kinds'
import { cycle, type PortableContext } from '../src/portable'

type Row = Record<string, unknown>

const NOW = Date.UTC(2026, 9, 25, 10)
const MIN = 60_000

let db: TelaDb
let ctx: PortableContext
let clock: ReturnType<typeof fakeClock>
let blobs: ReturnType<typeof memoryBlobs>

const count = async (query: ReturnType<typeof sql>) =>
  (await first<{ n: number }>(db, sql`select count(*) as n from ${query}`))?.n ?? 0

beforeEach(async () => {
  db = (await createTestDb()).db
  clock = fakeClock(NOW)
  blobs = memoryBlobs()
  ctx = {
    db,
    blobs,
    http: createHttpClient({ userAgent: 'TelaTest/1.0', politenessMs: 0, timeoutMs: 300 }),
    clock,
    jobs: memoryJobs<JobQueues>(),
  }
  await addTestUser(db, 'gone')
  await addTestUser(db, 'kept')
  const ids = JSON.stringify(Array.from({ length: 1200 }, (_, i) => i + 1))
  await db.batch([
    bumpSeq(db),
    // Gravatar off for both, so no check of it is due.
    db.run(sql`insert into profiles (user_id, handle, avatar_key, gravatar_at, created_at,
        updated_at, seq)
      values ('gone', 'gone', 'avatars/gone/a.png', 1, 0, 0, ${currentSeq}),
        ('kept', 'kept', null, 1, 0, 0, ${currentSeq})`),
    db.run(sql`insert into sites (id, home_url, created_at, updated_at, seq)
      values (1, 'https://b.example', 0, 0, ${currentSeq})`),
    // Paused, so the only work a cycle finds is the erasure.
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, status, created_at,
        updated_at, seq)
      values (1, 1, 'https://b.example/feed', 'b.example', 0, 'paused', 0, 0, ${currentSeq})`),
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at,
        like_count, seq)
      select value, 1, 'k' || value, 'P', 0, 0, 2, ${currentSeq} from json_each(${ids}) where true`),
    db.run(sql`insert into user_article_states (user_id, article_id, read_at, liked_at, seq)
      select u.value, a.value, 0, 0, ${currentSeq}
      from json_each('["gone","kept"]') u, json_each(${ids}) a where true`),
    db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, seq)
      values ('gone', 1, 0, 0, ${currentSeq}), ('kept', 1, 0, 0, ${currentSeq})`),
    db.run(sql`update sites set reader_count = 2 where id = 1`),
  ] as never)
  await blobs.put('avatars/gone/a.png', 'png')
  await blobs.put('avatars/kept/b.png', 'png')
  expect(
    await closeAccount(db, {
      userId: 'gone',
      actor: 'gone',
      action: 'account.delete',
      group: 'g',
      now: NOW,
    }),
  ).toBe('closed')
})

describe('member.erase', () => {
  test('waits out the cookie cache, then erases in chunks, once', async () => {
    expect((await cycle(ctx)).tick['member.erase']).toBe(0)
    clock.advance(ERASE_AFTER_MS)
    const { tick, outcomes } = await cycle(ctx)
    expect(tick['member.erase']).toBe(1)
    expect(outcomes).toMatchObject([{ status: 'done', result: { status: 'erased' } }])
    expect(await count(sql`user_article_states where user_id = 'gone'`)).toBe(0)
    expect(await count(sql`user_article_states where user_id = 'kept'`)).toBe(1200)
    expect(await count(sql`articles where like_count <> 1`)).toBe(0)
    expect(await count(sql`subscriptions`)).toBe(1)
    expect(await first<Row>(db, sql`select reader_count from sites where id = 1`)).toEqual({
      reader_count: 1,
    })
    expect(await blobs.get('avatars/gone/a.png')).toBeNull()
    expect(await blobs.get('avatars/kept/b.png')).not.toBeNull()
    expect(
      await first<Row>(db, sql`select erased_at from profiles where user_id = 'gone'`),
    ).toEqual({
      erased_at: NOW + ERASE_AFTER_MS,
    })
    expect(await count(sql`leases`)).toBe(0)
    // Erased, it is not due again.
    clock.advance(MIN)
    expect((await cycle(ctx)).tick['member.erase']).toBe(0)
  })

  test('a holder that lost its lease writes nothing, and the next run does it all', async () => {
    clock.advance(ERASE_AFTER_MS)
    const spec = KINDS['member.erase']
    if (!spec) throw new Error('no member.erase')
    const claimed = await claimDue(db, {
      kind: 'member.erase',
      owner: 'claim-1',
      now: clock.now(),
      ttlMs: spec.ttlMs,
      limit: 1,
      due: spec.due(clock.now(), ctx),
    })
    expect(claimed.map((c) => c.key)).toEqual(['gone'])
    const started = await startLease(
      db,
      { kind: 'member.erase', key: 'gone', owner: 'claim-1' },
      'claim-1>a',
      clock.now(),
      spec.ttlMs,
    )
    if (!started) throw new Error('not started')
    // Its lease expires and another run takes the item over before the first one commits.
    clock.advance(spec.ttlMs + 1)
    await db.run(sql`update leases set owner = 'claim-2>b', until = ${clock.now() + spec.ttlMs}`)
    expect(await eraseMemberJob(ctx, started.lease)).toEqual({ status: 'lost' })
    expect(await count(sql`user_article_states where user_id = 'gone'`)).toBe(1200)
    expect(await blobs.get('avatars/gone/a.png')).not.toBeNull()
    // The holder now finishes it all, and a run after that finds nothing to do.
    const now = await eraseMemberJob(ctx, { kind: 'member.erase', key: 'gone', owner: 'claim-2>b' })
    expect(now).toMatchObject({ status: 'erased' })
    expect(await count(sql`user_article_states where user_id = 'gone'`)).toBe(0)
    await db.run(sql`insert into leases (kind, key, owner, until)
      values ('member.erase', 'gone', 'again', ${clock.now() + MIN})`)
    expect(
      await eraseMemberJob(ctx, { kind: 'member.erase', key: 'gone', owner: 'again' }),
    ).toEqual({ status: 'skipped' })
  })

  test('waits for a translation still running for the member before it stamps', async () => {
    await db.run(sql`insert into body_translations (content_key, lang, state, request_id,
        requested_by, reserved_tokens, reserved_day, updated_at)
      values ('ck', 'fr', 'running', 'r', 'gone', 100, '2026-10-25', 0)`)
    await db.run(sql`insert into usage_daily (subject, day, reserved, used)
      values ('gone', '2026-10-25', 100, 0)`)
    clock.advance(ERASE_AFTER_MS)
    expect((await cycle(ctx)).outcomes).toMatchObject([{ result: { status: 'waiting' } }])
    expect(await count(sql`usage_daily where subject = 'gone'`)).toBe(1)
    await db.run(sql`update body_translations set state = 'done'`)
    clock.advance(MIN)
    expect((await cycle(ctx)).outcomes).toMatchObject([{ result: { status: 'erased' } }])
    expect(await count(sql`usage_daily where subject = 'gone'`)).toBe(0)
    expect(await first<Row>(db, sql`select requested_by from body_translations`)).toEqual({
      requested_by: null,
    })
  })
})
