import { beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, first, headSeq, type TelaDb } from '@tela/data'
import { MEMBER_HEADER, type PullResponse, type PushResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

const DAY = 24 * 60 * 60 * 1000

let api: TestApi
let db: TelaDb
let now: number
let reader: SignedIn

/** Write in one batch that bumps the sync sequence, as every writer of synced rows does. */
async function write(...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

async function addFeed(n: number) {
  await write(
    db.run(sql`insert into sites (id, home_url, title, created_at, updated_at, seq)
      values (${n}, ${`https://blog${n}.example`}, ${`Blog ${n}`}, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (${n}, ${n}, ${`https://blog${n}.example/feed`}, ${`blog${n}.example`}, 0, 0, 0, ${currentSeq})`),
  )
}

let nextArticle = 1
async function addArticle(feedId: number, fetchedAt = now) {
  const id = nextArticle++
  await write(
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, content_key, seq)
      values (${id}, ${feedId}, ${`k${id}`}, ${`Post ${id}`}, ${fetchedAt}, ${fetchedAt}, ${`c${id}`}, ${currentSeq})`),
  )
  return id
}

const pull = async (cursor: number, as = reader) => {
  const res = await api.request(`/api/v1/sync?cursor=${cursor}`, { as })
  expect(res.status).toBe(200)
  return (await res.json()) as PullResponse
}

let mids = 0
const push = async (mutations: Record<string, unknown>[], as = reader) => {
  const res = await api.request('/api/v1/mutations', {
    body: {
      mutations: mutations.map((m) => ({ mid: `mid-${++mids}-padding`, at: now, ...m })),
    },
    as,
  })
  expect(res.status).toBe(200)
  return (await res.json()) as PushResponse
}

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  now = api.clock.now()
  nextArticle = 1
  reader = await signedIn(api, 'reader@x.test')
  await addFeed(1)
  await addFeed(2)
})

describe('pull', () => {
  test('a snapshot is the horizon of the feeds subscribed to, and nothing else', async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    const recent = [await addArticle(1), await addArticle(1)]
    await addArticle(1, now - 40 * DAY) // past the horizon
    await addArticle(2) // another feed
    const snap = await pull(0)
    expect(snap.reset).toBe(true)
    expect(snap.more).toBe(false)
    expect(snap.rows.articles.map((a) => a.id).sort()).toEqual(recent)
    expect(snap.rows.feeds.map((f) => f.id)).toEqual([1])
    expect(snap.rows.sites).toMatchObject([{ id: 1, title: 'Blog 1', owned: false }])
    expect(snap.rows.subscriptions).toMatchObject([{ feedId: 1, watermarkId: 0, deletedAt: null }])
    expect(snap.rows.profile).toHaveLength(1)
    expect(snap.cursor).toBe(await headSeq(db))
  })

  test('a delta carries only what changed since the cursor', async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    await addArticle(1)
    const snap = await pull(0)
    const fresh = await addArticle(1)
    await addArticle(2)
    const delta = await pull(snap.cursor)
    expect(delta.reset).toBe(false)
    expect(delta.rows.articles.map((a) => a.id)).toEqual([fresh])
    expect(delta.rows.subscriptions).toEqual([])
    expect(delta.cursor).toBeGreaterThan(snap.cursor)
    expect((await pull(delta.cursor)).rows.articles).toEqual([])
  })

  test('a new subscription brings its feed whole, though its articles are older than the cursor', async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    const older = [await addArticle(2), await addArticle(2)]
    const snap = await pull(0)
    await push([{ type: 'subscribe', feedId: 2 }])
    const delta = await pull(snap.cursor)
    expect(delta.rows.subscriptions).toMatchObject([{ feedId: 2, deletedAt: null }])
    expect(delta.rows.articles.map((a) => a.id).sort()).toEqual(older)
    expect(delta.rows.feeds.map((f) => f.id)).toEqual([2])
    expect(delta.rows.sites.map((s) => s.id)).toContain(2)
  })

  test('after unsubscribing, the feed stops flowing', async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    const snap = await pull(0)
    await push([{ type: 'unsubscribe', feedId: 1 }])
    const gone = await pull(snap.cursor)
    expect(gone.rows.subscriptions).toMatchObject([{ feedId: 1, deletedAt: expect.any(Number) }])
    await addArticle(1)
    expect((await pull(gone.cursor)).rows.articles).toEqual([])
  })

  test('a liked article stays with the reader after they unsubscribe, with its feed and blog', async () => {
    await push([{ type: 'subscribe', feedId: 2 }])
    const liked = await addArticle(2)
    await push([{ type: 'setLiked', articleId: liked, liked: true }])
    await push([{ type: 'unsubscribe', feedId: 2 }])
    const snap = await pull(0)
    expect(snap.rows.articles.map((a) => a.id)).toEqual([liked])
    expect(snap.rows.feeds.map((f) => f.id)).toEqual([2])
    expect(snap.rows.sites.map((s) => s.id)).toEqual([2])
    expect(snap.rows.states).toMatchObject([{ articleId: liked, likedAt: now }])
  })

  test('a kept article from a feed no longer followed still gets its translations as they land', async () => {
    await push([{ type: 'subscribe', feedId: 2 }])
    const liked = await addArticle(2)
    await push([{ type: 'setLiked', articleId: liked, liked: true }])
    await push([{ type: 'unsubscribe', feedId: 2 }])
    const before = await pull(0)
    // Its title and its body are translated after the device last pulled.
    await write(
      db.run(sql`insert into article_titles (article_id, lang, feed_id, title, status, source_hash,
          updated_at, seq)
        values (${liked}, 'zh-Hans', 2, '译题', 'done', 'h', ${now}, ${currentSeq})`),
      db.run(sql`insert into body_translations (content_key, lang, state, updated_at, seq)
        values (${`c${liked}`}, 'zh-Hans', 'done', ${now}, ${currentSeq})`),
    )
    const delta = await pull(before.cursor)
    expect(delta.rows.titles.map((t) => [t.articleId, t.lang])).toEqual([[liked, 'zh-Hans']])
    expect(delta.rows.translations.map((t) => [t.contentKey, t.lang])).toEqual([
      [`c${liked}`, 'zh-Hans'],
    ])
  })

  test("never another member's rows", async () => {
    const other = await signedIn(api, 'other@x.test')
    await push([{ type: 'subscribe', feedId: 1 }], other)
    const a = await addArticle(1)
    await push([{ type: 'setLiked', articleId: a, liked: true }], other)
    const mine = await pull(0)
    expect(mine.rows.subscriptions).toEqual([])
    expect(mine.rows.articles).toEqual([])
    expect(mine.rows.states).toEqual([])
    expect(mine.rows.profile).toHaveLength(1)
  })

  test('an old client is told to upgrade, and a bad cursor is refused', async () => {
    const res = await api.request('/api/v1/sync?cursor=0', { cookie: reader.cookie })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'upgrade' })
    const bad = await api.request('/api/v1/sync?cursor=-1', { as: reader })
    expect(bad.status).toBe(400)
  })

  test('a cursor from the future (a restored database) starts the client over', async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    const res = await pull(10_000)
    expect(res.reset).toBe(true)
    expect(res.rows.subscriptions).toHaveLength(1)
  })
})

describe('push', () => {
  beforeEach(async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
  })

  const state = (articleId: number) =>
    first<{ read_at: number | null; liked_at: number | null; seq: number }>(
      db,
      sql`select read_at, liked_at, seq from user_article_states where article_id = ${articleId}`,
    )
  const likes = async (id: number) =>
    (await first<{ n: number }>(db, sql`select like_count as n from articles where id = ${id}`))?.n

  test('reading, liking and their counts, as the next pull shows them', async () => {
    const snap = await pull(0)
    const a = await addArticle(1)
    const res = await push([
      { type: 'markRead', articleId: a },
      { type: 'setLiked', articleId: a, liked: true },
    ])
    expect(res.applied).toHaveLength(2)
    expect(res.rejected).toEqual([])
    const delta = await pull(snap.cursor)
    expect(delta.rows.states).toMatchObject([{ articleId: a, readAt: now, likedAt: now }])
    expect(delta.rows.articles).toMatchObject([{ id: a, likeCount: 1 }])
    expect(res.seq).toBe(delta.cursor)
  })

  test('a replayed push changes nothing', async () => {
    const a = await addArticle(1)
    const body = {
      mutations: [{ mid: 'replayed-mid-1', at: now, type: 'setLiked', articleId: a, liked: true }],
    }
    const send = () => api.request('/api/v1/mutations', { body, as: reader })
    await send()
    const before = await state(a)
    const again = (await (await send()).json()) as PushResponse
    expect(again.applied).toEqual(['replayed-mid-1'])
    expect(await state(a)).toEqual(before!)
    expect(await likes(a)).toBe(1)
  })

  test('a replay of an older push cannot undo a newer one', async () => {
    // setProfile has no timestamp to compare; only the applied-mutation guard stops the revert.
    const older = { mid: 'profile-older-mid', at: now, type: 'setProfile', readingLang: 'en' }
    const send = (m: Record<string, unknown>) =>
      api.request('/api/v1/mutations', { body: { mutations: [m] }, as: reader })
    await send(older)
    await send({ mid: 'profile-newer-mid', at: now, type: 'setProfile', readingLang: 'zh-Hans' })
    await send(older) // the response to the first was lost; the client sends it again
    const profile = await first<{ reading_lang: string }>(
      db,
      sql`select reading_lang from profiles`,
    )
    expect(profile?.reading_lang).toBe('zh-Hans')
  })

  test('two devices: the later like wins, whatever order they arrive in', async () => {
    const a = await addArticle(1)
    await push([{ type: 'setLiked', articleId: a, liked: false, at: now - 1000 }])
    await push([{ type: 'setLiked', articleId: a, liked: true, at: now - 5000 }]) // older, arrives later
    expect((await state(a))?.liked_at).toBeNull()
    await push([{ type: 'setLiked', articleId: a, liked: true, at: now }])
    expect((await state(a))?.liked_at).toBe(now)
    expect(await likes(a)).toBe(1)
  })

  test('a device clock in the future cannot win every argument', async () => {
    const a = await addArticle(1)
    await push([{ type: 'setLiked', articleId: a, liked: true, at: now + 365 * DAY }])
    expect((await state(a))?.liked_at).toBe(now)
    api.clock.advance(1000)
    now = api.clock.now()
    await push([{ type: 'setLiked', articleId: a, liked: false, at: now }])
    expect((await state(a))?.liked_at).toBeNull()
  })

  test('a mutation naming a missing article is a no-op, not an error for the whole push', async () => {
    const a = await addArticle(1)
    const res = await push([
      { type: 'markRead', articleId: 9999 },
      { type: 'markRead', articleId: a },
    ])
    expect(res.applied).toHaveLength(2)
    expect((await state(a))?.read_at).toBe(now)
    expect(
      await first(db, sql`select 1 as x from user_article_states where article_id = 9999`),
    ).toBeUndefined()
  })

  test('invalid mutations are refused one by one; the rest apply', async () => {
    const a = await addArticle(1)
    const res = await push([
      { type: 'markRead', articleId: a },
      { type: 'setLiked', articleId: 'one' },
      { type: 'setPref', key: 'Bad Key', value: 1 },
      { type: 'setPref', key: 'reader.theme', value: 'x'.repeat(3000) },
    ])
    expect(res.applied).toHaveLength(1)
    expect(res.rejected.map((r) => r.error)).toEqual(['invalid', 'invalid', 'pref_too_large'])
  })

  test('mark all read moves the watermark to what was displayed, never past what exists', async () => {
    const [a, b] = [await addArticle(1), await addArticle(1)]
    await addArticle(1) // arrives after the reader looked
    await push([{ type: 'markAllRead', feedId: 1, upTo: b }])
    const sub = () =>
      first<{ watermark_id: number }>(
        db,
        sql`select watermark_id from subscriptions where feed_id = 1`,
      )
    expect((await sub())?.watermark_id).toBe(b)
    await push([{ type: 'markAllRead', upTo: 1_000_000 }])
    expect((await sub())?.watermark_id).toBe(b + 1)
    await push([{ type: 'markAllRead', feedId: 1, upTo: a }])
    expect((await sub())?.watermark_id).toBe(b + 1) // never backwards
  })

  test('prefs, profile and recommendations round-trip through a pull', async () => {
    const snap = await pull(0)
    const a = await addArticle(1)
    await push([
      { type: 'setPref', key: 'reader.theme', value: { mode: 'dark' } },
      { type: 'setProfile', readingLang: 'zh-Hans' },
      { type: 'recommend', articleId: a, note: '  worth it  ' },
    ])
    const delta = await pull(snap.cursor)
    expect(delta.rows.prefs).toMatchObject([{ key: 'reader.theme', value: { mode: 'dark' } }])
    expect(delta.rows.profile).toMatchObject([{ readingLang: 'zh-Hans' }])
    expect(delta.rows.recommendations).toMatchObject([
      { articleId: a, note: 'worth it', deletedAt: null },
    ])
    expect(delta.rows.articles).toMatchObject([{ id: a, recommendCount: 1 }])
    await push([{ type: 'unrecommend', articleId: a }])
    const after = await pull(delta.cursor)
    expect(after.rows.recommendations).toMatchObject([{ articleId: a, deletedAt: now }])
    expect(after.rows.articles).toMatchObject([{ id: a, recommendCount: 0 }])
  })

  test('subscribing counts the reader on the blog', async () => {
    const readers = async () =>
      (await first<{ n: number }>(db, sql`select reader_count as n from sites where id = 2`))?.n
    await push([{ type: 'subscribe', feedId: 2 }])
    expect(await readers()).toBe(1)
    await push([{ type: 'unsubscribe', feedId: 2 }])
    expect(await readers()).toBe(0)
  })

  test('without a session, nothing', async () => {
    const res = await api.request('/api/v1/mutations', {
      body: { mutations: [] },
      headers: reader.headers,
    })
    expect(res.status).toBe(401)
  })
})

describe('highlights', () => {
  const KEY = 'a'.repeat(32)
  const highlight = (id: string, articleId: number, over: Record<string, unknown> = {}) => ({
    type: 'putHighlight',
    id,
    articleId,
    contentKey: KEY,
    side: 'original',
    lang: null,
    leafId: 'abcdef0123',
    start: 4,
    end: 9,
    quote: 'quick',
    prefix: 'The ',
    suffix: ' brown',
    note: null,
    ...over,
  })

  test('a highlight and its note round-trip, and deleting it sends the deletion', async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    const a = await addArticle(1)
    const head = (await pull(0)).cursor
    await push([highlight('hl-one-0001', a)])
    now += 10
    await push([highlight('hl-one-0001', a, { note: '  worth it  ' })])
    const delta = await pull(head)
    expect(delta.rows.highlights).toMatchObject([
      {
        id: 'hl-one-0001',
        articleId: a,
        leafId: 'abcdef0123',
        start: 4,
        end: 9,
        quote: 'quick',
        note: 'worth it',
        deletedAt: null,
      },
    ])
    expect((await pull(0)).rows.highlights).toHaveLength(1)
    now += 10
    await push([{ type: 'deleteHighlight', id: 'hl-one-0001' }])
    const deleted = (await pull(delta.cursor)).rows.highlights
    expect(deleted.map((h) => h.id)).toEqual(['hl-one-0001'])
    expect(deleted[0]?.deletedAt).not.toBeNull()
    expect((await pull(0)).rows.highlights).toEqual([])
  })

  test('deleting wins: a later edit from another device does not bring it back', async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    const a = await addArticle(1)
    await push([highlight('hl-two-0001', a)])
    now += 10
    await push([{ type: 'deleteHighlight', id: 'hl-two-0001' }])
    now += 10
    await push([highlight('hl-two-0001', a, { note: 'edited elsewhere' })])
    const row = await first<{ deleted_at: number | null; note: string | null }>(
      db,
      sql`select deleted_at, note from highlights where id = 'hl-two-0001'`,
    )
    expect(row).toMatchObject({ note: null })
    expect(row?.deleted_at).not.toBeNull()
  })

  test("an id taken from another member's highlight cannot rewrite it", async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    const a = await addArticle(1)
    await push([highlight('hl-mine-001', a, { note: 'mine' })])
    const other = await signedIn(api, 'other@x.test')
    now += 10
    await push([highlight('hl-mine-001', a, { note: 'theirs' })], other)
    await push([{ type: 'deleteHighlight', id: 'hl-mine-001' }], other)
    const row = await first<{ user_id: string; note: string; deleted_at: number | null }>(
      db,
      sql`select user_id, note, deleted_at from highlights where id = 'hl-mine-001'`,
    )
    expect(row).toEqual({ user_id: reader.userId, note: 'mine', deleted_at: null })
    expect((await pull(0, other)).rows.highlights).toEqual([])
  })

  test('an empty range, or a quote that is not the range, is refused', async () => {
    const a = await addArticle(1)
    const res = await push([
      highlight('hl-bad-0001', a, { start: 5, end: 5, quote: 'x' }),
      highlight('hl-bad-0002', a, { start: 0, end: 3, quote: 'quick' }),
    ])
    expect(res.rejected.map((r) => r.error)).toEqual(['invalid_range', 'invalid_range'])
  })

  test('a highlighted article stays with the reader after they unsubscribe, with its feed', async () => {
    await push([{ type: 'subscribe', feedId: 1 }])
    const a = await addArticle(1)
    await addArticle(1)
    await push([highlight('hl-kept-001', a)])
    const head = (await pull(0)).cursor
    await push([{ type: 'unsubscribe', feedId: 1 }])
    expect((await pull(0)).rows.articles.map((x) => x.id)).toEqual([a])
    // Highlighting a post of a feed never subscribed brings it whole.
    const b = await addArticle(2)
    await push([highlight('hl-kept-002', b)])
    const delta = await pull(head)
    expect(delta.rows.articles.map((x) => x.id)).toContain(b)
    expect(delta.rows.feeds.map((f) => f.id)).toContain(2)
  })
})

describe('a feed merged into another (ADR 0028)', () => {
  test('a device that still knows it subscribes and unsubscribes the feed it merged into', async () => {
    await db.run(sql`update feeds set status = 'paused', merged_into = 1, site_id = 1 where id = 2`)
    const following = () =>
      db.all<{ feed_id: number }>(
        sql`select feed_id from subscriptions where user_id = ${reader.userId} and deleted_at is null`,
      )
    await push([{ type: 'subscribe', feedId: 2 }])
    expect(await following()).toEqual([{ feed_id: 1 }])
    await push([{ type: 'unsubscribe', feedId: 2 }])
    expect(await following()).toEqual([])
  })
})

describe('a device holding another account (another tab switched)', () => {
  test('a pull or a push naming someone else is refused, and the push applies nothing', async () => {
    const other = { [MEMBER_HEADER]: 'u_someone_else' }
    const res = await api.request('/api/v1/sync?cursor=0', { as: reader, headers: other })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'account_changed' })
    const pushed = await api.request('/api/v1/mutations', {
      body: { mutations: [{ mid: 'mid-other-account', at: now, type: 'subscribe', feedId: 1 }] },
      as: reader,
      headers: other,
    })
    expect(pushed.status).toBe(409)
    expect(await db.all(sql`select 1 from subscriptions`)).toEqual([])

    expect((await api.request('/api/v1/sync?cursor=0', { as: reader })).status).toBe(200)
  })
})
