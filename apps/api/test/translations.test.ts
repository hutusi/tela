import { beforeEach, describe, expect, test } from 'bun:test'
import {
  ACTION_LIMITS,
  bumpSeq,
  currentSeq,
  dueBodies,
  first,
  nextUtcMidnight,
  type TelaDb,
  utcDay,
} from '@tela/data'
import type { PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { isScriptConversion, reservationFor } from '../src/routes/translations'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let db: TelaDb
let reader: SignedIn

async function article(options: { optOut?: boolean; lang?: string; chars?: number } = {}) {
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, translation_opt_out, created_at, updated_at, seq)
      values (1, 'https://blog.example', ${options.optOut ? 1 : 0}, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (1, 1, 'https://blog.example/feed', 'blog.example', 0, 0, 0, ${currentSeq})`),
  ] as never)
  await another(1, options)
}

/** One more Japanese post of the blog `article` made, its body `ckey<id>`. */
async function another(id: number, options: { lang?: string; chars?: number } = {}) {
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, source_lang,
        current_version, content_key, seq)
      values (${id}, 1, ${`k${id}`}, 'はじめに', 0, 0, ${options.lang ?? 'ja'}, 1, ${`ckey${id}`},
        ${currentSeq})`),
    db.run(sql`insert into article_versions (article_id, version, provenance, content_key, norm_version,
        body_chars, created_at)
      values (${id}, 1, 'feed', ${`ckey${id}`}, 1, ${options.chars ?? 2000}, 0)`),
  ] as never)
}

const setting = (key: string, value: unknown) =>
  db.run(sql`insert into settings (key, value, updated_at)
    values (${key}, ${JSON.stringify(value)}, 0)
    on conflict (key) do update set value = excluded.value`)

type Answer = {
  code: number
  status: string
  translation: { state: string; dueAt: number | null; seq: number } | null
  reason?: string
  resetsAt?: number
  allowance?: { perDay: number | null; usedToday: number; resetsAt: number }
}

const ask = (body: Record<string, unknown> = { articleId: 1, lang: 'zh-Hans' }, as = reader) =>
  api.request('/api/v1/translations', { body, as })
const askJson = async (body?: Record<string, unknown>, as?: SignedIn): Promise<Answer> => {
  const res = await ask(body, as)
  return { code: res.status, ...((await res.json()) as Omit<Answer, 'code'>) }
}
const usage = () =>
  first<{ reserved: number; used: number }>(
    db,
    sql`select reserved, used from usage_daily where subject = ${reader.userId}`,
  )
/** Every member's day, as the ledger holds it. */
const ledger = () =>
  db.all(sql`select subject, day, reserved, requests from usage_daily order by subject, day`)
const owner = (contentKey: string) =>
  first<{ requested_by: string; reserved_day: string; due_at: number | null }>(
    db,
    sql`select requested_by, reserved_day, due_at from body_translations
      where content_key = ${contentKey} and lang = 'zh-Hans'`,
  )

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  reader = await signedIn(api)
})

describe('asking for a translation', () => {
  test('makes a requested row, reserves against the day, and sends the work on at once', async () => {
    await article({ chars: 2000 })
    const res = await askJson()
    expect(res).toMatchObject({
      code: 200,
      status: 'requested',
      translation: { state: 'requested' },
    })
    expect(await usage()).toEqual({ reserved: reservationFor(2000, 'ja'), used: 0 })
    expect(api.jobs.sent).toMatchObject([
      { queue: 'translate', body: { kind: 'translate.body', key: 'ckey1:zh-Hans' } },
    ])
    const lease = await first<{ owner: string }>(
      db,
      sql`select owner from leases where kind = 'translate.body'`,
    )
    const [sent] = api.jobs.sent
    expect(lease?.owner).toBe((sent?.body as { owner: string } | undefined)?.owner)
  })

  test('a second ask while it runs is told so, and reserves nothing more', async () => {
    await article()
    await askJson()
    const again = await askJson()
    expect(again.status).toBe('in_progress')
    expect((await usage())?.reserved).toBe(reservationFor(2000, 'ja'))
    expect(api.jobs.sent).toHaveLength(1)
  })

  test('a finished one is ready, with its object', async () => {
    await article()
    await db.run(sql`insert into body_translations (content_key, lang, state, object_key, updated_at)
      values ('ckey1', 'zh-Hans', 'done', 't/ckey1/zh-Hans/abc.json', 0)`)
    expect(await askJson()).toMatchObject({
      status: 'ready',
      translation: { objectKey: 't/ckey1/zh-Hans/abc.json' },
    })
  })

  test('a failed one may be asked for again, answered with a seq past the failure', async () => {
    await article()
    await db.batch([
      bumpSeq(db),
      db.run(sql`insert into body_translations (content_key, lang, state, updated_at, seq)
        values ('ckey1', 'zh-Hans', 'failed', 0, ${currentSeq})`),
    ] as never)
    const failed = await first<{ seq: number }>(db, sql`select seq from body_translations`)
    const again = await askJson()
    expect(again.status).toBe('requested')
    // A pull that read the failed row can land after this answer: the seq says which is later.
    expect((again.translation as { seq: number }).seq).toBeGreaterThan(failed?.seq ?? Infinity)
  })

  test('a blog that opted out is refused before anything is counted or reserved', async () => {
    await article({ optOut: true })
    expect((await askJson()).status).toBe('unavailable')
    expect(await usage()).toBeUndefined()
    // Signing in counted a try against the member's address; nothing counted the translation.
    expect(
      await first(db, sql`select 1 as x from action_limits where key like 'translate:%'`),
    ).toBeUndefined()
    expect(api.jobs.sent).toEqual([])
  })

  test('an article already in the language, or an unknown language, is invalid', async () => {
    await article({ lang: 'zh-Hans' })
    expect((await askJson()).status).toBe('invalid')
    expect((await askJson({ articleId: 1, lang: 'de' })).code).toBe(400)
    expect((await askJson({ articleId: 99, lang: 'en' })).code).toBe(404)
  })

  test('the other Chinese script is converted, not translated: it reserves nothing', async () => {
    await article({ lang: 'zh-Hans' })
    // No paid translation at all today or tomorrow refuses one, but not a conversion, which costs
    // nothing and is not counted.
    await setting('member.translationsPerDay', 0)
    await setting('translation.siteDailyTokens', 0)
    expect((await askJson({ articleId: 1, lang: 'en' })).status).toBe('budget_exhausted')
    expect(await askJson({ articleId: 1, lang: 'zh-Hant' })).toMatchObject({
      code: 200,
      status: 'requested',
      allowance: { perDay: 0, usedToday: 0 },
    })
    expect(await usage()).toEqual({ reserved: 0, used: 0 })
    expect(api.jobs.sent).toMatchObject([{ body: { key: 'ckey1:zh-Hant' } }])
  })

  test('the answer says how many of the day the member has used', async () => {
    await article()
    const res = await askJson()
    expect(res.allowance).toEqual({
      perDay: 20,
      usedToday: 1,
      resetsAt: nextUtcMidnight(api.clock.now()),
    })
  })

  test('asks are rate limited per member', async () => {
    await article()
    await db.run(sql`insert into body_translations (content_key, lang, state, updated_at)
      values ('ckey1', 'zh-Hans', 'failed', 0)`)
    for (let i = 0; i < ACTION_LIMITS.translate.limit; i++) {
      await db.run(sql`update body_translations set state = 'failed'`)
      expect((await ask()).status).toBe(200)
    }
    await db.run(sql`update body_translations set state = 'failed'`)
    const res = await askJson()
    expect(res).toMatchObject({ code: 429, status: 'rate_limited' })
  })

  test('a conversion counts against its own rate limit, never the paid one', async () => {
    await article({ lang: 'zh-Hans' })
    // An hour of paid translations already spent: a Traditional reader still reads Simplified
    // posts converted, and converting them takes nothing from the next translation.
    const hour = 3600_000
    const windowStart = Math.floor(api.clock.now() / hour) * hour
    await db.run(sql`insert into action_limits (key, window_start, count)
      values (${`translate:${reader.userId}`}, ${windowStart}, ${ACTION_LIMITS.translate.limit})`)
    expect((await askJson({ articleId: 1, lang: 'en' })).code).toBe(429)
    expect((await askJson({ articleId: 1, lang: 'zh-Hant' })).status).toBe('requested')
    expect(
      await db.all(sql`select key, count from action_limits where key like 'convert:%'`),
    ).toEqual([{ key: `convert:${reader.userId}`, count: 1 }])
  })

  test('the status route shows what exists now, and the row syncs to the reader', async () => {
    await article()
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, seq)
      values (${reader.userId}, 1, 0, 0, 0)`)
    const snap = (await (
      await api.request('/api/v1/sync?cursor=0', { as: reader })
    ).json()) as PullResponse
    await askJson()
    const status = await api.request('/api/v1/translations/ckey1/zh-Hans', { as: reader })
    expect(status.headers.get('cache-control')).toBe('no-store')
    const delta = (await (
      await api.request(`/api/v1/sync?cursor=${snap.cursor}`, { as: reader })
    ).json()) as PullResponse
    expect(delta.rows.translations).toMatchObject([{ contentKey: 'ckey1', state: 'requested' }])
    // The same seq as the synced row: the reader orders the two by it.
    expect(await status.json()).toEqual({
      contentKey: 'ckey1',
      lang: 'zh-Hans',
      state: 'requested',
      chunkKeys: [],
      objectKey: null,
      failedLeaves: [],
      dueAt: null,
      seq: delta.rows.translations[0]?.seq,
    })
  })
})

describe('a day with no room (ADR 0057)', () => {
  const MIDNIGHT = () => nextUtcMidnight(api.clock.now())
  /** What each of these posts reserves. */
  const R = reservationFor(2000, 'ja')
  const zh = (articleId: number) => ({ articleId, lang: 'zh-Hans' })

  test("past the member's count a request waits for the next UTC midnight; past tomorrow's, it is declined", async () => {
    await article()
    await another(2)
    await another(3)
    await setting('member.translationsPerDay', 1)
    expect((await askJson(zh(1))).status).toBe('requested')
    const waits = await askJson(zh(2))
    expect(waits).toMatchObject({
      code: 200,
      status: 'scheduled',
      translation: { state: 'requested', dueAt: MIDNIGHT() },
      allowance: { perDay: 1, usedToday: 1 },
    })
    // Nothing is sent for it: it is not due before midnight.
    expect(api.jobs.sent.map((m) => (m.body as { key: string }).key)).toEqual(['ckey1:zh-Hans'])
    expect(
      await db.all(
        sql`select key from (${dueBodies(api.clock.now())}) where key = 'ckey2:zh-Hans'`,
      ),
    ).toEqual([])
    expect(
      await db.all(sql`select key from (${dueBodies(MIDNIGHT())}) where key = 'ckey2:zh-Hans'`),
    ).toEqual([{ key: 'ckey2:zh-Hans' }])
    // Tomorrow's one is taken too: declined, the member's own limit, and when it starts again.
    expect(await askJson(zh(3))).toMatchObject({
      code: 200,
      status: 'budget_exhausted',
      translation: null,
      reason: 'member',
      resetsAt: MIDNIGHT(),
    })
    const tomorrow = utcDay(MIDNIGHT())
    expect(await ledger()).toEqual([
      { subject: reader.userId, day: utcDay(api.clock.now()), reserved: R, requests: 1 },
      { subject: reader.userId, day: tomorrow, reserved: R, requests: 1 },
    ])
    // Asking again for the one that waits is told so, and changes nothing.
    expect((await askJson(zh(2))).status).toBe('scheduled')
    expect(await owner('ckey2')).toEqual({
      requested_by: reader.userId,
      reserved_day: tomorrow,
      due_at: MIDNIGHT(),
    })
  })

  test("the site's day puts a request off too, and a refusal says it was the site's", async () => {
    await article()
    await another(2)
    await setting('translation.siteDailyTokens', 5000)
    await db.run(sql`insert into usage_daily (subject, day, reserved, used)
      values ('*', ${utcDay(api.clock.now())}, 0, 2000)`)
    // 2,000 of 5,000 spent today: a 3,500-token post waits for tomorrow, and fills it.
    expect((await askJson(zh(1))).status).toBe('scheduled')
    expect(await askJson(zh(2))).toMatchObject({ status: 'budget_exhausted', reason: 'site' })
  })

  test('an operator is never put off, and still counts toward the site', async () => {
    await article()
    await db.run(sql`update profiles set is_admin = 1 where user_id = ${reader.userId}`)
    await setting('member.translationsPerDay', 0)
    await setting('translation.siteDailyTokens', 0)
    expect(await askJson(zh(1))).toMatchObject({
      status: 'requested',
      allowance: { perDay: null, usedToday: 1 },
    })
    expect(await ledger()).toEqual([
      { subject: reader.userId, day: utcDay(api.clock.now()), reserved: R, requests: 1 },
    ])
  })

  test('a member with room today takes a waiting request over, and it runs now', async () => {
    await article()
    await another(2)
    await setting('member.translationsPerDay', 1)
    await askJson(zh(1))
    await askJson(zh(2))
    const other = await signedIn(api, 'other@x.test')
    expect(await askJson(zh(2), other)).toMatchObject({
      status: 'requested',
      translation: { state: 'requested', dueAt: null },
      allowance: { perDay: 1, usedToday: 1 },
    })
    expect(await owner('ckey2')).toEqual({
      requested_by: other.userId,
      reserved_day: utcDay(api.clock.now()),
      due_at: null,
    })
    expect(api.jobs.sent.map((m) => (m.body as { key: string }).key)).toEqual([
      'ckey1:zh-Hans',
      'ckey2:zh-Hans',
    ])
    // The first member's tomorrow is given back; the second's today holds it.
    const today = utcDay(api.clock.now())
    expect(await ledger()).toEqual(
      [
        { subject: reader.userId, day: today, reserved: R, requests: 1 },
        { subject: reader.userId, day: utcDay(MIDNIGHT()), reserved: 0, requests: 0 },
        { subject: other.userId, day: today, reserved: R, requests: 1 },
      ].sort((a, b) => a.subject.localeCompare(b.subject) || a.day.localeCompare(b.day)),
    )
  })

  test('two members racing to take one over: one has it, and only one day is charged', async () => {
    await article()
    await another(2)
    await setting('member.translationsPerDay', 1)
    await askJson(zh(1))
    await askJson(zh(2))
    const b = await signedIn(api, 'b@x.test')
    const c = await signedIn(api, 'c@x.test')
    const answers = await Promise.all([askJson(zh(2), b), askJson(zh(2), c)])
    expect(answers.map((a) => a.status).sort()).toEqual(['in_progress', 'requested'])
    const winner = answers[0]?.status === 'requested' ? b : c
    expect((await owner('ckey2'))?.requested_by).toBe(winner.userId)
    const today = await db.all(sql`
      select subject, reserved, requests from usage_daily
      where day = ${utcDay(api.clock.now())} and subject in (${b.userId}, ${c.userId})
    `)
    expect(today).toEqual([{ subject: winner.userId, reserved: R, requests: 1 }])
  })

  test('opening a waiting post too often this hour is told it waits, not refused', async () => {
    await article()
    await another(2)
    await setting('member.translationsPerDay', 1)
    await askJson(zh(1))
    await askJson(zh(2))
    const hour = 3600_000
    const windowStart = Math.floor(api.clock.now() / hour) * hour
    await db.run(sql`insert into action_limits (key, window_start, count)
      values (${`translate:${reader.userId}`}, ${windowStart}, ${ACTION_LIMITS.translate.limit})
      on conflict (key, window_start) do update set count = excluded.count`)
    expect(await askJson(zh(2))).toMatchObject({ code: 200, status: 'scheduled' })
  })
})

describe('the reservation', () => {
  test('leans high, and stops at the per-article ceiling', () => {
    expect(reservationFor(1000, 'ja')).toBe(2000)
    expect(reservationFor(4000, 'en')).toBe(2000)
    expect(reservationFor(10_000_000, 'zh-Hans')).toBe(40_000)
  })

  test('is none between the two Chinese scripts, whichever way', () => {
    expect(isScriptConversion('zh-Hans', 'zh-Hant')).toBe(true)
    expect(isScriptConversion('zh-Hant', 'zh-Hans')).toBe(true)
    expect(isScriptConversion('en', 'zh-Hant')).toBe(false)
    expect(isScriptConversion(null, 'zh-Hans')).toBe(false)
    expect(isScriptConversion('zh-Hans', 'zh-Hans')).toBe(false)
  })
})
