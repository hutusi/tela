/** One blog, one feed (ADR 0028): an alias hands itself over to the blog's canonical feed. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, first, importFeedUrls, type Lease, subscribe, type TelaDb } from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { createHttpClient } from '../src/http'
import { createIngest, type IngestContext, ingestFeed, registerFeed } from '../src/pipeline'
import { FixtureServer, rss } from './fixture-server'

const NOW = Date.UTC(2026, 8, 20, 10)
const DAY = 86_400_000
const MIN = 60_000
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

const ctx = (): IngestContext => ({ db, blobs: memoryBlobs(), http, clock, random: () => 0.5 })

/** A feed of the blog's posts `ns`: post n was published n days before NOW. */
function posts(ns: number[]) {
  return rss({
    link: server.url('/'),
    items: ns.map((n) => ({
      guid: `${server.url(`/posts/${n}`)}#guid`,
      link: server.url(`/posts/${n}`),
      title: `Post ${n}`,
      description: `<p>Notes on subject number ${n}, written for this test.</p>`,
      date: new Date(NOW - n * DAY).toUTCString(),
    })),
  })
}

async function fetchNow(feedId: number) {
  const got = await claimDue(db, {
    kind: 'feed.fetch',
    owner: 'w1',
    now: clock.now(),
    ttlMs: 2 * MIN,
    limit: 1,
    due: sql`select ${feedId} as key, null as host, 0 as ord`,
  })
  if (got.length !== 1) throw new Error(`could not claim feed ${feedId}`)
  const lease: Lease = { kind: 'feed.fetch', key: String(feedId), owner: 'w1' }
  const result = await ingestFeed(ctx(), lease)
  clock.advance(MIN)
  return result
}

const register = (path: string) =>
  registerFeed(db, { feedUrl: server.url(path), now: clock.now() }).then((r) => r.feedId)

const feedOf = (id: number) =>
  first<{ status: string; merged_into: number | null }>(
    db,
    sql`select status, merged_into from feeds where id = ${id}`,
  )

describe('a feed that is another address for the blog it belongs to', () => {
  test('hands its readers, its read posts and the posts only it had to the canonical feed', async () => {
    // The blog's own feed carries its latest four posts; a mirror of it carries six.
    server.text('/feed.xml', posts([1, 2, 3, 4]))
    server.text('/mirror.xml', posts([1, 2, 3, 4, 5, 6]))
    const own = await register('/feed.xml')
    const mirror = await register('/mirror.xml')
    await fetchNow(own)
    await fetchNow(mirror)

    await addTestUser(db, 'u1')
    await subscribe(db, 'u1', mirror, clock.now())
    const read = await first<{ id: number }>(
      db,
      sql`select id from articles where feed_id = ${mirror} and url = ${server.url('/posts/2')}`,
    )
    await db.run(
      sql`insert into user_article_states (user_id, article_id, read_at, seq) values ('u1', ${read?.id}, ${clock.now()}, 0)`,
    )

    // The canonical feed fetches as ever; the mirror, when next due, merges instead of fetching.
    expect(await fetchNow(own)).toMatchObject({ status: 'unchanged' })
    expect(await fetchNow(mirror)).toEqual({
      status: 'skipped',
      reason: 'merged',
      duplicateOf: own,
    })

    expect(await feedOf(mirror)).toEqual({ status: 'paused', merged_into: own })
    const subs = await db.all<{ feed_id: number; deleted: number }>(
      sql`select feed_id, deleted_at is not null as deleted from subscriptions where user_id = 'u1' order by feed_id`,
    )
    expect(subs).toEqual([
      { feed_id: own, deleted: 0 },
      { feed_id: mirror, deleted: 1 },
    ])
    // Posts 5 and 6 were only in the mirror: they move across. The four shared stay behind.
    const ownPosts = await db.all<{ url: string }>(
      sql`select url from articles where feed_id = ${own} order by sort_at desc`,
    )
    expect(ownPosts.map((p) => p.url)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => server.url(`/posts/${n}`)),
    )
    // What u1 read in the mirror stays read in the canonical feed.
    const carried = await first<{ n: number }>(
      db,
      sql`select count(*) as n from user_article_states s join articles a on a.id = s.article_id
          where s.user_id = 'u1' and a.feed_id = ${own} and a.url = ${server.url('/posts/2')}
            and s.read_at is not null`,
    )
    expect(carried?.n).toBe(1)
  })

  test('adding or importing its URL afterwards subscribes to the canonical feed', async () => {
    server.text('/feed.xml', posts([1, 2, 3]))
    server.text('/mirror.xml', posts([1, 2, 3]))
    const own = await register('/feed.xml')
    const mirror = await register('/mirror.xml')
    await fetchNow(own)
    await fetchNow(mirror)
    await fetchNow(mirror)
    expect(await feedOf(mirror)).toMatchObject({ merged_into: own })

    const ingest = createIngest({ db, http, now: () => clock.now() })
    expect(
      await ingest.addFeed({ feedUrl: server.url('/mirror.xml'), actorId: null }),
    ).toMatchObject({ feedId: own, created: false })
    await addTestUser(db, 'u2')
    const url = new URL(server.url('/mirror.xml'))
    expect(
      await importFeedUrls(
        db,
        [{ feedUrl: url.toString(), host: url.hostname, origin: url.origin }],
        'u2',
        clock.now(),
      ),
    ).toEqual([own])
  })

  test('a feed carrying only some of the blog’s posts stays its own feed', async () => {
    server.text('/feed.xml', posts([1, 2, 3, 4, 5, 6]))
    server.text('/tech.xml', posts([2, 4, 6]))
    const all = await register('/feed.xml')
    const tech = await register('/tech.xml')
    await fetchNow(all)
    await fetchNow(tech)
    expect(await fetchNow(tech)).toMatchObject({ status: 'unchanged' })
    expect(await feedOf(tech)).toEqual({ status: 'active', merged_into: null })
  })
})
