import { beforeEach, describe, expect, test } from 'bun:test'
import {
  bumpSeq,
  compactReadStates,
  currentSeq,
  first,
  headSeq,
  mergeFeed,
  readPull,
  type TelaDb,
} from '@tela/data'
import {
  type ArticleRow,
  applyPull,
  type Confirmed,
  emptyTables,
  MEMBER_HEADER,
  type Mutation,
  type Pending,
  type PullResponse,
  type PushResponse,
  privacyChange,
  privacyUnsettled,
  settle,
  view,
} from '@tela/sync'
import { sql } from 'drizzle-orm'
import { isRead } from '../../reader/src/store/selectors'
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

  describe('a kept post of a feed left, whose read state was compacted', () => {
    /** A post of feed 2 read by its watermark, then the feed left and its read state compacted. */
    async function readThenLeft() {
      await push([{ type: 'subscribe', feedId: 2 }])
      const a = await addArticle(2)
      await push([
        { type: 'markRead', articleId: a },
        { type: 'markAllRead', feedId: 2, upTo: a },
      ])
      await push([{ type: 'unsubscribe', feedId: 2 }])
      return a
    }
    const shownRead = (pulls: PullResponse[], a: number) => {
      let device: Confirmed = { cursor: 0, tables: emptyTables() }
      for (const p of pulls) device = applyPull(device, p)
      const article = device.tables.articles.get(a)
      expect(article).toBeDefined()
      return isRead(device.tables, article as ArticleRow, now)
    }

    test("a snapshot sends the left feed's subscription, and the device shows the post read", async () => {
      const a = await readThenLeft()
      await push([{ type: 'recommend', articleId: a, note: null }])
      await compactReadStates(db)
      const snap = await pull(0)
      expect(snap.rows.states).toEqual([])
      expect(snap.rows.subscriptions).toMatchObject([
        { feedId: 2, deletedAt: expect.any(Number), watermarkId: a },
      ])
      expect(shownRead([snap], a)).toBe(true)
    })

    test('a delta sends it with a post kept since, to a device that never held it', async () => {
      const a = await readThenLeft()
      await compactReadStates(db)
      const snap = await pull(0)
      expect(snap.rows.subscriptions).toEqual([])
      await push([{ type: 'recommend', articleId: a, note: null }])
      const delta = await pull(snap.cursor)
      expect(delta.rows.articles.map((x) => x.id)).toEqual([a])
      expect(delta.rows.subscriptions).toMatchObject([
        { feedId: 2, deletedAt: expect.any(Number), watermarkId: a },
      ])
      expect(shownRead([snap, delta], a)).toBe(true)
    })
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
    // Both made at the same `at`, so the clocks cannot tell them apart; the applied-mutation
    // guard is what stops the replay reverting the newer one.
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

  test('two devices: each language goes to the later choice, whatever order they arrive in', async () => {
    const languages = () =>
      first<{ ui_locale: string | null; reading_lang: string | null }>(
        db,
        sql`select ui_locale, reading_lang from profiles`,
      )
    await push([{ type: 'setProfile', uiLocale: 'fr', readingLang: 'fr', at: now - 1000 }])
    // A device offline since before that choice made its own, and pushes only now.
    await push([{ type: 'setProfile', uiLocale: 'en', readingLang: 'en', at: now - 5000 }])
    expect(await languages()).toEqual({ ui_locale: 'fr', reading_lang: 'fr' })
    // Each on its own clock: a later interface choice does not carry an older reading one.
    await push([{ type: 'setProfile', uiLocale: 'zh-Hant', at: now }])
    await push([{ type: 'setProfile', readingLang: 'en', at: now - 3000 }])
    expect(await languages()).toEqual({ ui_locale: 'zh-Hant', reading_lang: 'fr' })
  })

  test('a reading language of null follows the interface, and one left out is left alone', async () => {
    const languages = () =>
      first<{ ui_locale: string | null; reading_lang: string | null; reading_lang_at: number }>(
        db,
        sql`select ui_locale, reading_lang, reading_lang_at from profiles`,
      )
    await push([{ type: 'setProfile', uiLocale: 'en', readingLang: 'zh-Hans', at: now - 2000 }])
    await push([{ type: 'setProfile', readingLang: null, at: now - 1000 }])
    expect(await languages()).toEqual({
      ui_locale: 'en',
      reading_lang: null,
      reading_lang_at: now - 1000,
    })
    await push([{ type: 'setProfile', uiLocale: 'fr', at: now }])
    expect(await languages()).toEqual({
      ui_locale: 'fr',
      reading_lang: null,
      reading_lang_at: now - 1000,
    })
    const delta = await pull(0)
    expect(delta.rows.profile).toMatchObject([
      { uiLocale: 'fr', readingLang: null, uiLocaleAt: now, readingLangAt: now - 1000 },
    ])
  })

  describe("adopting a visitor's language or theme, from a copy that may be stale", () => {
    const locale = () =>
      first<{ ui_locale: string | null; ui_locale_at: number }>(
        db,
        sql`select ui_locale, ui_locale_at from profiles`,
      )
    const theme = () =>
      first<{ value_json: string; updated_at: number }>(
        db,
        sql`select value_json, updated_at from user_prefs where key = 'ui.theme'`,
      )

    test('a language is written only while the account has none, and any choice beats it', async () => {
      const snap = await pull(0)
      await push([{ type: 'setProfile', uiLocale: 'fr', adopt: true }])
      expect(await locale()).toEqual({ ui_locale: 'fr', ui_locale_at: 0 })
      // Stamped, so the device that adopted hears what the account holds.
      expect((await pull(snap.cursor)).rows.profile).toMatchObject([{ uiLocale: 'fr' }])
      // Another browser's cookie, adopted later: the account has one now.
      await push([{ type: 'setProfile', uiLocale: 'zh-Hans', adopt: true }])
      expect(await locale()).toEqual({ ui_locale: 'fr', ui_locale_at: 0 })
      // A choice made before the adoption and pushed after it still wins: adopting chose nothing.
      await push([{ type: 'setProfile', uiLocale: 'en', at: now - 5000 }])
      expect(await locale()).toEqual({ ui_locale: 'en', ui_locale_at: now - 5000 })
    })

    test('a stale copy adopting over a language chosen elsewhere since changes nothing', async () => {
      await push([{ type: 'setProfile', uiLocale: 'en', at: now - 1000 }])
      // Its `at` is the later; a write by `at` alone would have taken the account back.
      await push([{ type: 'setProfile', uiLocale: 'fr', adopt: true, at: now }])
      expect(await locale()).toEqual({ ui_locale: 'en', ui_locale_at: now - 1000 })
    })

    test('a theme is written only where the account has no row, and any choice beats it', async () => {
      const snap = await pull(0)
      await push([{ type: 'setPref', key: 'ui.theme', value: 'dark', ifAbsent: true }])
      expect(await theme()).toEqual({ value_json: '"dark"', updated_at: 0 })
      expect((await pull(snap.cursor)).rows.prefs).toMatchObject([
        { key: 'ui.theme', value: 'dark' },
      ])
      await push([{ type: 'setPref', key: 'ui.theme', value: 'light', ifAbsent: true }])
      expect(await theme()).toEqual({ value_json: '"dark"', updated_at: 0 })
      await push([{ type: 'setPref', key: 'ui.theme', value: 'system', at: now - 5000 }])
      expect(await theme()).toEqual({ value_json: '"system"', updated_at: now - 5000 })
      // And a stale copy adopting over that choice changes nothing, whatever its `at`.
      await push([{ type: 'setPref', key: 'ui.theme', value: 'dark', ifAbsent: true }])
      expect(await theme()).toEqual({ value_json: '"system"', updated_at: now - 5000 })
    })
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

  test('an unlike outlives compaction, so a like made before it and pushed after still loses', async () => {
    const a = await addArticle(1)
    await push([{ type: 'setLiked', articleId: a, liked: true, at: now - 3000 }])
    await push([{ type: 'setLiked', articleId: a, liked: false, at: now - 1000 }])
    await push([{ type: 'markAllRead', feedId: 1, upTo: a }])
    await compactReadStates(db)
    // A device offline since before the unlike liked it too, and pushes only now.
    await push([{ type: 'setLiked', articleId: a, liked: true, at: now - 2000 }])
    expect((await state(a))?.liked_at).toBeNull()
    expect(await likes(a)).toBe(0)
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

  describe('a post marked unread (ADR 0009)', () => {
    const states = (id: number) =>
      first<{ read_at: number | null; read_updated_at: number | null }>(
        db,
        sql`select read_at, read_updated_at from user_article_states where article_id = ${id}`,
      )
    /** Read or not, as a device that took a snapshot now shows it. */
    const shown = async (id: number) => {
      const device = applyPull({ cursor: 0, tables: emptyTables() }, await pull(0))
      const article = device.tables.articles.get(id)
      expect(article).toBeDefined()
      return isRead(device.tables, article as ArticleRow, now)
    }

    test('beats the watermark until it is read again, which keeps a clock', async () => {
      const [a, b] = [await addArticle(1), await addArticle(1)]
      await push([{ type: 'markRead', articleId: a, at: now - 40 }])
      await push([{ type: 'markAllRead', feedId: 1, upTo: b, at: now - 30 }])
      expect([await shown(a), await shown(b)]).toEqual([true, true])
      // One read by hand, one only by the watermark, which has no row to change.
      await push([
        { type: 'markUnread', articleId: a, at: now - 20 },
        { type: 'markUnread', articleId: b, at: now - 20 },
      ])
      expect(await states(a)).toEqual({ read_at: null, read_updated_at: now - 20 })
      expect(await states(b)).toEqual({ read_at: null, read_updated_at: now - 20 })
      expect([await shown(a), await shown(b)]).toEqual([false, false])
      // A first read keeps no clock; a read after an unread is a choice, and keeps its own.
      await push([{ type: 'markRead', articleId: a, at: now - 10 }])
      expect(await states(a)).toEqual({ read_at: now - 10, read_updated_at: now - 10 })
      expect(await shown(a)).toBe(true)
    })

    test('beats the horizon too', async () => {
      const old = await addArticle(1, now - 29 * DAY)
      // Kept, so a snapshot still sends it past the horizon; a recommendation reads nothing.
      await push([{ type: 'recommend', articleId: old, note: null }])
      api.clock.advance(2 * DAY)
      now = api.clock.now()
      expect(await shown(old)).toBe(true)
      await push([{ type: 'markUnread', articleId: old }])
      expect(await shown(old)).toBe(false)
    })

    test('an older read arriving after it loses, and an older unread after a read', async () => {
      const [a, b] = [await addArticle(1), await addArticle(1)]
      await push([{ type: 'markUnread', articleId: a, at: now - 10 }])
      await push([{ type: 'markRead', articleId: a, at: now - 20 }]) // made before, pushed after
      expect(await states(a)).toEqual({ read_at: null, read_updated_at: now - 10 })
      await push([{ type: 'markRead', articleId: a, at: now - 5 }])
      await push([{ type: 'markUnread', articleId: a, at: now - 8 }])
      expect(await states(a)).toEqual({ read_at: now - 5, read_updated_at: now - 5 })
      // Against a first read, its own time is the clock.
      await push([{ type: 'markRead', articleId: b, at: now - 10 }])
      await push([{ type: 'markUnread', articleId: b, at: now - 20 }])
      expect(await states(b)).toEqual({ read_at: now - 10, read_updated_at: null })
    })

    test('mark all read reads one marked before it, not one marked since', async () => {
      await push([{ type: 'subscribe', feedId: 2 }])
      const [a, b, other] = [await addArticle(1), await addArticle(1), await addArticle(2)]
      const after = await addArticle(1) // past what the list showed
      await push([
        { type: 'markUnread', articleId: a, at: now - 30 },
        { type: 'markUnread', articleId: b, at: now - 10 },
        { type: 'markUnread', articleId: other, at: now - 30 },
        { type: 'markUnread', articleId: after, at: now - 30 },
      ])
      await push([{ type: 'markAllRead', feedId: 1, upTo: b, at: now - 20 }])
      expect(await states(a)).toEqual({ read_at: now - 20, read_updated_at: now - 20 })
      expect(await states(b)).toEqual({ read_at: null, read_updated_at: now - 10 })
      expect([await shown(a), await shown(b), await shown(other), await shown(after)]).toEqual([
        true,
        false,
        false,
        false,
      ])
      // Every feed, without one named.
      await push([{ type: 'markAllRead', upTo: after, at: now - 5 }])
      expect([await shown(b), await shown(other), await shown(after)]).toEqual([true, true, true])
    })

    test('a like does not read it', async () => {
      const [a, b] = [await addArticle(1), await addArticle(1)]
      await push([{ type: 'markUnread', articleId: a, at: now - 20 }])
      await push([{ type: 'setLiked', articleId: a, liked: true, at: now - 10 }])
      expect(await state(a)).toMatchObject({ read_at: null, liked_at: now - 10 })
      expect(await shown(a)).toBe(false)
      // Where the member chose nothing, liking reads, as ever.
      await push([{ type: 'setLiked', articleId: b, liked: true }])
      expect((await state(b))?.read_at).toBe(now)
    })

    test('compaction keeps it, and one read again after it, but not a plain read', async () => {
      const [a, b, c] = [await addArticle(1), await addArticle(1), await addArticle(1)]
      await push([{ type: 'markAllRead', feedId: 1, upTo: c, at: now - 50 }])
      await push([
        { type: 'markRead', articleId: a, at: now - 40 },
        { type: 'markUnread', articleId: b, at: now - 40 },
        { type: 'markUnread', articleId: c, at: now - 40 },
        { type: 'markRead', articleId: c, at: now - 30 },
      ])
      await compactReadStates(db)
      expect(await states(a)).toBeUndefined() // the watermark says it
      expect(await states(b)).toEqual({ read_at: null, read_updated_at: now - 40 })
      expect(await states(c)).toEqual({ read_at: now - 30, read_updated_at: now - 30 })
      expect([await shown(a), await shown(b), await shown(c)]).toEqual([true, false, true])
      // c's clock outlived compaction, so an unread made before the read and pushed after loses.
      await push([{ type: 'markUnread', articleId: c, at: now - 35 }])
      expect(await shown(c)).toBe(true)
    })
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

  test("a subscriber's device holds a blog's reader count only from three, and hears nothing below", async () => {
    const b = await signedIn(api, 'b@x.test')
    const c = await signedIn(api, 'c@x.test')
    const blog = (p: PullResponse) => p.rows.sites.filter((s) => s.id === 2)
    await push([{ type: 'subscribe', feedId: 2 }])
    const snap = await pull(0)
    // One reader: the count would say who reads it (ADR 0041), so the device holds 0.
    expect(blog(snap)).toMatchObject([{ readerCount: 0 }])
    // A second reader changes nothing a device holds, so the row is not sent again: its arrival
    // alone would tell the first reader that someone came.
    await push([{ type: 'subscribe', feedId: 2 }], b)
    const quiet = await pull(snap.cursor)
    expect(blog(quiet)).toEqual([])
    // A third: now the count is the device's to hold, and the community door lists the blog.
    await push([{ type: 'subscribe', feedId: 2 }], c)
    const third = await pull(quiet.cursor)
    expect(blog(third)).toMatchObject([{ readerCount: 3, listing: 'listed' }])
    // Down to two, the count is no longer one to show, and the device hears so.
    await push([{ type: 'unsubscribe', feedId: 2 }], c)
    expect(blog(await pull(third.cursor))).toMatchObject([{ readerCount: 0 }])
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

describe('follows (ADR 0031)', () => {
  const ANNA = 'member-anna-0000001'
  const BO = 'member-bo-000000002'
  /** A member who never signs in here: a user and a profile, written as the invite writes them. */
  async function person(id: string, handle: string) {
    await write(
      db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
        values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
      db.run(sql`insert into profiles (user_id, handle, display_name, created_at, updated_at, seq)
        values (${id}, ${handle}, ${handle.toUpperCase()}, 0, 0, ${currentSeq})`),
    )
  }
  beforeEach(async () => {
    await person(ANNA, 'anna')
    await person(BO, 'bobo')
  })

  test('a follow syncs to the follower only, carrying who they follow', async () => {
    const snap = await pull(0)
    await push([{ type: 'follow', userId: ANNA }])
    const delta = await pull(snap.cursor)
    expect(delta.rows.follows).toMatchObject([
      { userId: ANNA, handle: 'anna', displayName: 'ANNA', deletedAt: null },
    ])
    const other = await signedIn(api, 'other@x.test')
    expect((await pull(0, other)).rows.follows).toEqual([])
    expect((await pull(0)).rows.follows).toHaveLength(1)
  })

  test("a followee's new name is sent again; someone not followed is not", async () => {
    await push([{ type: 'follow', userId: ANNA }])
    const snap = await pull(0)
    await write(
      db.run(
        sql`update profiles set handle = 'anna_k', seq = ${currentSeq} where user_id = ${ANNA}`,
      ),
      db.run(
        sql`update profiles set display_name = 'Bobo B', seq = ${currentSeq} where user_id = ${BO}`,
      ),
    )
    const delta = await pull(snap.cursor)
    expect(delta.rows.follows).toMatchObject([{ userId: ANNA, handle: 'anna_k' }])
  })

  test('an unfollow is sent as a deletion, and a snapshot holds live follows only', async () => {
    await push([
      { type: 'follow', userId: ANNA, at: now - 10 },
      { type: 'follow', userId: BO, at: now - 10 },
    ])
    const snap = await pull(0)
    await push([{ type: 'unfollow', userId: ANNA }])
    const delta = await pull(snap.cursor)
    expect(delta.rows.follows).toMatchObject([{ userId: ANNA, deletedAt: now }])
    expect((await pull(0)).rows.follows.map((f) => f.userId)).toEqual([BO])
  })

  test('following yourself or nobody is a no-op, and the rest of the push applies', async () => {
    const res = await push([
      { type: 'follow', userId: reader.userId },
      { type: 'follow', userId: 'nobody-at-all-0001' },
      { type: 'follow', userId: BO },
    ])
    expect(res.rejected).toEqual([])
    expect((await pull(0)).rows.follows.map((f) => f.userId)).toEqual([BO])
  })

  test('two devices: the later of follow and unfollow wins, whatever order they arrive in', async () => {
    // Times in the past: `at` is clamped to the server's clock.
    const t = now - 100
    // Unfollowed later on one device, followed again earlier on another, arriving after.
    await push([{ type: 'follow', userId: ANNA, at: t }])
    await push([{ type: 'unfollow', userId: ANNA, at: t + 20 }])
    await push([{ type: 'follow', userId: ANNA, at: t + 10 }])
    expect((await pull(0)).rows.follows).toEqual([])
    // And the other way round: a follow made last wins over an older unfollow sent after it.
    await push([{ type: 'follow', userId: BO, at: t + 30 }])
    await push([{ type: 'unfollow', userId: BO, at: t + 25 }])
    expect((await pull(0)).rows.follows.map((f) => f.userId)).toEqual([BO])
  })

  test('an unfollow keeps its time even on a follow already gone, or never made', async () => {
    const t = now - 100
    // Unfollowed twice; an older follow from a third device arrives last.
    await push([{ type: 'follow', userId: ANNA, at: t }])
    await push([{ type: 'unfollow', userId: ANNA, at: t + 10 }])
    await push([{ type: 'unfollow', userId: ANNA, at: t + 30 }])
    await push([{ type: 'follow', userId: ANNA, at: t + 20 }])
    // Unfollowed where no follow ever reached the server; the older follow arrives after.
    await push([{ type: 'unfollow', userId: BO, at: t + 50 }])
    await push([{ type: 'follow', userId: BO, at: t + 40 }])
    expect((await pull(0)).rows.follows).toEqual([])
    // Following yourself, or nobody, is no tombstone either.
    const res = await push([
      { type: 'unfollow', userId: reader.userId },
      { type: 'unfollow', userId: 'nobody-at-all-0001' },
    ])
    expect(res.rejected).toEqual([])
  })

  test('an unfollow reaches a device that pages, though the followee renamed after it', async () => {
    await push([{ type: 'follow', userId: ANNA, at: now - 30 }])
    const before = await pull(0)
    await push([{ type: 'unfollow', userId: ANNA, at: now - 20 }])
    // Two changes after it, so a one-row page ends between them; then Anna renames.
    await push([
      { type: 'setPref', key: 'reader.size', value: 'l' },
      { type: 'setPref', key: 'reader.measure', value: 'wide' },
    ])
    await push([{ type: 'setPref', key: 'reader.mode', value: 'orig' }])
    await write(
      db.run(
        sql`update profiles set display_name = 'Anna K', seq = ${currentSeq} where user_id = ${ANNA}`,
      ),
    )
    const seen: unknown[] = []
    let cursor = before.cursor
    for (let page = 0; page < 10; page++) {
      const read = await readPull(db, { userId: reader.userId, cursor, horizon: 0, limit: 1 })
      seen.push(...read.rows.follows)
      if (read.pageEnd === null) break
      cursor = read.pageEnd
    }
    expect(seen).toMatchObject([{ userId: ANNA, deletedAt: now - 20 }])
  })

  test('unfollowing again sends the deletion again, to a device that missed it', async () => {
    await push([{ type: 'follow', userId: ANNA, at: now - 30 }])
    await push([{ type: 'unfollow', userId: ANNA, at: now - 20 }])
    const past = await pull(0) // a device whose cursor passed the deletion without keeping it
    await push([{ type: 'unfollow', userId: ANNA, at: now - 10 }])
    const again = await pull(past.cursor)
    expect(again.rows.follows).toMatchObject([{ userId: ANNA, deletedAt: now - 20 }])
    // Even from a device whose clock is behind the first unfollow.
    await push([{ type: 'unfollow', userId: ANNA, at: now - 25 }])
    expect((await pull(again.cursor)).rows.follows).toMatchObject([{ userId: ANNA }])
    // And still no follow comes back from an older one.
    await push([{ type: 'follow', userId: ANNA, at: now - 15 }])
    expect((await pull(0)).rows.follows).toEqual([])
  })

  test('the privacy switches are mutations, false included', async () => {
    const snap = await pull(0)
    await push([{ type: 'setPrivacy', publicSubscriptions: true, publicLikes: true, at: now - 50 }])
    const on = await pull(snap.cursor)
    expect(on.rows.profile).toMatchObject([{ publicSubscriptions: true, publicLikes: true }])
    await push([{ type: 'setPrivacy', publicLikes: false, at: now - 40 }])
    const off = await pull(on.cursor)
    expect(off.rows.profile).toMatchObject([{ publicSubscriptions: true, publicLikes: false }])
  })

  describe('a privacy show applies only against the version it saw (issue #16)', () => {
    const flags = async () => (await pull(0)).rows.profile[0]
    const clocks = () =>
      first<{ likes_at: number; subs_at: number }>(
        db,
        sql`select public_likes_at as likes_at, public_subscriptions_at as subs_at from profiles
          where user_id = ${reader.userId}`,
      )

    test('a hide made elsewhere lands first, and a show made before it is refused', async () => {
      const t = now - 1000
      // Device A, offline and with the right clock, shows the likes it holds hidden (version 0).
      const fromA = { type: 'setPrivacy', publicLikes: true, base: { publicLikes: 0 }, at: t + 300 }
      // Device B, whose clock runs slow, shows them and hides them again; both land first.
      await push([{ type: 'setPrivacy', publicLikes: true, base: { publicLikes: 0 }, at: t }])
      await push([{ type: 'setPrivacy', publicLikes: false, at: t + 50 }])
      expect(await flags()).toMatchObject({ publicLikes: false, publicLikesVersion: 2 })
      // A reconnects. Its show is the later by the clocks, and made against a version the hide
      // has passed: refused, but acknowledged and stamped, so A's next pull turns it back off.
      const snap = await pull(0)
      const res = await push([fromA])
      expect(res.applied).toHaveLength(1)
      const after = await pull(snap.cursor)
      expect(after.rows.profile).toMatchObject([{ publicLikes: false, publicLikesVersion: 2 }])
    })

    test('a show against the version its own hide made applies, whatever its clock says', async () => {
      // The device sends such a show only once the hide has come back in a pull (`privacyChange`).
      const t = now - 1000
      await push([{ type: 'setPrivacy', publicLikes: true, base: { publicLikes: 0 }, at: t }])
      // Offline, on a device whose clock runs behind: both older than the switch's clock.
      await push([
        { type: 'setPrivacy', publicLikes: false, at: t - 500 },
        { type: 'setPrivacy', publicLikes: true, base: { publicLikes: 2 }, at: t - 400 },
      ])
      expect(await flags()).toMatchObject({ publicLikes: true, publicLikesVersion: 3 })
      // The clock only ever moves forward, since a show without a base is still decided by it.
      expect((await clocks())?.likes_at).toBe(t)
    })

    test('a show without a base, from a shell before it, goes to the later `at`', async () => {
      const t = now - 1000
      await push([{ type: 'setPrivacy', publicSubscriptions: false, at: t + 200 }])
      await push([{ type: 'setPrivacy', publicSubscriptions: true, at: t + 100 }])
      expect(await flags()).toMatchObject({
        publicSubscriptions: false,
        publicSubscriptionsVersion: 1,
      })
      await push([{ type: 'setPrivacy', publicSubscriptions: true, at: t + 300 }])
      // One switch's change never touches the other's: likes keep their version and clock.
      expect(await flags()).toMatchObject({
        publicSubscriptions: true,
        publicSubscriptionsVersion: 2,
        publicLikes: false,
        publicLikesVersion: 0,
      })
      expect(await clocks()).toEqual({ likes_at: 0, subs_at: t + 300 })
    })

    test('an old hide arriving after a newer show turns the switch off, failing closed', async () => {
      const t = now - 1000
      await push([{ type: 'setPrivacy', publicLikes: true, base: { publicLikes: 0 }, at: t + 300 }])
      await push([{ type: 'setPrivacy', publicLikes: false, at: t + 250 }])
      expect(await flags()).toMatchObject({ publicLikes: false, publicLikesVersion: 2 })
      expect((await clocks())?.likes_at).toBe(t + 300)
      // The member shows them again, against what they now see.
      await push([{ type: 'setPrivacy', publicLikes: true, base: { publicLikes: 2 }, at: t + 260 }])
      expect(await flags()).toMatchObject({ publicLikes: true, publicLikesVersion: 3 })
    })

    describe('devices that make their changes as Settings does', () => {
      /** A device: its confirmed rows and the changes it has not had settled. */
      type Device = { confirmed: Confirmed; pending: Pending[] }
      const device = (): Device => ({
        confirmed: { cursor: 0, tables: emptyTables() },
        pending: [],
      })
      const sync = async (d: Device) => {
        for (;;) {
          const page = await pull(d.confirmed.cursor)
          d.confirmed = applyPull(d.confirmed, page)
          d.pending = settle(d.confirmed, d.pending)
          if (!page.more) return
        }
      }
      /** Push what is unsent; a lost answer leaves the device knowing nothing of it. */
      const send = async (d: Device, lost = false) => {
        const batch = d.pending.filter((p) => p.ackedAt === undefined).map((p) => p.mutation)
        if (batch.length === 0) return
        const res = await push(batch as unknown as Record<string, unknown>[])
        if (lost) return
        const applied = new Set(res.applied)
        d.pending = d.pending.map((p) =>
          applied.has(p.mutation.mid) ? { ...p, ackedAt: res.seq } : p,
        )
        d.pending = settle(d.confirmed, d.pending)
      }
      /** The member presses the likes switch: false when the show has to wait. */
      const press = (d: Device, on: boolean) => {
        const change = privacyChange(d.confirmed, d.pending, 'publicLikes', on)
        if (change === null) return false
        api.clock.advance(1)
        const mutation = { ...change, mid: `press-${++mids}-padding`, at: api.clock.now() }
        d.pending.push({ mutation: mutation as Mutation })
        return true
      }
      const shown = (d: Device) => view(d.confirmed, d.pending).profile?.publicLikes
      /** Version 1, on: the member showed their likes, and every device has it. */
      async function likesShown(...devices: Device[]) {
        await push([{ type: 'setPrivacy', publicLikes: true, base: { publicLikes: 0 } }])
        for (const d of devices) await sync(d)
        expect(await flags()).toMatchObject({ publicLikes: true, publicLikesVersion: 1 })
      }

      test("A: a show waits for the device's own hide to settle, then applies", async () => {
        const a = device()
        await likesShown(a)
        expect(press(a, false)).toBe(true)
        await send(a, true) // applied; the answer is lost
        await sync(a) // the pull holds the hide, which is still unsettled here
        expect(a.confirmed.tables.profile?.publicLikesVersion).toBe(2)
        expect(shown(a)).toBe(false)
        // A show now would name version 2 before the device knows its hide made it: it waits.
        expect(privacyUnsettled(a.confirmed, a.pending, 'publicLikes')).toBe(true)
        expect(press(a, true)).toBe(false)
        await send(a) // the retry is a replay, acknowledged
        await sync(a)
        expect(a.pending).toEqual([])
        expect(press(a, true)).toBe(true)
        await send(a)
        await sync(a)
        expect(await flags()).toMatchObject({ publicLikes: true, publicLikesVersion: 3 })
        expect(shown(a)).toBe(true)
        expect(a.pending).toEqual([])
      })

      test("B: a show cannot be queued behind an unsettled hide, so another device's hide stands", async () => {
        const [a, b] = [device(), device()]
        await likesShown(a, b)
        press(a, false)
        await send(a, true)
        await sync(a)
        expect(press(a, true)).toBe(false) // nothing queued to reopen what B closes next
        press(b, false)
        await send(b)
        await sync(b)
        expect(await flags()).toMatchObject({ publicLikes: false, publicLikesVersion: 3 })
        await send(a)
        await sync(a)
        expect(await flags()).toMatchObject({ publicLikes: false, publicLikesVersion: 3 })
        expect([shown(a), shown(b)]).toEqual([false, false])
        // Once settled, a show names version 3, B's hide included, which the member has now seen.
        expect(press(a, true)).toBe(true)
        expect(a.pending.at(-1)?.mutation).toMatchObject({ base: { publicLikes: 3 } })
      })

      test("B': a show made before another device's hide lands is refused, though sent after", async () => {
        const [a, b] = [device(), device()]
        await likesShown(a, b)
        press(a, false)
        await send(a)
        await sync(a)
        expect(press(a, true)).toBe(true) // base 2, unsent
        press(b, false)
        await send(b)
        await send(a)
        await sync(a)
        await sync(b)
        expect(await flags()).toMatchObject({ publicLikes: false, publicLikesVersion: 3 })
        expect([shown(a), shown(b)]).toEqual([false, false])
        expect(a.pending).toEqual([])
      })

      test('C: offline toggling cannot end on over a hide made elsewhere meanwhile', async () => {
        const [a, b] = [device(), device()]
        await likesShown(a, b)
        // A, offline, toggles off, on, off, on: only the hides are made.
        expect([press(a, false), press(a, true), press(a, false), press(a, true)]).toEqual([
          true,
          false,
          true,
          false,
        ])
        expect(shown(a)).toBe(false)
        press(b, false) // B hides first
        await send(b)
        await send(a)
        await sync(a)
        await sync(b)
        expect(await flags()).toMatchObject({ publicLikes: false, publicLikesVersion: 4 })
        expect([shown(a), shown(b)]).toEqual([false, false])
        expect(a.pending).toEqual([])
      })
    })

    test('a hide through PUT /profile counts the version up, so an older show is refused', async () => {
      await push([
        { type: 'setPrivacy', publicSubscriptions: true, base: { publicSubscriptions: 0 } },
      ])
      expect(await flags()).toMatchObject({
        publicSubscriptions: true,
        publicSubscriptionsVersion: 1,
      })
      // A shell from before the switches saves its form, which loaded the switch off.
      await api.request('/api/v1/profile', {
        method: 'PUT',
        body: { displayName: 'R', publicSubscriptions: false },
        as: reader,
      })
      expect(await flags()).toMatchObject({
        publicSubscriptions: false,
        publicSubscriptionsVersion: 2,
      })
      // A show another device made against version 1, before that save, arrives after it.
      await push([
        { type: 'setPrivacy', publicSubscriptions: true, base: { publicSubscriptions: 1 } },
      ])
      expect(await flags()).toMatchObject({ publicSubscriptions: false })
    })
  })

  test('the Gravatar switch goes to the later choice, and on again is a new address (ADR 0032)', async () => {
    const t = now - 1000
    const shown = async () => (await pull(0)).rows.profile[0]
    const at = (v: number) => `/avatar/${reader.userId}?v=${v}`
    // On by default (ADR 0033), but no address until Gravatar is known to have a picture.
    expect(await shown()).toMatchObject({ gravatar: true, gravatarFound: null, avatar: null })
    await write(
      db.run(
        sql`update profiles set gravatar_found = 1, gravatar_checked_at = ${t}, seq = ${currentSeq}
          where user_id = ${reader.userId}`,
      ),
    )
    expect(await shown()).toMatchObject({ gravatar: true, gravatarFound: true, avatar: at(0) })
    await push([{ type: 'setAvatar', gravatar: true, at: t }])
    expect(await shown()).toMatchObject({ gravatar: true, avatar: at(1) })
    // Refresh: the switch sent on again moves the address past every cache, whatever its `at`:
    // later, the same millisecond, or from a device whose clock is behind.
    await push([{ type: 'setAvatar', gravatar: true, at: t + 100 }])
    expect((await shown())?.avatar).toBe(at(2))
    await push([{ type: 'setAvatar', gravatar: true, at: t + 100 }])
    expect((await shown())?.avatar).toBe(at(3))
    await push([{ type: 'setAvatar', gravatar: true, at: t + 20 }])
    expect((await shown())?.avatar).toBe(at(4))
    // An older "off" from another device, arriving late, changes nothing.
    await push([{ type: 'setAvatar', gravatar: false, at: t + 50 }])
    expect(await shown()).toMatchObject({ gravatar: true, avatar: at(4) })
    // An "off" newer than every "on" wins, however many Refreshes counted the version up: the
    // version is never the clock the switch is decided by.
    await push([{ type: 'setAvatar', gravatar: false, at: t + 101 }])
    expect(await shown()).toMatchObject({ gravatar: false, avatar: null })
    // An older "on" arriving after it is no choice at all.
    await push([{ type: 'setAvatar', gravatar: true, at: t + 90 }])
    expect(await shown()).toMatchObject({ gravatar: false, avatar: null })
    // On again: past every address it had.
    await push([{ type: 'setAvatar', gravatar: true, at: t + 300 }])
    expect(await shown()).toMatchObject({ gravatar: true, avatar: at(5) })
  })

  test('turning the Gravatar on, or Refresh, asks Gravatar again at once (ADR 0033)', async () => {
    await write(
      db.run(
        sql`update profiles set gravatar_found = 0, gravatar_checked_at = ${now - 1000}, seq = ${currentSeq}
          where user_id = ${reader.userId}`,
      ),
    )
    await push([{ type: 'setAvatar', gravatar: true, at: now - 10 }])
    const checked = await db.all<{ gravatar_checked_at: number | null }>(
      sql`select gravatar_checked_at from profiles where user_id = ${reader.userId}`,
    )
    expect(checked[0]?.gravatar_checked_at).toBe(null)
    // Claimed by the push and sent on, not left for the next sweep.
    expect(api.jobs.sent.filter((j) => j.body.kind === 'member.gravatar')).toMatchObject([
      { queue: 'misc', body: { kind: 'member.gravatar', key: reader.userId } },
    ])
    // Turning it off asks nothing.
    await push([{ type: 'setAvatar', gravatar: false, at: now - 5 }])
    expect(api.jobs.sent.filter((j) => j.body.kind === 'member.gravatar')).toHaveLength(1)
  })

  test("a followee's picture comes with the follow, and turning it on sends the row again", async () => {
    await push([{ type: 'follow', userId: ANNA }])
    const snap = await pull(0)
    expect(snap.rows.follows).toMatchObject([{ userId: ANNA, avatar: null }])
    await write(
      db.run(
        sql`update profiles set gravatar = 1, gravatar_found = 1, avatar_version = 7, seq = ${currentSeq} where user_id = ${ANNA}`,
      ),
    )
    const delta = await pull(snap.cursor)
    expect(delta.rows.follows).toMatchObject([{ userId: ANNA, avatar: `/avatar/${ANNA}?v=7` }])
  })

  test('a profile save from a shell before the switches may hide subscriptions, never show them', async () => {
    await push([{ type: 'setPrivacy', publicSubscriptions: false, at: now - 10 }])
    // The old form sends what it loaded with every save.
    await api.request('/api/v1/profile', {
      method: 'PUT',
      body: { displayName: 'R', publicSubscriptions: true },
      as: reader,
    })
    expect((await pull(0)).rows.profile[0]).toMatchObject({ publicSubscriptions: false })
    await push([{ type: 'setPrivacy', publicSubscriptions: true, at: now - 5 }])
    await api.request('/api/v1/profile', {
      method: 'PUT',
      body: { displayName: 'R', publicSubscriptions: false },
      as: reader,
    })
    expect((await pull(0)).rows.profile[0]).toMatchObject({ publicSubscriptions: false })
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

  test("a post that moves across arrives with its title, its translation and the reader's state", async () => {
    // The reader followed feed 2 once, read X there, and left; now they follow feed 1.
    await push([{ type: 'subscribe', feedId: 2 }])
    const x = await addArticle(2)
    await push([{ type: 'markRead', articleId: x }])
    await push([{ type: 'unsubscribe', feedId: 2 }])
    await push([{ type: 'subscribe', feedId: 1 }])
    await write(
      db.run(sql`insert into article_titles (article_id, lang, feed_id, title, status, source_hash,
          updated_at, seq)
        values (${x}, 'zh-Hans', 2, '译题', 'done', 'h', ${now}, ${currentSeq})`),
      db.run(sql`insert into body_translations (content_key, lang, state, updated_at, seq)
        values (${`c${x}`}, 'zh-Hans', 'done', ${now}, ${currentSeq})`),
    )
    const empty = { cursor: 0, tables: emptyTables() }
    const before = applyPull(empty, await pull(0))
    expect(before.tables.articles.has(x)).toBe(false)

    // Feed 2 turns out to be another address for feed 1, and X is the post only it had.
    await write(...mergeFeed(db, { alias: 2, target: 1, move: [x], carry: [] }, now))
    const synced = applyPull(before, await pull(before.cursor))
    const fresh = applyPull(empty, await pull(0))
    expect(synced.tables.articles.get(x)?.feedId).toBe(1)
    expect(fresh.tables.titles.size).toBe(1)
    expect(fresh.tables.translations.size).toBe(1)
    expect(fresh.tables.states.get(x)?.readAt).toBe(now)
    expect([...synced.tables.titles.values()]).toEqual([...fresh.tables.titles.values()])
    expect([...synced.tables.translations.values()]).toEqual([
      ...fresh.tables.translations.values(),
    ])
    expect(synced.tables.states.get(x)).toEqual(fresh.tables.states.get(x))
  })

  describe("a read only the alias's watermark said", () => {
    // Found in review: the merge carried only reads written down, so a post read by a watermark
    // (markAllRead) showed unread once it was the target's, where no alias watermark covers it.
    const shown = async (id: number) => {
      const device = applyPull({ cursor: 0, tables: emptyTables() }, await pull(0))
      const article = device.tables.articles.get(id)
      expect(article).toBeDefined()
      return isRead(device.tables, article as ArticleRow, now)
    }
    const merge = (move: number[], carry: [number, number][]) =>
      write(...mergeFeed(db, { alias: 2, target: 1, move, carry }, now))

    test('stays read for a post kept from the alias the reader left, its row compacted', async () => {
      await push([{ type: 'subscribe', feedId: 2 }])
      const x = await addArticle(2)
      await push([
        { type: 'markRead', articleId: x },
        { type: 'markAllRead', feedId: 2, upTo: x },
      ])
      await push([{ type: 'unsubscribe', feedId: 2 }])
      await push([{ type: 'recommend', articleId: x, note: null }])
      await compactReadStates(db)
      expect(await shown(x)).toBe(true)
      await merge([x], [])
      expect(await shown(x)).toBe(true)
    })

    test('stays read for a moved post the reader, following the target now, read on the alias', async () => {
      await push([{ type: 'subscribe', feedId: 2 }])
      const x = await addArticle(2)
      await push([{ type: 'markAllRead', feedId: 2, upTo: x }])
      await push([{ type: 'unsubscribe', feedId: 2 }])
      await push([{ type: 'subscribe', feedId: 1 }])
      await merge([x], [])
      expect(await shown(x)).toBe(true)
    })

    test("is carried to the target's own copy, which the watermark never reached", async () => {
      await push([{ type: 'subscribe', feedId: 2 }])
      const duplicate = await addArticle(2)
      await push([{ type: 'markAllRead', feedId: 2, upTo: duplicate }])
      // The target fetched its copy of the same post later: its id is past the watermark.
      const copy = await addArticle(1)
      await merge([], [[duplicate, copy]])
      expect(await shown(copy)).toBe(true)
    })
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
