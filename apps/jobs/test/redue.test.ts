/**
 * A retry from the admin console (ADR 0039) puts a dead item back where its kind's sweep finds
 * it. Each case retires the item the way tela-jobs does when attempts run out (the kind's own
 * `exhausted`), checks the sweep no longer finds it, and then that `REDUE` brings it back.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, first, LEASE_KINDS, type LeaseKind, REDUE, redue, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { sql } from 'drizzle-orm'
import { KINDS, type WorkContext } from '../src/kinds'

const NOW = Date.UTC(2026, 9, 5, 10)
const HOUR = 3600_000

let db: TelaDb

beforeEach(async () => {
  db = (await createTestDb()).db
  await addTestUser(db, 'u1')
  await db.batch([
    db.run(sql`insert into profiles (user_id, handle, created_at, updated_at)
      values ('u1', 'reader_one', 0, 0)`),
    db.run(sql`insert into sites (id, home_url, created_at, updated_at)
      values (1, 'https://a.example', 0, 0)`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, hub_url, created_at,
        updated_at)
      values (1, 1, 'https://a.example/feed', 'a.example', ${NOW - HOUR}, 'https://hub.example', 0, 0)`),
    db.run(sql`insert into articles (id, feed_id, dedup_key, url, url_host, title, title_hash,
        source_lang, fetched_at, sort_at, extract_state, content_key)
      values (1, 1, 'a', 'https://a.example/1', 'a.example', 'A post', 'h1', 'en', ${NOW - HOUR},
        ${NOW - HOUR}, 'due', 'ck1')`),
    db.run(sql`insert into site_claims (id, site_id, user_id, method, token, status, created_at)
      values (1, 1, 'u1', 'meta', 'tok', 'pending', 0)`),
    db.run(sql`insert into websub_subscriptions (feed_id, hub_url, topic_url, secret, status,
        updated_at)
      values (1, 'https://hub.example', 'https://a.example/feed', 's', 'pending', 0)`),
    db.run(sql`insert into body_translations (content_key, lang, state, request_id, requested_by,
        reserved_tokens, reserved_day, updated_at)
      values ('ck1', 'fr', 'requested', 'r1', 'u1', 5000, '2026-10-05', ${NOW - HOUR})`),
  ] as never)
})

/** Each kind's key for the one item the world above holds. */
const KEYS: Record<LeaseKind, string> = {
  'feed.fetch': '1',
  'article.extract': '1',
  'translate.title': '1',
  'translate.body': 'ck1:fr',
  'site.assets': '1',
  'site.claim': '1',
  'websub.subscribe': '1',
  'member.gravatar': 'u1',
}

const ctx = { backgroundBudget: 0 } as WorkContext

async function isDue(kind: LeaseKind, now: number): Promise<boolean> {
  const spec = KINDS[kind]
  if (!spec) throw new Error(`no kind ${kind}`)
  const row = await first<{ n: number }>(
    db,
    sql`select count(*) as n from (${spec.due(now, ctx)}) where cast(key as text) = ${KEYS[kind]}`,
  )
  return (row?.n ?? 0) > 0
}

async function exhaust(kind: LeaseKind, now: number) {
  const spec = KINDS[kind]
  if (!spec) throw new Error(`no kind ${kind}`)
  await db.batch([bumpSeq(db), ...spec.exhausted(db, KEYS[kind], now)] as never)
}

async function retry(kind: LeaseKind, now: number) {
  const { synced, statements } = redue(db, kind, KEYS[kind], now)
  await db.batch([...(synced ? [bumpSeq(db)] : []), ...statements] as never)
}

describe('a retried dead item', () => {
  test('every kind of work has a way back', () => {
    expect(Object.keys(REDUE).sort()).toEqual([...LEASE_KINDS].sort())
    expect(Object.keys(KINDS).sort()).toEqual([...LEASE_KINDS].sort())
  })

  test.each([...LEASE_KINDS])('%s is due again after a retry', async (kind) => {
    expect(await isDue(kind, NOW)).toBe(true)
    await exhaust(kind, NOW)
    const later = NOW + 60_000
    expect(await isDue(kind, later)).toBe(false)
    await retry(kind, later)
    expect(await isDue(kind, later)).toBe(true)
  })

  test('a synced row it changes reaches readers through the sequence', async () => {
    await exhaust('site.claim', NOW)
    const before = await first<{ seq: number }>(db, sql`select seq from site_claims where id = 1`)
    await retry('site.claim', NOW + 1)
    const after = await first<{ seq: number; status: string; error: string | null }>(
      db,
      sql`select seq, status, error from site_claims where id = 1`,
    )
    expect(after).toMatchObject({ status: 'pending', error: null })
    expect(after?.seq).toBeGreaterThan(before?.seq ?? 0)
  })

  test("a body is asked for again by nobody, so the background budget pays, not the member's", async () => {
    await exhaust('translate.body', NOW)
    await retry('translate.body', NOW + 1)
    const row = await first<Record<string, unknown>>(
      db,
      sql`select state, request_id, requested_by, reserved_tokens, reserved_day, used_tokens,
        chunk_keys, object_key, failed_leaves from body_translations where content_key = 'ck1'`,
    )
    expect(row).toMatchObject({
      state: 'requested',
      requested_by: null,
      reserved_tokens: 0,
      reserved_day: '2026-10-05',
      used_tokens: 0,
      chunk_keys: '[]',
      object_key: null,
      failed_leaves: '[]',
    })
    expect(row?.request_id).not.toBe('r1')
  })

  test('takes a leftover backoff away, but never a lease someone holds', async () => {
    await db.run(sql`insert into leases (kind, key, owner, until, attempts, not_before)
      values ('feed.fetch', '1', 'old', 0, 3, ${NOW + HOUR}),
        ('site.assets', '1', 'busy', ${NOW + HOUR}, 1, 0)`)
    await retry('feed.fetch', NOW)
    await retry('site.assets', NOW)
    const left = await db.all<{ kind: string; owner: string }>(
      sql`select kind, owner from leases order by kind`,
    )
    expect(left).toEqual([{ kind: 'site.assets', owner: 'busy' }])
  })
})
