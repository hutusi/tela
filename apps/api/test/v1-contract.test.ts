/**
 * The v1 API's golden fixtures (ADR 0065): every route tela-api serves for apps, and a few
 * refusals, called over one deterministic world (`v1-world.ts`), each answer held to its schema
 * with no key the schema does not name, at any depth, and compared with the example committed
 * in `docs/api/v1/examples/<name>.json`. Those files are also the developer docs' example data.
 *
 * A shared function that changes what an app receives fails here; the fix goes in the mapper
 * (`@tela/ext/transform`), never in the example. When v1 grows on purpose, regenerate them:
 * `UPDATE_EXAMPLES=1 bun test apps/api/test/v1-contract.test.ts`, and review the diff.
 *
 * Bodies, translations and images (`/v1/bodies`, `/o/*`, `/img/*`) are tela-gateway's, from R2,
 * and are pinned by its own tests.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addFeedSchema,
  articlePageSchema,
  blogrollPageSchema,
  discoverBlogrollsSchema,
  discoverBlogsSchema,
  discoverFeedsSchema,
  discoverPostsSchema,
  discoverReadersSchema,
  errorSchema,
  importFeedsSchema,
  limitErrorSchema,
  meSchema,
  metaSchema,
  profilePageSchema,
  pushSchema,
  searchSchema,
  sitePageSchema,
  syncSchema,
  translationAnswerSchema,
  translationStatusSchema,
  usageSchema,
} from '@tela/ext/schema'
import { FixtureServer, rss } from '../../../packages/ingest/test/fixture-server'
import { connect, registerApp } from './apps-helpers'
import { API_ORIGIN, ORIGIN, operatorSets } from './helpers'
import { addPost, addTitle, BLOGROLL, buildWorld, call, keyOf, type World } from './v1-world'

const EXAMPLES = join(import.meta.dir, '..', '..', '..', 'docs', 'api', 'v1', 'examples')
const UPDATE = process.env.UPDATE_EXAMPLES === '1'

/** What the docs show in place of what changes from run to run, or names the test's hosts. */
const ANN_ID = 'Ux3kPq8ZbT2mWn5vRy7cLd4fHs9gJa1e'
const BO_ID = 'Bo7rTz2xKq9mVn4cWp6sLy8dFh3gJk5a'
const FIXTURE_ORIGIN = 'https://fixture.example'

let server: FixtureServer
let world: World

beforeAll(async () => {
  server = await FixtureServer.start()
  server.set('/', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<html><head><title>Fixture Blog</title><link rel="alternate" type="application/rss+xml" href="${server.url('/feed.xml')}"></head><body>hi</body></html>`,
    )
  })
  server.text(
    '/feed.xml',
    rss({
      title: 'Fixture Blog',
      link: server.url('/'),
      language: 'en',
      items: [
        {
          guid: 'first',
          link: server.url('/first'),
          title: 'A first post',
          description: 'Hello.',
          date: 'Sun, 27 Sep 2026 08:00:00 GMT',
        },
      ],
    }),
  )
  server.text('/third.xml', rss({ title: 'Third', link: server.url('/third'), items: [] }))
  world = await buildWorld()
})
afterAll(async () => {
  await server.stop()
})

/** Every string with the run's ids and hosts as the docs show them. */
function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll(world.ann.userId, ANN_ID)
      .replaceAll(world.bo.userId, BO_ID)
      .replaceAll(server.origin, FIXTURE_ORIGIN)
      .replaceAll(API_ORIGIN, 'https://api.telaread.com')
      .replaceAll(ORIGIN, 'https://telaread.com')
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]))
  }
  return value
}

/** A v1 format, as far as these checks use one (zod's schemas, without importing zod here). */
type Schema = {
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: unknown[] } }
}

/** Keys of `value` that `parsed` (the schema's output) does not have, at any depth. */
function unknownKeys(value: unknown, parsed: unknown, path = '$'): string[] {
  if (Array.isArray(value) && Array.isArray(parsed)) {
    return value.flatMap((v, i) => unknownKeys(v, parsed[i], `${path}[${i}]`))
  }
  if (value && typeof value === 'object' && parsed && typeof parsed === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      k in parsed
        ? unknownKeys(v, (parsed as Record<string, unknown>)[k], `${path}.${k}`)
        : [`${path}.${k}`],
    )
  }
  return []
}

/** The answer held to its schema: valid, and with no key the schema does not name. */
function strictly(name: string, schema: Schema, value: unknown) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${name}: ${JSON.stringify(parsed.error.issues.slice(0, 5), null, 2)}`)
  }
  const extra = unknownKeys(value, parsed.data)
  if (extra.length > 0) throw new Error(`${name}: keys the schema does not name: ${extra}`)
}

type Request = { method: string; path: string; body?: unknown; raw?: string }
const written: string[] = []
const mismatched: string[] = []

/** The headers an example shows: what an app acts on. */
const SHOWN_HEADERS = ['cache-control', 'retry-after', 'www-authenticate']

/** Call a route, hold the answer to its schema, and to its example. */
async function example(
  name: string,
  request: Request,
  schema: Schema,
  options: { status?: number; token?: string } = {},
) {
  const res = await call(world, request.path, {
    method: request.method,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.raw === undefined ? {} : { raw: request.raw }),
    ...(options.token === undefined ? {} : { token: options.token }),
  })
  const body = (await res.json()) as unknown
  if (res.status !== (options.status ?? 200)) {
    throw new Error(`${name}: ${res.status} ${JSON.stringify(body)}`)
  }
  strictly(name, schema, body)
  const headers: Record<string, string> = {}
  for (const h of SHOWN_HEADERS) {
    const v = res.headers.get(h)
    if (v !== null) headers[h] = v
  }
  const shown = normalize({
    request: {
      method: request.method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.raw === undefined ? {} : { body: request.raw }),
    },
    status: res.status,
    headers,
    body,
  })
  const text = `${JSON.stringify(shown, null, 2)}\n`
  const file = join(EXAMPLES, `${name}.json`)
  written.push(`${name}.json`)
  if (UPDATE) writeFileSync(file, text)
  else {
    let committed = ''
    try {
      committed = readFileSync(file, 'utf8')
    } catch {}
    if (committed !== text) mismatched.push(name)
  }
  return body as Record<string, unknown>
}

test('every v1 route answers as its committed example says', async () => {
  if (UPDATE) {
    rmSync(EXAMPLES, { recursive: true, force: true })
    mkdirSync(EXAMPLES, { recursive: true })
  }
  const { api, now } = world

  await example('meta', { method: 'GET', path: '/meta' }, metaSchema)
  await example('me', { method: 'GET', path: '/v1/me' }, meSchema)

  await example(
    'mutations',
    {
      method: 'POST',
      path: '/v1/mutations',
      body: {
        mutations: [
          { mid: 'm-0001-subscribe', at: now - 60_000, type: 'subscribe', feedId: 1 },
          { mid: 'm-0002-subscribe', at: now - 60_000, type: 'subscribe', feedId: 2 },
          { mid: 'm-0003-subscribe', at: now - 60_000, type: 'subscribe', feedId: 3 },
          {
            mid: 'm-0004-folder',
            at: now - 50_000,
            type: 'putFolder',
            id: 'f-reading',
            name: 'Reading',
          },
          {
            mid: 'm-0005-file',
            at: now - 50_000,
            type: 'fileFeed',
            feedId: 1,
            folderId: 'f-reading',
          },
          {
            mid: 'm-0006-pref',
            at: now - 40_000,
            type: 'setPref',
            key: 'reader.hide_read',
            value: false,
          },
          { mid: 'm-0007-like', at: now - 30_000, type: 'setLiked', articleId: 101, liked: true },
          { mid: 'm-0008-read', at: now - 30_000, type: 'markRead', articleId: 102 },
          {
            mid: 'm-0009-highlight',
            at: now - 20_000,
            type: 'putHighlight',
            id: 'h-0001-pixels',
            articleId: 101,
            contentKey: keyOf(101),
            side: 'original',
            lang: null,
            leafId: 'b3',
            start: 4,
            end: 10,
            quote: 'pixels',
            prefix: 'Fat ',
            suffix: ' are',
            note: 'Keep this.',
          },
          {
            mid: 'm-0010-recommend',
            at: now - 10_000,
            type: 'recommend',
            articleId: 301,
            note: null,
          },
          { mid: 'm-0011-follow', at: now - 10_000, type: 'follow', userId: world.bo.userId },
          {
            mid: 'm-0012-language',
            at: now - 5_000,
            type: 'setReadingLanguage',
            language: 'zh-Hans',
          },
          { mid: 'm-0013-unknown', at: now, type: 'setPref', key: 'ui.theme', value: 'dark' },
        ],
      },
    },
    pushSchema,
  )

  const snapshot = await example(
    'sync-snapshot',
    { method: 'GET', path: '/v1/sync?lang=zh-Hans' },
    syncSchema,
  )
  // Something new: a post in a feed Ann follows, and its title in her language.
  await addPost(api, { id: 103, feedId: 1, title: 'Kerning, slowly', at: now - 10 * 60_000 })
  await addTitle(api, 103, 1, 'zh-Hans', '慢慢调字距')
  await example(
    'sync-delta',
    {
      method: 'GET',
      path: `/v1/sync?lang=zh-Hans&cursor=${snapshot.cursor as string}`,
    },
    syncSchema,
  )

  await example('usage', { method: 'GET', path: '/v1/usage' }, usageSchema)

  await example(
    'translation-request',
    { method: 'POST', path: '/v1/translations', body: { articleId: 401, lang: 'zh-Hans' } },
    translationAnswerSchema,
  )
  await example(
    'translation-status',
    { method: 'GET', path: `/v1/translations/${keyOf(401)}/zh-Hans` },
    translationStatusSchema,
  )

  await example(
    'feeds-discover',
    { method: 'POST', path: '/v1/feeds/discover', body: { url: server.url('/') } },
    discoverFeedsSchema,
  )
  await example(
    'feeds-add',
    { method: 'POST', path: '/v1/feeds', body: { url: server.url('/feed.xml') } },
    addFeedSchema,
  )
  await example(
    'feeds-opml',
    {
      method: 'POST',
      path: '/v1/feeds/opml',
      raw: `<?xml version="1.0"?><opml version="2.0"><head><title>Mine</title></head><body><outline text="Tech"><outline type="rss" text="Field Log" xmlUrl="https://blog4.example/feed.xml"/><outline type="rss" text="New" xmlUrl="https://new.example/feed.xml"/></outline></body></opml>`,
    },
    importFeedsSchema,
  )

  for (const tab of ['week', 'articles', 'blogs', 'blogrolls', 'readers'] as const) {
    const schema = {
      week: discoverPostsSchema,
      articles: discoverPostsSchema,
      blogs: discoverBlogsSchema,
      blogrolls: discoverBlogrollsSchema,
      readers: discoverReadersSchema,
    }[tab]
    await example(`discover-${tab}`, { method: 'GET', path: `/v1/discover/${tab}?lang=fr` }, schema)
  }
  await example('site', { method: 'GET', path: '/v1/sites/1?lang=zh-Hans' }, sitePageSchema)
  await example('profile', { method: 'GET', path: '/v1/profiles/bo_reads' }, profilePageSchema)
  await example(
    'blogroll',
    { method: 'GET', path: `/v1/blogrolls/${BLOGROLL}` },
    blogrollPageSchema,
  )
  await example('search', { method: 'GET', path: '/v1/search?q=pixel' }, searchSchema)
  await example('article', { method: 'GET', path: '/v1/articles/401' }, articlePageSchema)

  // Refusals.
  await example('error-invalid-request', { method: 'GET', path: '/v1/sync' }, errorSchema, {
    status: 400,
  })
  await example('error-not-found', { method: 'GET', path: '/v1/articles/999999' }, errorSchema, {
    status: 404,
  })
  const reader = await registerApp(api, { maxScope: 'read' })
  const readOnly = await connect(api, world.ann, reader, { scope: 'read' })
  await example(
    'error-insufficient-scope',
    { method: 'POST', path: '/v1/mutations', body: { mutations: [] } },
    errorSchema,
    { status: 403, token: readOnly.access_token },
  )
  await example('error-invalid-token', { method: 'GET', path: '/v1/me' }, errorSchema, {
    status: 401,
    token: 'tela_at_not-a-token-anyone-was-given',
  })
  // At a cap of as many blogs as Ann follows, one more is refused, as a push and as an add.
  const { subscriptions } = (await (await call(world, '/v1/usage')).json()) as {
    subscriptions: { count: number }
  }
  await operatorSets(api, 'member.maxSubscriptions', subscriptions.count)
  await example(
    'mutations-subscription-limit',
    {
      method: 'POST',
      path: '/v1/mutations',
      body: { mutations: [{ mid: 'm-0014-subscribe', at: now, type: 'subscribe', feedId: 5 }] },
    },
    pushSchema,
  )
  await example(
    'error-subscription-limit',
    { method: 'POST', path: '/v1/feeds', body: { url: server.url('/third.xml') } },
    errorSchema,
    { status: 409 },
  )
  await operatorSets(api, 'member.maxSubscriptions', 300)
  await operatorSets(api, 'member.feedsPerDay', 0)
  await example(
    'error-feed-limit',
    { method: 'POST', path: '/v1/feeds', body: { url: server.url('/third.xml') } },
    limitErrorSchema,
    { status: 429 },
  )
  const limited = await registerApp(api, { perMemberPerMin: 1 })
  const once = await connect(api, world.ann, limited)
  await call(world, '/v1/me', { token: once.access_token })
  await example('error-rate-limited', { method: 'GET', path: '/v1/me' }, errorSchema, {
    status: 429,
    token: once.access_token,
  })

  if (!UPDATE) {
    expect(mismatched).toEqual([])
    // No example left behind by a route or a name that is gone.
    expect(readdirSync(EXAMPLES).sort()).toEqual([...written].sort())
  }
})
