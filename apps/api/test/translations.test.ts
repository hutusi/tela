import { beforeEach, describe, expect, test } from 'bun:test'
import { ACTION_LIMITS, bumpSeq, currentSeq, first, type TelaDb, utcDay } from '@tela/data'
import { USER_DAILY_TRANSLATION_TOKENS } from '@tela/shared'
import { CLIENT_HEADER, MIN_CLIENT, type PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { reservationFor } from '../src/routes/translations'
import { createTestApi, signedIn, type TestApi } from './helpers'

let api: TestApi
let db: TelaDb
let reader: { cookie: string; userId: string }

async function article(options: { optOut?: boolean; lang?: string; chars?: number } = {}) {
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, translation_opt_out, created_at, updated_at, seq)
      values (1, 'https://blog.example', ${options.optOut ? 1 : 0}, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (1, 1, 'https://blog.example/feed', 'blog.example', 0, 0, 0, ${currentSeq})`),
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, source_lang,
        current_version, content_key, seq)
      values (1, 1, 'k1', 'はじめに', 0, 0, ${options.lang ?? 'ja'}, 1, 'ckey1', ${currentSeq})`),
    db.run(sql`insert into article_versions (article_id, version, provenance, content_key, norm_version,
        body_chars, created_at)
      values (1, 1, 'feed', 'ckey1', 1, ${options.chars ?? 2000}, 0)`),
  ] as never)
}

const ask = (body: Record<string, unknown> = { articleId: 1, lang: 'zh-Hans' }) =>
  api.request('/api/v1/translations', { body, cookie: reader.cookie })
const askJson = async (body?: Record<string, unknown>) => {
  const res = await ask(body)
  return { code: res.status, ...((await res.json()) as { status: string; translation: unknown }) }
}
const usage = () =>
  first<{ reserved: number; used: number }>(
    db,
    sql`select reserved, used from usage_daily where subject = ${reader.userId}`,
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

  test('a failed one may be asked for again', async () => {
    await article()
    await db.run(sql`insert into body_translations (content_key, lang, state, updated_at)
      values ('ckey1', 'zh-Hans', 'failed', 0)`)
    expect((await askJson()).status).toBe('requested')
  })

  test('a blog that opted out is refused before anything is counted or reserved', async () => {
    await article({ optOut: true })
    expect((await askJson()).status).toBe('unavailable')
    expect(await usage()).toBeUndefined()
    expect(await first(db, sql`select 1 as x from action_limits`)).toBeUndefined()
    expect(api.jobs.sent).toEqual([])
  })

  test('an article already in the language, or an unknown language, is invalid', async () => {
    await article({ lang: 'zh-Hans' })
    expect((await askJson()).status).toBe('invalid')
    expect((await askJson({ articleId: 1, lang: 'fr' })).code).toBe(400)
    expect((await askJson({ articleId: 99, lang: 'en' })).code).toBe(404)
  })

  test("the member's day is a ceiling: past it, nothing is requested", async () => {
    await article()
    await db.run(sql`insert into usage_daily (subject, day, reserved, used)
      values (${reader.userId}, ${utcDay(api.clock.now())}, 0, ${USER_DAILY_TRANSLATION_TOKENS - 100})`)
    expect((await askJson()).status).toBe('budget_exhausted')
    expect(await first(db, sql`select 1 as x from body_translations`)).toBeUndefined()
    expect(api.jobs.sent).toEqual([])
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

  test('the status route shows what exists now, and the row syncs to the reader', async () => {
    await article()
    await db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, seq)
      values (${reader.userId}, 1, 0, 0, 0)`)
    const client = { [CLIENT_HEADER]: String(MIN_CLIENT) }
    const snap = (await (
      await api.request('/api/v1/sync?cursor=0', { cookie: reader.cookie, headers: client })
    ).json()) as PullResponse
    await askJson()
    const status = await api.request('/api/v1/translations/ckey1/zh-Hans', {
      cookie: reader.cookie,
    })
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(await status.json()).toEqual({
      contentKey: 'ckey1',
      lang: 'zh-Hans',
      state: 'requested',
      chunkKeys: [],
      objectKey: null,
      failedLeaves: [],
    })
    const delta = (await (
      await api.request(`/api/v1/sync?cursor=${snap.cursor}`, {
        cookie: reader.cookie,
        headers: client,
      })
    ).json()) as PullResponse
    expect(delta.rows.translations).toMatchObject([{ contentKey: 'ckey1', state: 'requested' }])
  })
})

describe('the reservation', () => {
  test('leans high, and stops at the per-article ceiling', () => {
    expect(reservationFor(1000, 'ja')).toBe(2000)
    expect(reservationFor(4000, 'en')).toBe(2000)
    expect(reservationFor(10_000_000, 'zh-Hans')).toBe(40_000)
  })
})
