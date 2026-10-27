/**
 * The v1 API's rules (ADRs 0064–0066), over the world the golden fixtures use: scopes, an app is
 * never exempt, the cursor, a writer's "no translation" held on the server and lifted with it,
 * apps' mutation ids kept apart, the subscription cap said out loud, every 429 with a
 * `Retry-After`, the caches answers allow, and nothing internal in any answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { ACTION_LIMITS, bumpSeq, currentSeq, first } from '@tela/data'
import { openapiDocument } from '@tela/ext/openapi'
import { pushSchema } from '@tela/ext/schema'
import { sql } from 'drizzle-orm'
import { FixtureServer, rss } from '../../../packages/ingest/test/fixture-server'
import { connect, gateway, registerApp } from './apps-helpers'
import { operatorSets } from './helpers'
import { addPost, buildWorld, call, keyOf, type World, webPush, write } from './v1-world'

let server: FixtureServer
let world: World

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(async () => {
  server.reset()
  for (const n of [1, 2, 3]) {
    server.text(
      `/feed${n}.xml`,
      rss({ title: `Fixture ${n}`, link: server.url(`/${n}`), items: [{ guid: 'a', title: 'A' }] }),
    )
  }
  world = await buildWorld()
})

type Json = Record<string, unknown>
const json = async (res: Response) => (await res.json()) as Json

let mids = 0
/** Push v1 mutations as the app, each with a fresh id unless it names one. */
async function push(mutations: Json[], token = world.tokens.access_token) {
  const res = await call(world, '/v1/mutations', {
    body: {
      mutations: mutations.map((m) => ({
        mid: `v1-mid-${++mids}`,
        at: world.api.clock.now(),
        ...m,
      })),
    },
    token,
  })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    results: { mid: string | null; status: string; error?: string }[]
  }
}

type Sync = {
  cursor: string
  reset: boolean
  more: boolean
  types: string[]
  removed: { articles: number[] }
  rows: { profile: Json | null } & Record<
    'subscriptions' | 'sites' | 'articles' | 'titles' | 'states' | 'translations',
    Json[]
  >
}
async function pull(query: string, token = world.tokens.access_token): Promise<Sync> {
  const res = await call(world, `/v1/sync?${query}`, { token })
  expect(res.status).toBe(200)
  return (await res.json()) as Sync
}

const subscribeAll = () =>
  push([
    { type: 'subscribe', feedId: 1 },
    { type: 'subscribe', feedId: 2 },
    { type: 'subscribe', feedId: 3 },
  ])

describe('scopes', () => {
  test('a read token is refused every route that writes, and reads the rest', async () => {
    const reader = await registerApp(world.api, { maxScope: 'read' })
    const read = await connect(world.api, world.ann, reader, { scope: 'read' })
    const writes: [string, unknown][] = [
      ['/v1/mutations', { mutations: [] }],
      ['/v1/translations', { articleId: 101, lang: 'zh-Hans' }],
      ['/v1/feeds/discover', { url: server.url('/feed1.xml') }],
      ['/v1/feeds', { url: server.url('/feed1.xml') }],
    ]
    for (const [path, body] of writes) {
      const res = await call(world, path, { body, token: read.access_token })
      expect(res.status, path).toBe(403)
      expect(await res.json()).toEqual({ error: 'insufficient_scope' })
      expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    }
    const opml = await call(world, '/v1/feeds/opml', { raw: '<opml/>', token: read.access_token })
    expect(opml.status).toBe(403)
    for (const path of ['/v1/me', '/v1/usage', '/v1/sync?lang=en', '/v1/discover/blogs']) {
      expect((await call(world, path, { token: read.access_token })).status, path).toBe(200)
    }
  })

  test('meta and the OpenAPI document take no token, and every other route does', async () => {
    const meta = await gateway(world.api, '/meta')
    expect(meta.status).toBe(200)
    // The same for everyone, so the gateway's colo keeps it rather than read D1 each time.
    expect(meta.headers.get('cache-control')).toBe('public, max-age=300')
    const doc = await gateway(world.api, '/v1/openapi.json')
    expect(doc.status).toBe(200)
    expect(await doc.json()).toEqual(openapiDocument())
    for (const path of ['/v1/me', '/v1/sync?lang=en', '/v1/discover/week', '/v1/articles/101']) {
      expect((await gateway(world.api, path)).status, path).toBe(401)
    }
    expect((await gateway(world.api, '/opens', { body: '{"keys":[]}' })).status).toBe(401)
  })
})

describe('an admin’s token is an app’s', () => {
  beforeEach(async () => {
    await world.api.db.run(
      sql`update profiles set is_admin = 1 where user_id = ${world.ann.userId}`,
    )
  })

  test('is held to the subscription cap, which the web lets the admin pass', async () => {
    await operatorSets(world.api, 'member.maxSubscriptions', 1)
    const pushed = await push([
      { type: 'subscribe', feedId: 1 },
      { type: 'subscribe', feedId: 2 },
      { type: 'unsubscribe', feedId: 1 },
      { type: 'subscribe', feedId: 3 },
    ])
    expect(pushed.results.map((r) => r.error ?? r.status)).toEqual([
      'applied',
      'subscription_limit',
      'applied',
      'applied',
    ])
    const held = await world.api.db.all<{ feed_id: number }>(
      sql`select feed_id from subscriptions where user_id = ${world.ann.userId}
        and deleted_at is null`,
    )
    expect(held.map((r) => r.feed_id)).toEqual([3])
    // The same member on the web is exempt.
    await webPush(world.api, world.ann, [{ type: 'subscribe', feedId: 2 }])
    const after = await world.api.db.all<{ feed_id: number }>(
      sql`select feed_id from subscriptions where user_id = ${world.ann.userId}
        and deleted_at is null order by feed_id`,
    )
    expect(after.map((r) => r.feed_id)).toEqual([2, 3])
  })

  test('is counted on feeds, OPML, translations and opened posts, and sees its limits', async () => {
    await operatorSets(world.api, 'member.feedsPerDay', 0)
    const added = await call(world, '/v1/feeds', { body: { url: server.url('/feed1.xml') } })
    expect(added.status).toBe(429)
    expect((await json(added)).error).toBe('feed_limit')
    expect(Number(added.headers.get('retry-after'))).toBeGreaterThan(0)

    const opml = await call(world, '/v1/feeds/opml', {
      raw: `<opml version="2.0"><body><outline type="rss" xmlUrl="${server.url('/feed2.xml')}"/></body></opml>`,
    })
    expect(opml.status).toBe(200)
    expect(await json(opml)).toMatchObject({ added: 0, waiting: 1, perDay: 0 })

    const asked = await call(world, '/v1/translations', {
      body: { articleId: 401, lang: 'zh-Hans' },
    })
    expect((await json(asked)).status).toBe('running')

    const opens = await gateway(world.api, '/opens', {
      token: world.tokens.access_token,
      body: JSON.stringify({ keys: [keyOf(401)] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(await json(opens)).toEqual({ allowed: [keyOf(401)], refused: {} })

    const usage = await json(await call(world, '/v1/usage'))
    expect(usage).toMatchObject({
      translations: { perDay: 20, usedToday: 1 },
      feeds: { perDay: 0 },
      subscriptions: { max: 300 },
      posts: { perDay: 100, openedToday: 1 },
    })
    expect(JSON.stringify(await json(await call(world, '/v1/me')))).not.toContain('dmin')
  })

  test('is refused the day’s posts past the limit, with when it starts again', async () => {
    await operatorSets(world.api, 'member.unsubscribedPostsPerDay', 0)
    const opens = await gateway(world.api, '/opens', {
      token: world.tokens.access_token,
      body: JSON.stringify({ keys: [keyOf(401)] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(await json(opens)).toEqual({
      allowed: [],
      refused: { [keyOf(401)]: { error: 'post_limit', limit: 0, resetsAt: expect.any(Number) } },
    })
    const bad = await gateway(world.api, '/opens', {
      token: world.tokens.access_token,
      body: JSON.stringify({ keys: Array.from({ length: 26 }, (_, i) => keyOf(i + 1)) }),
      headers: { 'content-type': 'application/json' },
    })
    expect(bad.status).toBe(400)
  })
})

describe('the cursor', () => {
  test('a delta follows a snapshot, and another language or a type not held starts over', async () => {
    await subscribeAll()
    const snapshot = await pull('lang=zh-Hans')
    expect(snapshot.reset).toBe(true)
    const titlesOf = (s: Sync) => s.rows.titles.map((t) => `${t.articleId}:${t.lang}`).sort()
    expect(titlesOf(snapshot)).toEqual(['101:zh-Hans', '102:zh-Hans'])
    const delta = await pull(`lang=zh-Hans&cursor=${snapshot.cursor}`)
    expect(delta.reset).toBe(false)
    expect(delta.rows.articles).toEqual([])

    const french = await pull(`lang=fr&cursor=${snapshot.cursor}`)
    expect(french.reset).toBe(true)
    expect(titlesOf(french)).toEqual(['101:fr'])
    expect(french.rows.translations.map((t) => t.lang)).toEqual(['fr'])

    // Fewer types is no reset, but the cursor then holds only those.
    const fewer = await pull(`lang=fr&types=profile,titles&cursor=${french.cursor}`)
    expect(fewer.reset).toBe(false)
    expect(fewer.types).toEqual(['profile', 'titles'])
    expect(fewer.rows.articles).toEqual([])
    const more = await pull(`lang=fr&types=profile,titles,articles&cursor=${fewer.cursor}`)
    expect(more.reset).toBe(true)
    expect(more.rows.articles.length).toBeGreaterThan(0)
    expect(more.rows.subscriptions).toEqual([])

    expect((await pull('lang=fr&cursor=not-a-cursor')).reset).toBe(true)
    expect((await call(world, '/v1/sync?lang=fr&types=claims')).status).toBe(400)
    expect((await call(world, '/v1/sync?lang=ja')).status).toBe(400)
  })

  test('a delta says which posts Tela no longer holds', async () => {
    await subscribeAll()
    const snapshot = await pull('lang=en')
    expect(snapshot.removed).toEqual({ articles: [] })
    const { db } = world.api
    // How the web's pull says a post went (no writer removes one today): a tombstone in its feed.
    await write(
      world.api,
      db.run(sql`insert into tombstones (seq, user_id, feed_id, entity, key)
        values (${currentSeq}, null, 1, 'article', '102'), (${currentSeq}, null, 1, 'feed', '1')`),
    )
    const delta = await pull(`lang=en&cursor=${snapshot.cursor}`)
    expect(delta.removed).toEqual({ articles: [102] })
    // Only to an app that holds posts.
    const titlesOnly = await pull(`lang=en&types=titles&cursor=${snapshot.cursor}`)
    expect(titlesOnly.removed).toEqual({ articles: [] })
  })

  test('a post marked unread by hand says so, and a read one does not', async () => {
    await subscribeAll()
    await push([
      { type: 'markRead', articleId: 101 },
      { type: 'markUnread', articleId: 102 },
    ])
    const { rows } = await pull('lang=en')
    const state = (id: number) => rows.states.find((s) => s.articleId === id)
    expect(state(101)).toMatchObject({ readAt: expect.any(Number), markedUnread: false })
    expect(state(102)).toMatchObject({ readAt: null, markedUnread: true })
  })
})

describe('a writer’s “no translation”', () => {
  /** Ann's view of blog 2's post: its title and its body translation, in Simplified Chinese. */
  async function blog2(cursor?: string) {
    const s = await pull(`lang=zh-Hans${cursor ? `&cursor=${cursor}` : ''}`)
    return {
      cursor: s.cursor,
      title: s.rows.titles.some((t) => t.articleId === 201),
      translation: s.rows.translations.some((t) => t.contentKey === keyOf(201)),
      allowed: s.rows.sites.find((x) => x.id === 2)?.translationAllowed,
    }
  }

  test('keeps its titles and translations out of sync, status and asking', async () => {
    await subscribeAll()
    expect(await blog2()).toMatchObject({ title: false, translation: false, allowed: false })
    const status = await call(world, `/v1/translations/${keyOf(201)}/zh-Hans`)
    expect(await json(status)).toEqual({ translation: null })
    const asked = await call(world, '/v1/translations', {
      body: { articleId: 201, lang: 'zh-Hans' },
    })
    expect(await json(asked)).toEqual({ status: 'unavailable', translation: null })
    // Public answers carry no translated title of it either.
    const site = await json(await call(world, '/v1/sites/2?lang=zh-Hans'))
    expect((site.posts as Json[])[0]?.translatedTitle).toBeNull()
  })

  test('turned back on by its claimant, sends what it kept out in the next delta', async () => {
    await subscribeAll()
    await world.api.db.run(sql`update sites set claimed_by = ${world.bo.userId} where id = 2`)
    const before = await blog2()
    const res = await world.api.request('/api/v1/sites/2/translation', {
      method: 'PUT',
      as: world.bo,
      body: { optOut: false },
    })
    expect(res.status).toBe(200)
    expect(await blog2(before.cursor)).toMatchObject({
      title: true,
      translation: true,
      allowed: true,
    })
  })

  test('turned back on in the console, or by undoing Translation off, the same', async () => {
    await subscribeAll()
    await world.api.db.run(sql`update profiles set is_admin = 1 where user_id = ${world.bo.userId}`)
    const act = async (action: string) =>
      json(
        await world.api.request('/api/v1/admin/act', {
          as: world.bo,
          body: { action, ids: ['2'] },
        }),
      )
    let before = await blog2()
    await act('site.translationOn')
    expect(await blog2(before.cursor)).toMatchObject({ title: true, translation: true })

    const off = (await act('site.translationOff')) as { undo?: { group: string } }
    before = await blog2()
    expect(before).toMatchObject({ allowed: false })
    const undone = await world.api.request('/api/v1/admin/undo', {
      as: world.bo,
      body: { group: off.undo?.group },
    })
    expect(undone.status).toBe(200)
    expect(await blog2(before.cursor)).toMatchObject({
      title: true,
      translation: true,
      allowed: true,
    })
  })

  test('taken back with a claim the operator removes, the same', async () => {
    await subscribeAll()
    const { db } = world.api
    await db.batch([
      bumpSeq(db),
      db.run(sql`update sites set claimed_by = ${world.bo.userId}, seq = ${currentSeq}
        where id = 2`),
      db.run(sql`insert into site_claims (id, site_id, user_id, method, token, status,
          verified_at, created_at, seq)
        values (77, 2, ${world.bo.userId}, 'meta', 'abcdef0123456789', 'verified', 0, 0,
          ${currentSeq})`),
    ] as never)
    await db.run(sql`update profiles set is_admin = 1 where user_id = ${world.ann.userId}`)
    const before = await blog2()
    const removed = await world.api.request('/api/v1/admin/act', {
      as: world.ann,
      body: { action: 'claim.remove', ids: ['77'] },
    })
    expect((await json(removed)).done).toHaveLength(1)
    expect(await blog2(before.cursor)).toMatchObject({
      title: true,
      translation: true,
      allowed: true,
    })
  })
})

describe('mutations', () => {
  test('two apps’ identical ids are two mutations, and a replay within one app is one', async () => {
    await subscribeAll()
    const other = await registerApp(world.api)
    const otherTokens = await connect(world.api, world.ann, other)
    const now = world.api.clock.now()
    const liked = async () =>
      (
        await first<{ liked_at: number | null }>(
          world.api.db,
          sql`select liked_at from user_article_states where user_id = ${world.ann.userId}
            and article_id = 101`,
        )
      )?.liked_at ?? null
    const like = { mid: 'same-mid-0001', type: 'setLiked', articleId: 101 }
    await push([{ ...like, liked: true, at: now - 2000 }])
    expect(await liked()).not.toBeNull()
    const second = await push([{ ...like, liked: false, at: now - 1000 }], otherTokens.access_token)
    expect(second.results).toEqual([{ mid: 'same-mid-0001', status: 'applied' }])
    expect(await liked()).toBeNull()
    // The first app sending its own again is a replay: applied, and nothing changes.
    const replay = await push([{ ...like, liked: true, at: now }])
    expect(replay.results).toEqual([{ mid: 'same-mid-0001', status: 'applied' }])
    expect(await liked()).toBeNull()
    const stored = await world.api.db.all<{ mid: string }>(
      sql`select mid from applied_mutations where mid like '%same-mid-0001' order by mid`,
    )
    expect(stored.map((r) => r.mid)).toEqual([
      `a${world.app.id}:same-mid-0001`,
      `a${other.id}:same-mid-0001`,
    ])
  })

  test('says which it refused, and why, in order', async () => {
    const pushed = await push([
      { type: 'markRead', articleId: 101 },
      { type: 'setPref', key: 'translate.never', value: 'en' },
      { type: 'setPref', key: 'translate.never', value: ['en'] },
      { type: 'markRead' },
      { mid: 'short', type: 'markRead', articleId: 101 },
    ])
    expect(pushed.results.map((r) => r.error ?? r.status)).toEqual([
      'applied',
      'invalid',
      'applied',
      'invalid',
      'invalid',
    ])
    const big = await call(world, '/v1/mutations', {
      body: { mutations: Array.from({ length: 51 }, () => ({})) },
    })
    expect(big.status).toBe(400)
  })

  test('words a refusal only in v1’s codes, whatever the web’s push calls it', async () => {
    const highlight = {
      type: 'putHighlight',
      id: 'hl-0000001',
      articleId: 101,
      contentKey: keyOf(101),
      side: 'original',
      lang: null,
      leafId: 'b1',
      prefix: '',
      suffix: '',
      note: null,
    }
    const pushed = await push([
      // The web's push says `invalid_name` and `invalid_range`: codes v1 never documented.
      { type: 'putFolder', id: 'folder-0001', name: 'Bell\u0007' },
      { ...highlight, start: 5, end: 5, quote: '' },
      { ...highlight, id: 'hl-0000002', start: 0, end: 4, quote: 'two' },
      { type: 'putFolder', id: 'folder-0002', name: 'Reading' },
    ])
    expect(pushed.results.map((r) => r.error ?? r.status)).toEqual([
      'invalid',
      'invalid',
      'invalid',
      'applied',
    ])
    expect(pushSchema.safeParse(pushed).success).toBe(true)
  })
})

describe('every 429 says when to try again', () => {
  test('the hour’s asks, the day’s feeds and the app’s rate', async () => {
    const tries = async (path: string, body: unknown, limit: number) => {
      let last: Response | null = null
      for (let i = 0; i <= limit; i++) last = await call(world, path, { body })
      return last as Response
    }
    // The hour's translation asks, spent already: only a new request spends one.
    const hour = ACTION_LIMITS.translate.windowSec * 1000
    await world.api.db.run(sql`insert into action_limits (key, window_start, count)
      values (${`translate:${world.ann.userId}`},
        ${Math.floor(world.api.clock.now() / hour) * hour}, ${ACTION_LIMITS.translate.limit})`)
    for (const res of [
      await tries('/v1/feeds/discover', { url: 'not a url' }, ACTION_LIMITS.discover.limit),
      await tries('/v1/translations', { articleId: 401, lang: 'zh-Hans' }, 0),
    ]) {
      expect(res.status).toBe(429)
      expect((await json(res)).error).toBe('rate_limited')
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    const limited = await registerApp(world.api, { perMemberPerMin: 0 })
    const tokens = await connect(world.api, world.ann, limited)
    const res = await call(world, '/v1/me', { token: tokens.access_token })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})

describe('caches', () => {
  test('a public answer naming its language may be kept; anything about the member may not', async () => {
    const control = async (path: string) => (await call(world, path)).headers.get('cache-control')
    expect(await control('/v1/discover/articles?lang=en')).toBe('public, max-age=300')
    expect(await control('/v1/sites/1?lang=en')).toBe('public, max-age=300')
    expect(await control('/v1/discover/articles')).toBe('private, no-store')
    expect(await control('/v1/search?q=pixel&lang=en')).toBe('private, no-store')
    expect(await control('/v1/articles/101')).toBe('private, no-store')
    expect(await control('/v1/sync?lang=en')).toBe('private, no-store')
  })

  test('without a language, titles come in the member’s own', async () => {
    const page = await json(await call(world, '/v1/sites/1'))
    const pixels = (page.posts as Json[]).find((p) => p.id === 101)
    expect(pixels?.translatedTitle).toBe('用像素作画')
  })
})

describe('a post by id', () => {
  test('of a blog a member added privately is not found, unless the member follows it', async () => {
    const { db } = world.api
    await write(
      world.api,
      db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at, seq)
        values (6, 'https://private6.example', 'Private', 'private', 0, 0, ${currentSeq})`),
      db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
          updated_at, seq)
        values (6, 6, 'https://private6.example/feed?token=s3cret', 'private6.example', 0, 0, 0,
          ${currentSeq})`),
    )
    await addPost(world.api, { id: 601, feedId: 6, title: 'Not for everyone', at: world.now })
    const hidden = await call(world, '/v1/articles/601')
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({ error: 'not_found' })
    await push([{ type: 'subscribe', feedId: 6 }])
    const held = await call(world, '/v1/articles/601')
    expect(held.status).toBe(200)
    expect(((await held.json()) as { article: Json }).article).toMatchObject({
      id: 601,
      contentKey: keyOf(601),
    })
  })
})

describe('nothing internal', () => {
  /** Every key anywhere in a value. */
  const keys = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap(keys)
      : value && typeof value === 'object'
        ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
        : []
  const INTERNAL = [
    'isAdmin',
    'token',
    'claims',
    'owned',
    'listing',
    'indexable',
    'vouched',
    'lastError',
    'extractState',
    'publicSubscriptionsVersion',
    'publicLikesVersion',
    'uiLocale',
    'gravatar',
    'gravatarFound',
    'avatarUploaded',
    'requestId',
    'requestedBy',
    'reservedTokens',
    'usedTokens',
    'failedLeaves',
    'seq',
    'titles',
    'contentKey',
  ]

  test('in any answer, an admin who claimed a blog and keeps a pending claim included', async () => {
    const { db } = world.api
    await db.batch([
      bumpSeq(db),
      db.run(sql`update profiles set is_admin = 1, seq = ${currentSeq}
        where user_id = ${world.ann.userId}`),
      db.run(sql`update sites set claimed_by = ${world.ann.userId}, seq = ${currentSeq}
        where id = 1`),
      db.run(sql`update feeds set last_error = 'timeout', seq = ${currentSeq} where id = 1`),
      db.run(sql`insert into site_claims (site_id, user_id, method, token, status, created_at, seq)
        values (3, ${world.ann.userId}, 'meta', 'secret-claim-token', 'pending', 0, ${currentSeq})`),
    ] as never)
    await subscribeAll()
    const answers: [string, unknown][] = []
    for (const path of [
      '/v1/me',
      '/v1/usage',
      '/v1/sync?lang=zh-Hans',
      '/v1/discover/week?lang=en',
      '/v1/discover/articles',
      '/v1/discover/blogs',
      '/v1/discover/blogrolls',
      '/v1/discover/readers',
      '/v1/sites/1',
      '/v1/profiles/bo_reads',
      '/v1/blogrolls/BoBlogroll01',
      '/v1/search?q=pixel',
      '/v1/articles/101',
    ]) {
      const res = await call(world, path)
      expect(res.status, path).toBe(200)
      answers.push([path, await res.json()])
    }
    for (const [path, body] of answers) {
      const found = keys(body).filter((k) => INTERNAL.includes(k))
      // A synced article row and a post opened by id carry the content key, and only they; sync's
      // title rows are `rows.titles`.
      const allowed = path.startsWith('/v1/sync')
        ? ['contentKey', 'titles']
        : path.startsWith('/v1/articles')
          ? ['contentKey']
          : []
      expect(
        found.filter((k) => !allowed.includes(k)),
        path,
      ).toEqual([])
      expect(JSON.stringify(body), path).not.toContain('secret-claim-token')
      expect(JSON.stringify(body), path).not.toContain('ann@x.test')
    }
  })

  test('the address only for an app the member and the operator both let see it', async () => {
    const mailer = await registerApp(world.api, { allowEmail: true })
    const withEmail = await connect(world.api, world.ann, mailer, {
      scope: 'write email',
      email: true,
    })
    expect(
      await json(await call(world, '/v1/me', { token: withEmail.access_token })),
    ).toMatchObject({ email: 'ann@x.test' })
    expect(await json(await call(world, '/v1/me'))).not.toHaveProperty('email')
  })
})
