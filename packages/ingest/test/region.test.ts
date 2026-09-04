import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { feeds, sites } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { eq } from 'drizzle-orm'
import { ensureFeed } from '../src/ensure-feed'
import { fetchFeed } from '../src/fetch-feed'
import { createHttpClient } from '../src/http'
import { RELAY_AFTER_TIMEOUTS, reprobeRelayRegions, timeoutsWarrantRelay } from '../src/region'
import { createRelayClient, createRelayHandler, fetchViaHandler } from '../src/relay'
import { FixtureServer, rss } from './fixture-server'

let t: TestDb
let server: FixtureServer
const NOW = new Date('2026-09-04T10:00:00Z')
const opts = { now: () => NOW, random: () => 0.5 }
const SECRET = 'relay-secret-for-tests'

function client(relay = false) {
  const base = {
    userAgent: 'TelaTest/1.0',
    politenessMs: 0,
    allowPrivateHosts: true,
    timeoutMs: 300,
  }
  if (!relay) return createHttpClient(base)
  const handler = createRelayHandler({
    secrets: [SECRET],
    allowPrivateHosts: true,
    timeoutMs: 2000,
  })
  return createHttpClient({
    ...base,
    relay: createRelayClient({
      relayUrl: 'http://relay.test',
      secret: SECRET,
      fetch: fetchViaHandler(handler),
    }),
  })
}

beforeAll(async () => {
  t = await startTestDb()
  server = await FixtureServer.start()
}, 120_000)
afterAll(async () => {
  await server.stop()
  await t?.stop()
})
beforeEach(async () => {
  server.reset()
  await resetDatabase(t.db)
})

async function feedRow(id: number) {
  const [row] = await t.db.select().from(feeds).where(eq(feeds.id, id))
  if (!row) throw new Error('feed missing')
  return row
}

const feedXml = () =>
  rss({
    link: server.url('/'),
    items: [1, 2].map((n) => ({
      guid: `p${n}`,
      link: server.url(`/p/${n}`),
      title: `Post ${n}`,
      description: `Summary ${n}`,
      content: `<p>${'Body text. '.repeat(80)}</p>`,
      date: `Thu, 0${n} Sep 2026 08:00:00 GMT`,
    })),
  })

describe('timeoutsWarrantRelay', () => {
  test('needs a relay, the global region, and the third consecutive timeout', () => {
    const policy = { relayAvailable: true, controlOk: async () => true }
    expect(timeoutsWarrantRelay({ fetchRegion: 'global', timeoutStreak: 0 }, policy)).toBe(false)
    expect(
      timeoutsWarrantRelay(
        { fetchRegion: 'global', timeoutStreak: RELAY_AFTER_TIMEOUTS - 1 },
        policy,
      ),
    ).toBe(true)
    expect(timeoutsWarrantRelay({ fetchRegion: 'cn', timeoutStreak: 9 }, policy)).toBe(false)
    expect(timeoutsWarrantRelay({ fetchRegion: 'global', timeoutStreak: 9 }, undefined)).toBe(false)
    expect(
      timeoutsWarrantRelay(
        { fetchRegion: 'global', timeoutStreak: 9 },
        { relayAvailable: false, controlOk: async () => true },
      ),
    ).toBe(false)
  })
})

describe('fetchFeed region flip', () => {
  test('moves a feed onto the relay after three timeouts when the control URL is fine', async () => {
    server.delay('/feed.xml', 800)
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    let controlChecks = 0
    const policy = {
      relayAvailable: true,
      controlOk: async () => {
        controlChecks += 1
        return true
      },
    }
    for (const n of [1, 2]) {
      const r = await fetchFeed(t.db, client(), feedId, { ...opts, region: policy })
      expect(r).toMatchObject({ status: 'error', kind: 'timeout' })
      expect((await feedRow(feedId)).timeoutStreak).toBe(n)
    }
    expect(controlChecks).toBe(0)
    const third = await fetchFeed(t.db, client(), feedId, { ...opts, region: policy })
    expect(third).toMatchObject({ status: 'error', kind: 'region_flip' })
    expect(controlChecks).toBe(1)
    const flipped = await feedRow(feedId)
    expect(flipped).toMatchObject({
      fetchRegion: 'cn',
      timeoutStreak: 0,
      errorCount: 3,
      regionFlippedAt: NOW,
      nextFetchAt: NOW,
    })
    expect(flipped.lastError).toContain('relay')

    // The next fetch goes through the relay, which reaches the origin fine.
    server.text('/feed.xml', feedXml())
    const viaRelay = await fetchFeed(t.db, client(true), feedId, opts)
    expect(viaRelay).toMatchObject({ status: 'fetched', newArticles: 2 })
    const healthy = await feedRow(feedId)
    expect(healthy).toMatchObject({ fetchRegion: 'cn', errorCount: 0, timeoutStreak: 0 })
  })

  test('stays global without a relay, when the control URL fails, or on server errors', async () => {
    server.delay('/feed.xml', 800)
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    for (let i = 0; i < 3; i++) await fetchFeed(t.db, client(), feedId, opts)
    expect(await feedRow(feedId)).toMatchObject({ fetchRegion: 'global', timeoutStreak: 3 })

    const noConnectivity = { relayAvailable: true, controlOk: async () => false }
    const r = await fetchFeed(t.db, client(), feedId, { ...opts, region: noConnectivity })
    expect(r).toMatchObject({ status: 'error', kind: 'timeout' })
    expect(await feedRow(feedId)).toMatchObject({ fetchRegion: 'global', timeoutStreak: 4 })

    // 5xx is the origin answering: it resets the timeout streak and never flips.
    server.text('/feed.xml', 'down', { status: 500 })
    const policy = { relayAvailable: true, controlOk: async () => true }
    await fetchFeed(t.db, client(), feedId, { ...opts, region: policy })
    expect(await feedRow(feedId)).toMatchObject({ fetchRegion: 'global', timeoutStreak: 0 })
  })
})

describe('reprobeRelayRegions', () => {
  test('returns week-old relay feeds to the global region and leaves recent ones', async () => {
    const [site] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://blog.example', title: 'Blog' })
      .returning()
    const day = 24 * 3600 * 1000
    const rows = await t.db
      .insert(feeds)
      .values([
        {
          siteId: site!.id,
          feedUrl: 'https://blog.example/old',
          fetchRegion: 'cn',
          regionFlippedAt: new Date(NOW.getTime() - 8 * day),
          timeoutStreak: 2,
        },
        {
          siteId: site!.id,
          feedUrl: 'https://blog.example/recent',
          fetchRegion: 'cn',
          regionFlippedAt: new Date(NOW.getTime() - 1 * day),
        },
        {
          siteId: site!.id,
          feedUrl: 'https://blog.example/legacy',
          fetchRegion: 'cn',
          createdAt: new Date(NOW.getTime() - 30 * day),
        },
        { siteId: site!.id, feedUrl: 'https://blog.example/global', fetchRegion: 'global' },
      ])
      .returning({ id: feeds.id, feedUrl: feeds.feedUrl })
    const byUrl = Object.fromEntries(rows.map((r) => [r.feedUrl.split('/').pop(), r.id]))
    const reprobed = await reprobeRelayRegions(t.db, NOW)
    expect(reprobed.sort()).toEqual([byUrl.old, byUrl.legacy].sort())
    expect(await feedRow(byUrl.old as number)).toMatchObject({
      fetchRegion: 'global',
      regionFlippedAt: NOW,
      timeoutStreak: 0,
    })
    expect(await feedRow(byUrl.recent as number)).toMatchObject({ fetchRegion: 'cn' })
    expect(await feedRow(byUrl.global as number)).toMatchObject({ regionFlippedAt: null })
  })
})
