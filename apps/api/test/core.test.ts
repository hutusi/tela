/**
 * The rules both surfaces share (`src/core`) take who acts (ADRs 0064, 0065): the web passes
 * `exempt` from `is_admin`, an app always passes false. So the operator acting through an app is
 * counted like anyone, however their profile reads, and the same rules acting for the web exempt
 * them. A writer's "no translation" is the rules' to say too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type Actor, bumpSeq, currentSeq, first } from '@tela/data'
import { createHttpClient } from '@tela/ingest/http'
import { createIngest } from '@tela/ingest/pipeline'
import { sql } from 'drizzle-orm'
import { FixtureServer, rss } from '../../../packages/ingest/test/fixture-server'
import { addFeedFor, importFeeds } from '../src/core/feeds'
import { requestBodyTranslation, translationStatus } from '../src/core/translations'
import { readUsage } from '../src/core/usage'
import type { ApiConfig, ApiDeps } from '../src/deps'
import { applyPush } from '../src/sync/push'
import { createTestApi, operatorSets, type SignedIn, signedIn, type TestApi } from './helpers'

let server: FixtureServer
let api: TestApi
let deps: ApiDeps
let operator: SignedIn
/** The operator as an app acts for them, and as the web does. */
let asApp: Actor
let asWeb: Actor

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(async () => {
  server.reset()
  api = await createTestApi()
  operator = await signedIn(api, 'op@x.test')
  await api.db.run(sql`update profiles set is_admin = 1 where user_id = ${operator.userId}`)
  asApp = { userId: operator.userId, exempt: false }
  asWeb = { userId: operator.userId, exempt: true }
  const http = createHttpClient({
    userAgent: 'TelaTest/1.0',
    politenessMs: 0,
    allowPrivateHosts: true,
    timeoutMs: 2000,
  })
  deps = {
    db: api.db,
    blobs: api.blobs,
    jobs: api.jobs,
    clock: api.clock,
    mail: api.mail,
    ingest: createIngest({ db: api.db, http, now: () => api.clock.now() }),
    config: {} as ApiConfig,
  }
})

const subscribed = async (feedId: number) =>
  (
    await first<{ n: number }>(
      api.db,
      sql`select count(*) as n from subscriptions
        where user_id = ${operator.userId} and feed_id = ${feedId} and deleted_at is null`,
    )
  )?.n ?? 0

describe('an admin acting through an app is counted', () => {
  test('asking for a translation', async () => {
    await api.db.batch([
      bumpSeq(api.db),
      api.db.run(sql`insert into sites (id, home_url, created_at, updated_at, seq)
        values (1, 'https://blog.example', 0, 0, ${currentSeq})`),
      api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
          updated_at, seq)
        values (1, 1, 'https://blog.example/feed', 'blog.example', 0, 0, 0, ${currentSeq})`),
      ...[1, 2].map((id) =>
        api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at,
            source_lang, current_version, content_key, seq)
          values (${id}, 1, ${`k${id}`}, 'はじめに', 0, 0, 'ja', 1, ${`ckey${id}`}, ${currentSeq})`),
      ),
    ] as never)
    await operatorSets(api, 'member.translationsPerDay', 0)
    const app = await requestBodyTranslation(deps, asApp, { articleId: 1, lang: 'en' })
    expect(app).toMatchObject({ status: 'budget_exhausted', reason: 'member' })
    const web = await requestBodyTranslation(deps, asWeb, { articleId: 2, lang: 'en' })
    expect(web.status).toBe('requested')
  })

  test('adding a feed new to Tela', async () => {
    for (const name of ['a', 'b']) {
      server.text(
        `/${name}.xml`,
        rss({ title: name, link: server.url('/'), items: [{ guid: name, title: name }] }),
      )
    }
    await operatorSets(api, 'member.feedsPerDay', 0)
    const app = await addFeedFor(deps, asApp, { feedUrl: server.url('/a.xml') })
    expect(app).toMatchObject({ error: 'feed_limit', limit: 0, resetsAt: Date.UTC(2026, 8, 29) })
    const web = await addFeedFor(deps, asWeb, { feedUrl: server.url('/b.xml') })
    expect(web).toMatchObject({ feedId: expect.any(Number) })
  })

  test('subscribing past the cap, in a push', async () => {
    await api.db.batch([
      bumpSeq(api.db),
      api.db.run(sql`insert into sites (id, home_url, created_at, updated_at, seq)
        values (1, 'https://blog.example', 0, 0, ${currentSeq})`),
      api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
          updated_at, seq)
        values (1, 1, 'https://blog.example/feed', 'blog.example', 0, 0, 0, ${currentSeq})`),
    ] as never)
    await operatorSets(api, 'member.maxSubscriptions', 0)
    const now = api.clock.now()
    const subscribe = (mid: string) => [{ mid, type: 'subscribe', feedId: 1, at: now }]
    // Applied, as a subscribe past the cap is for the web too, and writing nothing.
    const app = await applyPush(api.db, operator.userId, subscribe('app-mutation'), now, {
      exempt: false,
    })
    expect(app.applied).toEqual(['app-mutation'])
    expect(await subscribed(1)).toBe(0)
    await applyPush(api.db, operator.userId, subscribe('web-mutation'), now, { exempt: true })
    expect(await subscribed(1)).toBe(1)
  })

  test('importing OPML', async () => {
    const opml = (urls: string[]) =>
      `<?xml version="1.0"?><opml version="2.0"><head><title>s</title></head><body>${urls
        .map((u) => `<outline text="x" xmlUrl="${u}"/>`)
        .join('')}</body></opml>`
    await operatorSets(api, 'member.feedsPerDay', 1)
    const app = await importFeeds(
      deps,
      asApp,
      opml(['https://a.example/feed', 'https://b.example/feed']),
    )
    expect(app).toMatchObject({ added: 1, waiting: 1, perDay: 1 })
    const web = await importFeeds(
      deps,
      asWeb,
      opml(['https://c.example/feed', 'https://d.example/feed']),
    )
    expect(web).toMatchObject({ added: 2, perDay: null, maxSubscriptions: null })
  })

  test('reading their usage', async () => {
    expect(await readUsage(deps, asApp)).toMatchObject({
      translations: { perDay: 20 },
      feeds: { perDay: 20 },
      subscriptions: { max: 300 },
      posts: { perDay: 100, openedToday: 0 },
      exempt: false,
    })
    expect(await readUsage(deps, asWeb)).toMatchObject({
      feeds: { perDay: null },
      posts: { perDay: null },
      exempt: true,
    })
  })
})

describe('a translation whose writer turned translation off', () => {
  test('is said to be, beside the row, and only while no allowing blog holds the post', async () => {
    await api.db.batch([
      bumpSeq(api.db),
      api.db.run(sql`insert into sites (id, home_url, translation_opt_out, created_at, updated_at,
          seq)
        values (1, 'https://off.example', 1, 0, 0, ${currentSeq}),
          (2, 'https://on.example', 0, 0, 0, ${currentSeq})`),
      api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
          updated_at, seq)
        values (1, 1, 'https://off.example/feed', 'off.example', 0, 0, 0, ${currentSeq}),
          (2, 2, 'https://on.example/feed', 'on.example', 0, 0, 0, ${currentSeq})`),
      api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at,
          current_version, content_key, seq)
        values (1, 1, 'k1', 'Off', 0, 0, 1, 'shared', ${currentSeq})`),
      api.db.run(sql`insert into body_translations (content_key, lang, state, updated_at, seq)
        values ('shared', 'fr', 'done', 0, ${currentSeq})`),
    ] as never)
    const off = await translationStatus(deps, 'shared', 'fr')
    expect([off.translation?.state, off.optedOut]).toEqual(['done', true])
    // The same body on a blog that allows it: not refused.
    await api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at,
        current_version, content_key, seq)
      values (2, 2, 'k2', 'On', 0, 0, 1, 'shared', 0)`)
    expect((await translationStatus(deps, 'shared', 'fr')).optedOut).toBe(false)
    expect(await translationStatus(deps, 'missing', 'fr')).toEqual({
      translation: null,
      optedOut: false,
    })
  })

  test("still refused for an earlier version's content, once the post has moved on", async () => {
    await api.db.batch([
      bumpSeq(api.db),
      api.db.run(sql`insert into sites (id, home_url, translation_opt_out, created_at, updated_at,
          seq)
        values (1, 'https://off.example', 1, 0, 0, ${currentSeq})`),
      api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
          updated_at, seq)
        values (1, 1, 'https://off.example/feed', 'off.example', 0, 0, 0, ${currentSeq})`),
      // The post is on its second version; its first content still has a translation.
      api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at,
          current_version, content_key, seq)
        values (1, 1, 'k1', 'Off', 0, 0, 2, 'second', ${currentSeq})`),
      api.db.run(sql`insert into article_versions (article_id, version, provenance, content_key,
          norm_version, body_chars, created_at)
        values (1, 1, 'feed', 'first', 1, 10, 0), (1, 2, 'feed', 'second', 1, 10, 0)`),
      api.db.run(sql`insert into body_translations (content_key, lang, state, updated_at, seq)
        values ('first', 'fr', 'done', 0, ${currentSeq})`),
    ] as never)
    const old = await translationStatus(deps, 'first', 'fr')
    expect([old.translation?.state, old.optedOut]).toEqual(['done', true])
  })
})
