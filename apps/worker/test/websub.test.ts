import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { feeds, sites } from '@tela/db'
import { getWebsub } from '@tela/db/queries'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { subscribeFeedToHub, websubNeedsRequest } from '../src/websub/subscribe'
import { FixtureServer } from './fixture-server'

let t: TestDb
let hub: FixtureServer
const NOW = new Date('2026-09-04T10:00:00Z')
const day = 24 * 3600 * 1000

beforeAll(async () => {
  t = await startTestDb()
  hub = await FixtureServer.start()
}, 120_000)
afterAll(async () => {
  await hub.stop()
  await t?.stop()
})
beforeEach(async () => {
  hub.reset()
  await resetDatabase(t.db)
})

let seq = 0
async function feed(hubUrl: string | null) {
  const origin = `https://blog${++seq}.example`
  const [site] = await t.db.insert(sites).values({ homeUrl: origin, title: 'Blog' }).returning()
  const [row] = await t.db
    .insert(feeds)
    .values({ siteId: site!.id, feedUrl: `${origin}/feed.xml`, hubUrl })
    .returning()
  return row!
}

function acceptingHub(status = 202) {
  const forms: URLSearchParams[] = []
  hub.set('/hub', (req, res) => {
    let data = ''
    req.on('data', (c) => {
      data += c
    })
    req.on('end', () => {
      forms.push(new URLSearchParams(data))
      res.writeHead(status)
      res.end()
    })
  })
  return forms
}

const deps = () => ({ db: t.db, publicUrl: 'https://tela.app', allowPrivateHosts: true })

describe('subscribeFeedToHub', () => {
  test('records a pending subscription, posts to the hub, and keeps the secret on renewal', async () => {
    const forms = acceptingHub()
    const f = await feed(hub.url('/hub'))
    expect(await subscribeFeedToHub(deps(), f.id)).toEqual({
      status: 'requested',
      hubUrl: hub.url('/hub'),
    })
    const row = await getWebsub(t.db, f.id)
    expect(row).toMatchObject({ status: 'pending', topicUrl: f.feedUrl, hubUrl: hub.url('/hub') })
    expect(row?.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.fromEntries(forms[0]?.entries() ?? [])).toEqual({
      'hub.mode': 'subscribe',
      'hub.topic': f.feedUrl,
      'hub.callback': `https://tela.app/api/websub/${f.id}`,
      'hub.secret': row?.secret ?? '',
      'hub.lease_seconds': '864000',
    })
    await subscribeFeedToHub(deps(), f.id)
    expect((await getWebsub(t.db, f.id))?.secret).toBe(row?.secret as string)
    expect(forms).toHaveLength(2)
  })

  test('marks the row failed when the hub refuses, and skips feeds without a hub', async () => {
    acceptingHub(500)
    const f = await feed(hub.url('/hub'))
    expect(await subscribeFeedToHub(deps(), f.id)).toMatchObject({
      status: 'failed',
      reason: 'hub responded 500',
    })
    expect(await getWebsub(t.db, f.id)).toMatchObject({
      status: 'failed',
      lastError: 'hub responded 500',
    })
    const plain = await feed(null)
    expect(await subscribeFeedToHub(deps(), plain.id)).toEqual({
      status: 'skipped',
      reason: 'no hub',
    })
    expect(await subscribeFeedToHub(deps(), 999_999)).toEqual({
      status: 'skipped',
      reason: 'feed not found',
    })
  })
})

describe('websubNeedsRequest', () => {
  const base = {
    feedId: 1,
    hubUrl: 'h',
    topicUrl: 't',
    secret: 's',
    lastError: null,
    verifiedAt: null,
    leaseUntil: null,
    requestedAt: NOW,
    updatedAt: NOW,
  }
  test('asks when missing, near lease end, stale pending, or old failure', () => {
    expect(websubNeedsRequest(null, NOW)).toBe(true)
    expect(
      websubNeedsRequest(
        { ...base, status: 'active', leaseUntil: new Date(NOW.getTime() + 5 * day) },
        NOW,
      ),
    ).toBe(false)
    expect(
      websubNeedsRequest(
        { ...base, status: 'active', leaseUntil: new Date(NOW.getTime() + 1 * day) },
        NOW,
      ),
    ).toBe(true)
    expect(websubNeedsRequest({ ...base, status: 'pending' }, NOW)).toBe(false)
    expect(
      websubNeedsRequest(
        { ...base, status: 'pending', requestedAt: new Date(NOW.getTime() - 2 * day) },
        NOW,
      ),
    ).toBe(true)
    expect(websubNeedsRequest({ ...base, status: 'failed' }, NOW)).toBe(false)
    expect(
      websubNeedsRequest(
        { ...base, status: 'failed', updatedAt: new Date(NOW.getTime() - 8 * day) },
        NOW,
      ),
    ).toBe(true)
  })
})
