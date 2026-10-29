/**
 * Blogs by path (ADR 0069): on a host many writers share, each writer's blog is the first segment
 * of the path, and a section of a site the rules name is a blog of its own. The fixture server is
 * one origin, so these tests name its host and paths in the rules they pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, type Lease, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import type { BlogRules } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createHttpClient } from '../src/http'
import { dueAssets, type IngestContext, ingestFeed, registerFeed } from '../src/pipeline'
import { FixtureServer, longHtml, rss } from './fixture-server'

const NOW = Date.UTC(2026, 9, 30, 10)
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})

let server: FixtureServer
let db: TelaDb
let clock: ReturnType<typeof fakeClock>

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(async () => {
  server.reset()
  db = (await createTestDb()).db
  clock = fakeClock(NOW)
})

/** The fixture's host as one many writers share, as world.hey.com is. */
const shared = (): BlogRules => ({ sharedHosts: ['127.0.0.1'], pathBlogs: [] })
/** The fixture's /research as a section that is a blog of its own, as Anthropic's is. */
const sections = (): BlogRules => ({ sharedHosts: [], pathBlogs: [server.url('/research')] })

const ctx = (blogRules: BlogRules): IngestContext => ({
  db,
  blobs: memoryBlobs(),
  http,
  clock,
  random: () => 0.5,
  blogRules,
})

async function fetchFeed(rules: BlogRules, feedId: number) {
  await claimDue(db, {
    kind: 'feed.fetch',
    owner: 'w1',
    now: clock.now(),
    ttlMs: 120_000,
    limit: 1,
    due: sql`select ${feedId} as key, null as host, 0 as ord`,
  })
  const lease: Lease = { kind: 'feed.fetch', key: String(feedId), owner: 'w1' }
  return ingestFeed(ctx(rules), lease)
}

/** A writer's feed at `/<name>/rss`, declaring `/<name>` as its home. */
function writer(name: string) {
  server.text(
    `/${name}/rss`,
    rss({
      title: name,
      link: server.url(`/${name}`),
      items: [{ guid: name, link: server.url(`/${name}/a`), title: 'A', content: longHtml(3) }],
    }),
  )
  return server.url(`/${name}/rss`)
}

const homes = async () =>
  (await db.all<{ home_url: string }>(sql`select home_url from sites order by home_url`)).map((s) =>
    s.home_url.replace(server.origin, ''),
  )

describe('filing a feed by its site key', () => {
  test('two writers on a shared host are two blogs', async () => {
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), rules: shared(), now: NOW })
    const jason = await registerFeed(db, { feedUrl: writer('jason'), rules: shared(), now: NOW })
    expect(dhh.siteId).not.toBe(jason.siteId)
    expect(await homes()).toEqual(['/dhh', '/jason'])
  })

  test('a feed whose home is a named section is filed under it, any other under the origin', async () => {
    const elsewhere = 'https://feeds.example/lab.xml'
    await registerFeed(db, {
      feedUrl: elsewhere,
      homeUrl: server.url('/research/'),
      rules: sections(),
      now: NOW,
    })
    await registerFeed(db, {
      feedUrl: 'https://feeds.example/news.xml',
      homeUrl: server.url('/news'),
      rules: sections(),
      now: NOW,
    })
    expect(await homes()).toEqual(['', '/research'])
  })

  test('a feed filed under the bare host before moves to its writer at its next fetch', async () => {
    // Filed as Tela did before blogs by path: both writers on one blog, the host.
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), now: NOW })
    const jason = await registerFeed(db, { feedUrl: writer('jason'), now: NOW })
    expect(dhh.siteId).toBe(jason.siteId)

    // The first splits onto a blog of its own; the second, left alone there, renames the host's.
    expect(await fetchFeed(shared(), dhh.feedId)).toMatchObject({ siteHome: 'split' })
    expect(await fetchFeed(shared(), jason.feedId)).toMatchObject({ siteHome: 'renamed' })
    expect(await homes()).toEqual(['/dhh', '/jason'])
    const served = await db.all<{ served_origin: string }>(
      sql`select served_origin from feeds order by id`,
    )
    expect(served.map((f) => f.served_origin.replace(server.origin, ''))).toEqual([
      '/dhh',
      '/jason',
    ])
  })

  test("a claim on the bare host keeps what its claimant added, and no other writer's feed", async () => {
    await addTestUser(db, 'u1')
    const dhh = await registerFeed(db, { feedUrl: writer('dhh'), actorId: 'u1', now: NOW })
    const jason = await registerFeed(db, { feedUrl: writer('jason'), now: NOW })
    await db.run(sql`update sites set claimed_by = 'u1' where id = ${dhh.siteId}`)
    // What the claimant added stays on the blog they claimed.
    expect(await fetchFeed(shared(), dhh.feedId)).toMatchObject({ siteHome: 'blocked' })
    // Served from another writer's path, a feed is not the claimed blog's own: it moves there.
    expect(await fetchFeed(shared(), jason.feedId)).toMatchObject({ siteHome: 'detached' })
    expect(await homes()).toEqual(['', '/jason'])
  })

  test('a blog by path is leased by its host, as its feeds are', async () => {
    await registerFeed(db, { feedUrl: writer('dhh'), rules: shared(), now: NOW })
    const due = await db.all<{ host: string }>(dueAssets())
    expect(due.map((d) => d.host)).toEqual([new URL(server.origin).host])
  })
})
