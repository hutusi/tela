import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  curateSite,
  deleteFeedIfUnused,
  discoverLanguageCounts,
  getOrCreateClaim,
  getSitePage,
  listDiscoverSites,
  markClaimResult,
  setSiteTopics,
  subscribe,
  unsubscribe,
} from '../src/queries'
import { articles, feeds, siteClaims, sites } from '../src/schema'
import { resetDatabase, startTestDb, type TestDb } from '../src/testing'

let t: TestDb
const userA = '11111111-1111-4111-8111-111111111111'
const userB = '22222222-2222-4222-8222-222222222222'

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)

afterAll(async () => {
  await t?.stop()
})

async function seed() {
  await t.db.execute(
    sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
  )
  const rows = await t.db
    .insert(sites)
    .values([
      {
        homeUrl: 'https://listed.example',
        title: 'Listed',
        listing: 'listed',
        primaryLang: 'en',
        topics: ['tech'],
      },
      {
        homeUrl: 'https://featured.example',
        title: 'Featured',
        listing: 'featured',
        primaryLang: 'zh-Hans',
        topics: ['tech', 'life'],
      },
      {
        homeUrl: 'https://private.example',
        title: 'Private',
        listing: 'private',
        primaryLang: 'en',
      },
    ])
    .returning()
  const byTitle = Object.fromEntries(rows.map((r) => [r.title as string, r]))
  const feedRows = await t.db
    .insert(feeds)
    .values(rows.map((s) => ({ siteId: s.id, feedUrl: `${s.homeUrl}/feed` })))
    .returning()
  const feedBySite = Object.fromEntries(feedRows.map((f) => [f.siteId, f]))
  await t.db.insert(articles).values([
    {
      feedId: feedBySite[byTitle.Listed!.id]!.id,
      dedupKey: 'l1',
      title: 'Listed post',
      publishedAt: new Date(),
    },
    {
      feedId: feedBySite[byTitle.Listed!.id]!.id,
      dedupKey: 'l0',
      title: 'Old post',
      publishedAt: new Date(Date.now() - 90 * 86400_000),
    },
  ])
  return { byTitle, feedBySite }
}

let s: Awaited<ReturnType<typeof seed>>

beforeEach(async () => {
  await resetDatabase(t.db)
  s = await seed()
})

describe('discover', () => {
  test('lists only listed and featured sites, featured first, with card data', async () => {
    const all = await listDiscoverSites(t.db, { userId: userA })
    expect(all.map((x) => x.title)).toEqual(['Featured', 'Listed'])
    const listed = all[1]!
    expect(listed.feedId).toBe(s.feedBySite[s.byTitle.Listed!.id]!.id)
    expect(listed.latestTitle).toBe('Listed post')
    expect(listed.postsLast30d).toBe(1)
    expect(listed.isSubscribed).toBe(false)
    expect(listed.claimed).toBe(false)
    expect(typeof listed.id).toBe('number')
  })

  test('filters by topic and language, and counts languages', async () => {
    expect((await listDiscoverSites(t.db, { topic: 'life' })).map((x) => x.title)).toEqual([
      'Featured',
    ])
    expect((await listDiscoverSites(t.db, { lang: 'en' })).map((x) => x.title)).toEqual(['Listed'])
    expect((await listDiscoverSites(t.db, { topic: 'nonsense' })).length).toBe(2) // ignored
    expect(await discoverLanguageCounts(t.db)).toEqual([
      { lang: 'en', count: 1 },
      { lang: 'zh-Hans', count: 1 },
    ])
    expect(await discoverLanguageCounts(t.db, 'life')).toEqual([{ lang: 'zh-Hans', count: 1 }])
  })

  test('subscribing updates reader counts and the subscribed flag', async () => {
    const feedId = s.feedBySite[s.byTitle.Listed!.id]!.id
    await subscribe(t.db, userA, feedId)
    await subscribe(t.db, userB, feedId)
    let [site] = await listDiscoverSites(t.db, { lang: 'en', userId: userA })
    expect(site?.readerCount).toBe(2)
    expect(site?.isSubscribed).toBe(true)
    await unsubscribe(t.db, userA, feedId)
    ;[site] = await listDiscoverSites(t.db, { lang: 'en', userId: userA })
    expect(site?.readerCount).toBe(1)
    expect(site?.isSubscribed).toBe(false)
  })

  test('site page shows feeds, recent articles, and ownership', async () => {
    const siteId = s.byTitle.Listed!.id
    const page = await getSitePage(t.db, siteId, userA)
    expect(page?.feeds).toHaveLength(1)
    expect(page?.articles.map((a) => a.title)).toEqual(['Listed post', 'Old post'])
    expect(page?.isOwner).toBe(false)
    expect(page?.claimant).toBeNull()
    expect(await getSitePage(t.db, 999999, null)).toBeNull()
  })

  test('claims: create, reuse, verify, list the site, and let the owner set topics', async () => {
    const siteId = s.byTitle.Private!.id
    const claim = await getOrCreateClaim(t.db, siteId, userA)
    expect(claim.status).toBe('pending')
    expect(claim.token).toMatch(/^[0-9a-f]{32}$/)
    expect((await getOrCreateClaim(t.db, siteId, userA)).id).toBe(claim.id)

    await markClaimResult(t.db, claim.id, { ok: false, error: 'meta tag not found' })
    expect((await t.db.select().from(siteClaims))[0]?.status).toBe('failed')
    expect((await listDiscoverSites(t.db)).map((x) => x.title)).not.toContain('Private')

    await markClaimResult(t.db, claim.id, { ok: true, method: 'meta' })
    const [site] = await t.db.select().from(sites).where(sql`id = ${siteId}`)
    expect(site?.claimedBy).toBe(userA)
    expect(site?.listing).toBe('listed')
    expect((await listDiscoverSites(t.db)).map((x) => x.title)).toContain('Private')
    const page = await getSitePage(t.db, siteId, userA)
    expect(page?.isOwner).toBe(true)
    expect(page?.claimant?.handle).toMatch(/^u_/)

    expect(await setSiteTopics(t.db, siteId, userB, ['tech'])).toBe(false)
    expect(await setSiteTopics(t.db, siteId, userA, ['tech', 'bogus', 'tech'])).toBe(true)
    expect((await getSitePage(t.db, siteId, null))?.site.topics).toEqual(['tech'])
  })

  test('a verified claim is not overwritten by a later verifier; one claim per user and site', async () => {
    const siteId = s.byTitle.Private!.id
    const a = await getOrCreateClaim(t.db, siteId, userA)
    expect(await markClaimResult(t.db, a.id, { ok: true, method: 'meta' })).toBe('verified')

    const [b1, b2] = await Promise.all([
      getOrCreateClaim(t.db, siteId, userB),
      getOrCreateClaim(t.db, siteId, userB),
    ])
    expect(b2.id).toBe(b1.id)
    expect(await markClaimResult(t.db, b1.id, { ok: true, method: 'rel_me' })).toBe('conflict')
    const [site] = await t.db.select().from(sites).where(sql`id = ${siteId}`)
    expect(site?.claimedBy).toBe(userA)
    const [bRow] = await t.db.select().from(siteClaims).where(sql`id = ${b1.id}`)
    expect(bRow?.status).toBe('failed')
    expect(bRow?.error).toMatch(/already claimed/)

    // The owner verifying again keeps the site.
    expect(await markClaimResult(t.db, a.id, { ok: true, method: 'meta' })).toBe('verified')
    expect(await markClaimResult(t.db, 999999, { ok: false, error: 'x' })).toBe('missing')
  })
})

describe('curateSite', () => {
  test('features a private site with editorial topics, and says what changed', async () => {
    const siteId = s.byTitle.Private!.id
    const r = await curateSite(t.db, siteId, {
      listing: 'featured',
      topics: ['tech', 'bogus', 'tech'],
    })
    expect(r).toMatchObject({
      siteId,
      listing: 'featured',
      topics: ['tech'],
      listingChanged: true,
      topicsChanged: true,
      claimed: false,
      withheld: null,
    })
    expect((await listDiscoverSites(t.db)).map((x) => x.title)).toContain('Private')
    // 'Listed' is also en+tech, so featuring 'Private' takes the language menu from one to two.
    expect(await discoverLanguageCounts(t.db, 'tech')).toContainEqual({ lang: 'en', count: 2 })
    expect(await curateSite(t.db, 999999, { listing: 'featured' })).toBeNull()
  })

  test('a re-run changes nothing and does not touch updated_at', async () => {
    const siteId = s.byTitle.Private!.id
    const input = { listing: 'featured' as const, topics: ['tech'] }
    await curateSite(t.db, siteId, input)
    const before = (await t.db.select().from(sites).where(sql`id = ${siteId}`))[0]?.updatedAt
    const again = await curateSite(t.db, siteId, input)
    expect(again).toMatchObject({ listingChanged: false, topicsChanged: false, withheld: null })
    const after = (await t.db.select().from(sites).where(sql`id = ${siteId}`))[0]?.updatedAt
    expect(after).toEqual(before!)
  })

  test('rejected is sticky until forced', async () => {
    const siteId = s.byTitle.Private!.id
    await curateSite(t.db, siteId, { listing: 'rejected' })
    const held = await curateSite(t.db, siteId, { listing: 'featured', topics: ['tech'] })
    expect(held).toMatchObject({ listing: 'rejected', listingChanged: false, withheld: 'rejected' })
    expect((await listDiscoverSites(t.db)).map((x) => x.title)).not.toContain('Private')
    // Topics are still curated: only the listing is held back.
    expect(held?.topics).toEqual(['tech'])
    const forced = await curateSite(t.db, siteId, { listing: 'featured', force: true })
    expect(forced).toMatchObject({ listing: 'featured', listingChanged: true, withheld: null })
  })

  test("a claimant's topics survive a seed re-run, but the listing still moves", async () => {
    const siteId = s.byTitle.Private!.id
    const claim = await getOrCreateClaim(t.db, siteId, userA)
    await markClaimResult(t.db, claim.id, { ok: true, method: 'meta' })
    await setSiteTopics(t.db, siteId, userA, ['tech'])

    const r = await curateSite(t.db, siteId, { listing: 'featured', topics: ['food'] })
    expect(r).toMatchObject({
      listing: 'featured',
      topics: ['tech'],
      listingChanged: true,
      topicsChanged: false,
      claimed: true,
      withheld: 'claimed',
    })
  })
})

describe('deleteFeedIfUnused', () => {
  test('goes only when nothing depends on the feed', async () => {
    const siteId = s.byTitle.Featured!.id
    const [spare] = await t.db
      .insert(feeds)
      .values({ siteId, feedUrl: 'https://featured.example/spare.xml' })
      .returning()
    expect(await deleteFeedIfUnused(t.db, spare!.id)).toBe(true)
    expect(await deleteFeedIfUnused(t.db, spare!.id)).toBe(false) // already gone

    // A feed a member follows stays, even with no articles: the checks happen under a lock on
    // the feed row precisely so a subscription landing mid-flight is seen rather than cascaded
    // away by the delete.
    const [followed] = await t.db
      .insert(feeds)
      .values({ siteId, feedUrl: 'https://featured.example/followed.xml' })
      .returning()
    await subscribe(t.db, userA, followed!.id)
    expect(await deleteFeedIfUnused(t.db, followed!.id)).toBe(false)

    // And one carrying posts stays, whether or not anyone follows it: they can be read, liked
    // or recommended, and a cascade would take all of that with them.
    const withPosts = s.feedBySite[s.byTitle.Listed!.id]!
    expect(await deleteFeedIfUnused(t.db, withPosts.id)).toBe(false)
  })
})
