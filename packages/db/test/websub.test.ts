import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  getWebsub,
  markWebsubFailed,
  markWebsubVerified,
  upsertWebsubPending,
  websubDueForRenewal,
} from '../src/queries'
import { feeds, sites, websubSubscriptions } from '../src/schema'
import { resetDatabase, startTestDb, type TestDb } from '../src/testing'

let t: TestDb
const NOW = new Date('2026-09-04T10:00:00Z')
const day = 24 * 3600 * 1000

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)
afterAll(async () => {
  await t?.stop()
})

async function feed(url: string) {
  const [site] = await t.db
    .insert(sites)
    .values({ homeUrl: new URL(url).origin, title: 'Blog' })
    .onConflictDoNothing()
    .returning()
  const siteId =
    site?.id ??
    (await t.db.select({ id: sites.id }).from(sites).limit(1)).at(0)?.id ??
    (() => {
      throw new Error('no site')
    })()
  const [row] = await t.db
    .insert(feeds)
    .values({ siteId, feedUrl: url, hubUrl: 'https://hub.example' })
    .returning()
  return row!
}

beforeEach(async () => {
  await resetDatabase(t.db)
  await t.db.delete(websubSubscriptions)
})

describe('websub subscriptions', () => {
  test('pending → verified → failed, keyed by feed and topic', async () => {
    const f = await feed('https://blog.example/feed.xml')
    expect(await getWebsub(t.db, f.id)).toBeNull()
    const pending = await upsertWebsubPending(
      t.db,
      { feedId: f.id, hubUrl: 'https://hub.example', topicUrl: f.feedUrl, secret: 'abc' },
      NOW,
    )
    expect(pending).toMatchObject({ status: 'pending', secret: 'abc', requestedAt: NOW })

    expect(await markWebsubVerified(t.db, f.id, 'https://other/topic', 600, NOW)).toBeNull()
    const active = await markWebsubVerified(t.db, f.id, f.feedUrl, 600, NOW)
    expect(active).toMatchObject({
      status: 'active',
      leaseUntil: new Date(NOW.getTime() + 600_000),
      verifiedAt: NOW,
    })
    // A renewal keeps the row and moves it back to pending with a fresh secret.
    const renewed = await upsertWebsubPending(
      t.db,
      { feedId: f.id, hubUrl: 'https://hub.example', topicUrl: f.feedUrl, secret: 'def' },
      NOW,
    )
    expect(renewed).toMatchObject({ status: 'pending', secret: 'def' })
    await markWebsubFailed(t.db, f.id, 'hub responded 500')
    expect(await getWebsub(t.db, f.id)).toMatchObject({
      status: 'failed',
      lastError: 'hub responded 500',
    })
    expect(await markWebsubVerified(t.db, f.id, f.feedUrl, 600, NOW)).toBeNull()
  })

  test('renewal picks leases ending soon, stale pendings, and week-old failures', async () => {
    const soon = await feed('https://a.example/feed')
    const later = await feed('https://b.example/feed')
    const stale = await feed('https://c.example/feed')
    const fresh = await feed('https://d.example/feed')
    const failedOld = await feed('https://e.example/feed')
    const failedNew = await feed('https://f.example/feed')
    const rows = [
      { feed: soon, status: 'active' as const, leaseUntil: new Date(NOW.getTime() + 1 * day) },
      { feed: later, status: 'active' as const, leaseUntil: new Date(NOW.getTime() + 5 * day) },
      { feed: stale, status: 'pending' as const, requestedAt: new Date(NOW.getTime() - 2 * day) },
      { feed: fresh, status: 'pending' as const, requestedAt: new Date(NOW.getTime() - 1000) },
      { feed: failedOld, status: 'failed' as const, updatedAt: new Date(NOW.getTime() - 8 * day) },
      { feed: failedNew, status: 'failed' as const, updatedAt: new Date(NOW.getTime() - 1 * day) },
    ]
    for (const r of rows) {
      await t.db.insert(websubSubscriptions).values({
        feedId: r.feed.id,
        hubUrl: 'https://hub.example',
        topicUrl: r.feed.feedUrl,
        secret: 's',
        status: r.status,
        leaseUntil: 'leaseUntil' in r ? r.leaseUntil : null,
        requestedAt: 'requestedAt' in r ? r.requestedAt : NOW,
        updatedAt: 'updatedAt' in r ? r.updatedAt : NOW,
      })
    }
    const due = await websubDueForRenewal(t.db, NOW)
    expect(due.sort()).toEqual([soon.id, stale.id, failedOld.id].sort())
  })
})
