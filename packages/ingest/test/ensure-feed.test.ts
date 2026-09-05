import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { feeds, sites } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { eq, sql } from 'drizzle-orm'
import { ensureFeed } from '../src/ensure-feed'

let t: TestDb
const userA = '11111111-1111-4111-8111-111111111111'
const userB = '22222222-2222-4222-8222-222222222222'

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)

afterAll(async () => {
  await t?.stop()
})

beforeEach(async () => {
  await resetDatabase(t.db)
  await t.db.execute(
    sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
  )
})

async function homeOf(siteId: number): Promise<string | undefined> {
  const [row] = await t.db
    .select({ homeUrl: sites.homeUrl })
    .from(sites)
    .where(eq(sites.id, siteId))
  return row?.homeUrl
}

describe('ensureFeed', () => {
  test('keys the site by the declared home, or by the feed host without one', async () => {
    const declared = await ensureFeed(t.db, {
      feedUrl: 'https://feeds.host.example/blog',
      homeUrl: 'https://blog.example/',
    })
    expect(declared).toMatchObject({ created: true, siteHome: 'declared' })
    expect(await homeOf(declared.siteId)).toBe('https://blog.example')
    const bare = await ensureFeed(t.db, { feedUrl: 'https://feeds.host.example/other' })
    expect(bare.siteHome).toBe('placeholder')
    expect(await homeOf(bare.siteId)).toBe('https://feeds.host.example')
  })

  test('a declared home that another member claimed is not honoured; the claimant may use it', async () => {
    const [claimed] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://victim.example', claimedBy: userB, listing: 'listed' })
      .returning({ id: sites.id })
    // A feed on another host declaring the victim's home lands on its own placeholder.
    const hostile = await ensureFeed(t.db, {
      feedUrl: 'https://attacker.example/feed.xml',
      homeUrl: 'https://victim.example/',
      actorId: userA,
    })
    expect(hostile.siteHome).toBe('placeholder')
    expect(hostile.siteId).not.toBe(claimed!.id)
    expect(await homeOf(hostile.siteId)).toBe('https://attacker.example')
    // The same without an actor (CLI, seed) is refused too.
    const anonymous = await ensureFeed(t.db, {
      feedUrl: 'https://other.example/feed.xml',
      homeUrl: 'https://victim.example/',
    })
    expect(anonymous.siteId).not.toBe(claimed!.id)
    // The claimant can attach a feed hosted elsewhere to their own site.
    const owner = await ensureFeed(t.db, {
      feedUrl: 'https://feeds.host.example/victim',
      homeUrl: 'https://victim.example/',
      actorId: userB,
    })
    expect(owner).toMatchObject({ siteId: claimed!.id, siteHome: 'declared' })
    // A feed on the claimed site's own host belongs to it regardless of who adds it.
    const sameHost = await ensureFeed(t.db, {
      feedUrl: 'https://victim.example/feed.xml',
      homeUrl: 'https://victim.example/',
      actorId: userA,
    })
    expect(sameHost.siteId).toBe(claimed!.id)
    const rows = await t.db
      .select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.siteId, claimed!.id))
    expect(rows).toHaveLength(2)
  })
})
