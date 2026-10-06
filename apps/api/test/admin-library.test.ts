/**
 * The admin console's library (ADR 0039): the Claims, Sites, Feeds and Discover ledgers and
 * records, and what an operator does there. Each action is checked against the work it can meet:
 * the doors that list a blog on a subscribe, a fetch or a check already running, the daily
 * reprobe, the claimant's own device.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, first, type Lease } from '@tela/data'
import { createHttpClient } from '@tela/ingest/http'
import { type IngestContext, ingestFeed, verifyClaimJob } from '@tela/ingest/pipeline'
import type {
  AdminActResponse,
  AdminClaimDetail,
  AdminClaimRow,
  AdminFeedDetail,
  AdminFeedRow,
  AdminList,
  AdminSiteDetail,
  AdminSiteRow,
} from '@tela/shared/admin'
import type { PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { FixtureServer, rss } from '../../../packages/ingest/test/fixture-server'
import { daily } from '../../jobs/src/daily'
import {
  ADMIN_TOKEN,
  codeFor,
  cookiesOf,
  createTestApi,
  memberHeaders,
  type SignedIn,
  type TestApi,
} from './helpers'

const MIN = 60_000
const DAY = 24 * 3600 * 1000

let server: FixtureServer
let api: TestApi
let ops: SignedIn

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
/**
 * Invite a member and sign them in, each from an address of their own: better-auth allows three
 * sign-ins from one address in ten seconds, and some tests here need four people.
 */
let addresses = 0
async function signedIn(email: string): Promise<SignedIn> {
  const invited = await api.request('/api/admin/invite', {
    body: { email },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  const { userId } = (await invited.json()) as { userId: string }
  const res = await api.request('/api/auth/sign-in/email-otp', {
    body: { email, otp: codeFor(api, email) },
    headers: { 'cf-connecting-ip': `10.9.0.${++addresses % 250}` },
  })
  expect(res.status).toBe(200)
  return { cookie: cookiesOf(res), userId, headers: memberHeaders(userId) }
}

beforeEach(async () => {
  server.reset()
  api = await createTestApi()
  ops = await signedIn('ops@x.test')
  const granted = await api.request('/api/admin/admins', {
    body: { email: 'ops@x.test', admin: true },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  expect(granted.status).toBe(200)
})

// ---------------------------------------------------------------------------------------------
// Fixtures: rows as the pipeline would have left them.

let homes = 0
async function addSite(
  o: {
    listing?: string
    claimedBy?: string | null
    title?: string | null
    home?: string
    readers?: number
    optOut?: number
    review?: 'listed' | 'dismissed' | null
    reviewedAt?: number | null
  } = {},
): Promise<number> {
  const now = api.clock.now()
  const home = o.home ?? `https://blog${++homes}.test`
  const [row] = await api.db.all<{ id: number }>(sql`
    insert into sites (home_url, title, listing, claimed_by, claimed_at, reader_count,
      translation_opt_out, declared_feed_urls, review, reviewed_at, created_at, updated_at)
    values (${home}, ${o.title ?? null}, ${o.listing ?? 'private'}, ${o.claimedBy ?? null},
      ${o.claimedBy ? now : null}, ${o.readers ?? 0}, ${o.optOut ?? 0},
      ${o.claimedBy ? JSON.stringify([`${home}/feed`]) : '[]'}, ${o.review ?? null},
      ${o.reviewedAt ?? null}, ${now}, ${now})
    returning id
  `)
  return row?.id ?? 0
}

/** A post on a feed, as a fetch would have stored it, `daysAgo` old. */
let posts = 0
async function addPost(feedId: number, o: { title?: string; daysAgo?: number } = {}) {
  const at = api.clock.now() - (o.daysAgo ?? 1) * DAY
  await api.db.run(sql`
    insert into articles (feed_id, dedup_key, title, fetched_at, sort_at)
    values (${feedId}, ${`post-${++posts}`}, ${o.title ?? `Post ${posts}`}, ${at}, ${at})
  `)
}

/** A blog a member added that a fetch has filled: what waits in Discover's review queue. */
async function addReviewable(o: { readers?: number; title?: string } = {}) {
  const site = await addSite({ readers: o.readers ?? 1, ...(o.title ? { title: o.title } : {}) })
  const feed = await addFeed(site)
  await addPost(feed)
  return { site, feed }
}

let feedUrls = 0
async function addFeed(
  siteId: number,
  o: {
    url?: string
    status?: string
    errors?: number
    timeouts?: number
    region?: string
    flippedAt?: number | null
    mergedInto?: number | null
    lastError?: string | null
    nextFetchAt?: number
  } = {},
): Promise<number> {
  const now = api.clock.now()
  const url = o.url ?? `https://feeds.test/${++feedUrls}.xml`
  const [row] = await api.db.all<{ id: number }>(sql`
    insert into feeds (site_id, feed_url, host, status, error_count, timeout_streak, fetch_region,
      region_flipped_at, merged_into, last_error, next_fetch_at, created_at, updated_at)
    values (${siteId}, ${url}, ${new URL(url).host}, ${o.status ?? 'active'}, ${o.errors ?? 0},
      ${o.timeouts ?? 0}, ${o.region ?? 'global'}, ${o.flippedAt ?? null}, ${o.mergedInto ?? null},
      ${o.lastError ?? null}, ${o.nextFetchAt ?? now + DAY}, ${now}, ${now})
    returning id
  `)
  return row?.id ?? 0
}

async function addClaim(
  siteId: number,
  userId: string,
  o: {
    status?: string
    error?: string | null
    checkedAt?: number | null
    reviewedAt?: number | null
    token?: string
  } = {},
): Promise<number> {
  const now = api.clock.now()
  const status = o.status ?? 'failed'
  const [row] = await api.db.all<{ id: number }>(sql`
    insert into site_claims (site_id, user_id, method, token, status, error, last_checked_at,
      reviewed_at, verified_at, created_at)
    values (${siteId}, ${userId}, 'meta', ${o.token ?? 'abcdef0123456789'}, ${status},
      ${o.error ?? (status === 'failed' ? 'no proof' : null)},
      ${o.checkedAt === undefined ? (status === 'pending' ? null : now) : o.checkedAt},
      ${o.reviewedAt ?? null}, ${status === 'verified' ? now : null}, ${now})
    returning id
  `)
  return row?.id ?? 0
}

/** A member with a handle the tests can search for. */
async function member(email: string, handle: string): Promise<SignedIn> {
  const who = await signedIn(email)
  await api.db.run(sql`update profiles set handle = ${handle} where user_id = ${who.userId}`)
  return who
}

/** tela-jobs' tick heartbeat, saying whether it runs with the China relay. */
async function heartbeat(relay: boolean) {
  await api.db.run(sql`
    insert into ops_heartbeats (name, at, info)
    values ('tick', ${api.clock.now()}, ${JSON.stringify({ config: { relay } })})
    on conflict (name) do update set info = excluded.info
  `)
}

// ---------------------------------------------------------------------------------------------
// Calls.

async function list<R>(area: string, f: string, q = '', as = ops) {
  const params = new URLSearchParams({ f })
  if (q) params.set('q', q)
  const res = await api.request(`/api/v1/admin/${area}?${params}`, { as })
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  return (await res.json()) as Omit<AdminList<R>, 'counts'> & { counts: Record<string, number> }
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

async function record<D>(area: string, id: number | string): Promise<D> {
  const res = await api.request(`/api/v1/admin/${area}/${id}`, { as: ops })
  expect(res.status).toBe(200)
  return (await res.json()) as D
}

async function act(action: string, targets: (number | string)[], args?: unknown) {
  const res = await api.request('/api/v1/admin/act', {
    as: ops,
    body: { action, ids: targets.map(String), ...(args ? { args } : {}) },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminActResponse
}

/** Act on one target and say how it went: `done`, or why not. */
async function outcome(action: string, target: number | string, args?: unknown) {
  const body = await act(action, [target], args)
  return body.done.length === 1 ? 'done' : body.failed[0]?.error
}

const undo = (group: string | undefined) =>
  api.request('/api/v1/admin/undo', { as: ops, body: { group } })

const one = <T>(db: TestApi['db'], query: ReturnType<typeof sql>) => first<T>(db, query)
const siteOf = (id: number) =>
  one<{
    listing: string
    claimed_by: string | null
    claimed_at: number | null
    declared_feed_urls: string
    translation_opt_out: number
    review: string | null
    reviewed_at: number | null
    seq: number
  }>(
    api.db,
    sql`select listing, claimed_by, claimed_at, declared_feed_urls, translation_opt_out,
      review, reviewed_at, seq from sites where id = ${id}`,
  )
const feedOf = (id: number) =>
  one<{
    status: string
    error_count: number
    fetch_region: string
    region_flipped_at: number | null
    timeout_streak: number
    next_fetch_at: number
    refetch_requested_at: number | null
    seq: number
  }>(
    api.db,
    sql`select status, error_count, fetch_region, region_flipped_at, timeout_streak, next_fetch_at,
      refetch_requested_at, seq from feeds where id = ${id}`,
  )
const claimOf = (id: number) =>
  one<{
    status: string
    error: string | null
    vouched_by: string | null
    reviewed_at: number | null
    seq: number
  }>(
    api.db,
    sql`select status, error, vouched_by, reviewed_at, seq from site_claims where id = ${id}`,
  )
const topicsOf = async (siteId: number) =>
  (
    await api.db.all<{ topic: string }>(
      sql`select topic from site_topics where site_id = ${siteId} order by topic`,
    )
  ).map((r) => r.topic)
const leaseOf = (kind: string, key: number) =>
  one<{ owner: string }>(
    api.db,
    sql`select owner from leases where kind = ${kind} and key = ${String(key)}`,
  )

/** Hold an item's lease as a worker that has just picked it up. */
async function hold(kind: Lease['kind'], key: number): Promise<Lease> {
  const got = await claimDue(api.db, {
    kind,
    owner: 'worker-1',
    now: api.clock.now(),
    ttlMs: 4 * MIN,
    limit: 1,
    due: sql`select ${key} as key, null as host, 0 as ord`,
  })
  expect(got).toHaveLength(1)
  return { kind, key: String(key), owner: 'worker-1' }
}

/** The pipeline as tela-jobs runs it, against this API's database and clock. */
const ingest = (): IngestContext => ({
  db: api.db,
  blobs: api.blobs,
  http: createHttpClient({
    userAgent: 'TelaTest/1.0',
    politenessMs: 0,
    allowPrivateHosts: true,
    timeoutMs: 2000,
  }),
  clock: api.clock,
  random: () => 0.5,
  publicUrl: 'https://tela.test',
})

/** Every member that subscribes to a feed, through the mutation a device pushes. */
let mids = 0
async function subscribe(who: SignedIn, feedId: number) {
  const res = await api.request('/api/v1/mutations', {
    as: who,
    body: {
      mutations: [{ mid: `lib-mid-${++mids}-pad`, at: api.clock.now(), type: 'subscribe', feedId }],
    },
  })
  expect(res.status).toBe(200)
}

// ---------------------------------------------------------------------------------------------

describe('the ledgers', () => {
  test('are an admin’s only', async () => {
    const reader = await signedIn('reader@x.test')
    const res = await api.request('/api/v1/admin/sites?f=discover', { as: reader })
    expect(res.status).toBe(403)
  })

  test('refuse a filter the area does not have, and open on its first without one', async () => {
    const bad = await api.request('/api/v1/admin/sites?f=nope', { as: ops })
    expect(bad.status).toBe(400)
    await addSite({ listing: 'listed' })
    const res = await api.request('/api/v1/admin/sites', { as: ops })
    expect(((await res.json()) as AdminList<AdminSiteRow>).rows).toHaveLength(1)
  })

  test('Sites: each filter, its count under the search, and a blog’s feeds and claims', async () => {
    const owner = await member('owner@x.test', 'kimchi_fan')
    const claimant = await member('claimant@x.test', 'jiwoo')
    const listed = await addSite({
      listing: 'listed',
      title: 'Kimchi Lab',
      claimedBy: owner.userId,
    })
    await addFeed(listed)
    const failing = await addSite({ listing: 'private', title: 'Pfadwerk', readers: 41 })
    await addFeed(failing, { errors: 3, lastError: 'http_404: Not Found' })
    const timing = await addSite({ listing: 'featured', title: '少数笔记' })
    await addFeed(timing, { errors: 6, timeouts: 6 })
    const dead = await addSite({ listing: 'private', title: 'Old Bits' })
    await addFeed(dead, { status: 'dead', errors: 30 })
    const disputed = await addSite({ listing: 'private', title: 'Monts' })
    await addFeed(disputed)
    await addClaim(disputed, claimant.userId)
    const hidden = await addSite({ listing: 'rejected', title: 'Spam' })

    const discover = await list<AdminSiteRow>('sites', 'discover')
    expect(discover.counts).toEqual({ discover: 2, private: 3, attention: 4, hidden: 1 })
    expect(ids(discover.rows).sort()).toEqual([String(listed), String(timing)].sort())
    expect(discover.truncated).toBe(false)
    const attention = await list<AdminSiteRow>('sites', 'attention')
    expect(ids(attention.rows).sort()).toEqual([failing, timing, dead, disputed].map(String).sort())
    const byId = new Map(attention.rows.map((r) => [r.siteId, r]))
    expect(byId.get(failing)).toMatchObject({
      feedHealth: 'failing',
      feedCount: 1,
      readerCount: 41,
      // A failing feed: fetching it again is the likeliest fix.
      actions: ['site.fetchAll', 'site.feature', 'site.list', 'site.hide'],
    })
    expect(byId.get(timing)?.feedHealth).toBe('timeout')
    expect(byId.get(dead)?.feedHealth).toBe('dead')
    expect(byId.get(disputed)).toMatchObject({ feedHealth: 'ok', claimFailing: true })
    expect((await list<AdminSiteRow>('sites', 'hidden')).rows[0]).toMatchObject({
      siteId: hidden,
      feedHealth: 'none',
      actions: ['site.restore'],
    })
    const mine = discover.rows.find((r) => r.siteId === listed)
    expect(mine).toMatchObject({
      owner: { id: owner.userId, handle: 'kimchi_fan' },
      actions: ['site.feature', 'site.hide', 'site.fetchAll'],
    })

    // The search: a title, an owner's handle, a feed's address; the counts follow it.
    const kimchi = await list<AdminSiteRow>('sites', 'discover', 'KIMCHI')
    expect(ids(kimchi.rows)).toEqual([String(listed)])
    expect(kimchi.counts).toEqual({ discover: 1, private: 0, attention: 0, hidden: 0 })
    expect(ids((await list<AdminSiteRow>('sites', 'discover', 'kimchi_fan')).rows)).toEqual([
      String(listed),
    ])
    const feedUrl = await one<{ feed_url: string }>(
      api.db,
      sql`select feed_url from feeds where site_id = ${dead}`,
    )
    const byFeed = await list<AdminSiteRow>('sites', 'attention', feedUrl?.feed_url ?? '')
    expect(ids(byFeed.rows)).toEqual([String(dead)])
  })

  test('the search takes % and _ literally', async () => {
    await addSite({ listing: 'listed', title: '100% Rye' })
    await addSite({ listing: 'listed', title: '100 Rye' })
    await addSite({ listing: 'listed', title: 'snake_case' })
    await addSite({ listing: 'listed', title: 'snakeXcase' })
    expect((await list<AdminSiteRow>('sites', 'discover', '0%')).rows).toHaveLength(1)
    expect((await list<AdminSiteRow>('sites', 'discover', 'e_c')).rows).toHaveLength(1)
  })

  test('says when a filter holds more than it sends', async () => {
    const now = api.clock.now()
    await api.db.run(sql`
      insert into sites (home_url, listing, created_at, updated_at)
      select 'https://many' || value || '.test', 'rejected', ${now}, ${now}
      from json_each(${JSON.stringify(Array.from({ length: 501 }, (_, i) => i))}) where true
    `)
    const hidden = await list<AdminSiteRow>('sites', 'hidden')
    expect(hidden.rows).toHaveLength(500)
    expect(hidden.truncated).toBe(true)
    expect(hidden.counts.hidden).toBe(501)
  })

  test('Discover: the review queue first, then featured, listed, not for Discover and hidden', async () => {
    const owner = await member('owner@x.test', 'owner')
    const featured = await addSite({ listing: 'featured' })
    const listed = await addSite({ listing: 'listed' })
    const few = await addReviewable({ readers: 1, title: 'Few' })
    const many = await addReviewable({ readers: 2, title: 'Many' })
    const dismissed = await addSite({
      readers: 2,
      review: 'dismissed',
      reviewedAt: api.clock.now() - DAY,
    })
    await addPost(await addFeed(dismissed))
    await addSite({ listing: 'private', claimedBy: owner.userId, readers: 9 })
    const hidden = await addSite({ listing: 'rejected' })
    await addFeed(listed)

    // The area opens on To review.
    const res = await api.request('/api/v1/admin/discover', { as: ops })
    const opened = (await res.json()) as AdminList<AdminSiteRow, 'discover'>
    expect(Object.keys(opened.counts)).toEqual([
      'candidates',
      'featured',
      'listed',
      'dismissed',
      'hidden',
    ])
    expect(opened.counts).toEqual({
      candidates: 2,
      featured: 1,
      listed: 1,
      dismissed: 1,
      hidden: 1,
    })
    expect(ids(opened.rows)).toEqual([String(many.site), String(few.site)])
    expect(opened.rows[0]).toMatchObject({
      actions: ['site.list', 'site.dismiss', 'site.feature', 'site.hide'],
      title: 'Many',
      readerCount: 2,
      postsLast30d: 1,
      latestTitle: expect.any(String),
      latestAt: api.clock.now() - DAY,
      review: null,
      reviewedAt: null,
      owner: null,
    })
    const rows = async (f: string) => (await list<AdminSiteRow>('discover', f)).rows
    expect((await rows('featured'))[0]).toMatchObject({
      siteId: featured,
      actions: ['site.restore', 'site.hide'],
    })
    // Discover offers the listing alone: fetching is the Sites ledger's.
    expect((await rows('listed'))[0]).toMatchObject({
      siteId: listed,
      actions: ['site.feature', 'site.hide'],
    })
    // Decided against, and still a blog the doors may list: no Not for Discover twice.
    expect((await rows('dismissed'))[0]).toMatchObject({
      siteId: dismissed,
      actions: ['site.feature', 'site.list', 'site.hide'],
      review: 'dismissed',
      reviewedAt: api.clock.now() - DAY,
    })
    expect((await rows('hidden'))[0]).toMatchObject({ siteId: hidden, actions: ['site.restore'] })
    // The Sites ledger leaves the review to Discover, and keeps room to fetch.
    const site = await record<AdminSiteDetail>('sites', few.site)
    expect(site.site.actions).toEqual(['site.feature', 'site.list', 'site.hide', 'site.fetchAll'])
  })

  test('the review queue holds only blogs a member added that wait on a decision', async () => {
    const owner = await member('owner@x.test', 'owner')
    const waiting = await addReviewable()
    // Claimed: the claim listed it, or will.
    const claimed = await addSite({ claimedBy: owner.userId, readers: 1 })
    await addPost(await addFeed(claimed))
    // Unfetched: an OPML placeholder with no post yet.
    await addFeed(await addSite({ readers: 1 }))
    // Its only feed died, or merged into another blog's.
    const dead = await addSite({ readers: 1 })
    await addPost(await addFeed(dead, { status: 'dead' }))
    const merged = await addSite({ readers: 1 })
    await addPost(await addFeed(merged, { status: 'paused', mergedInto: waiting.feed }))
    // Nobody reads it any more.
    await addPost(await addFeed(await addSite({ readers: 0 })))
    // Decided already.
    const reviewed = await addSite({
      readers: 1,
      review: 'dismissed',
      reviewedAt: api.clock.now(),
    })
    await addPost(await addFeed(reviewed))

    // Who added it is what they read: neither the row nor the record names them (ADR 0039).
    const adder = await member('adder@x.test', 'the_adder')
    await api.db.run(sql`update feeds set added_by = ${adder.userId} where id = ${waiting.feed}`)
    await subscribe(adder, waiting.feed)

    const queue = await list<AdminSiteRow>('discover', 'candidates')
    expect(ids(queue.rows)).toEqual([String(waiting.site)])
    expect(queue.counts.candidates).toBe(1)
    const shown = JSON.stringify([queue, await record<AdminSiteDetail>('sites', waiting.site)])
    expect(shown).not.toContain(adder.userId)
    expect(shown).not.toContain('the_adder')
  })

  test('Claims: the review queue, checks in flight, and verified claims, disputes named', async () => {
    const owner = await member('owner@x.test', 'kimchi_fan')
    const claimant = await member('claimant@x.test', 'jiwoo')
    const now = api.clock.now()
    const open = await addSite({ title: 'Open', readers: 4 })
    const failed = await addClaim(open, claimant.userId, { error: 'home page returned HTTP 403' })
    const owned = await addSite({ title: 'Owned', claimedBy: owner.userId, listing: 'listed' })
    const dispute = await addClaim(owned, claimant.userId)
    const verified = await addClaim(owned, owner.userId, { status: 'verified' })
    // Reviewed after its last check: out of the queue. Checked again since: back in it.
    const reviewed = await addClaim(await addSite(), claimant.userId, { reviewedAt: now + 1 })
    const again = await addClaim(await addSite(), claimant.userId, {
      checkedAt: now,
      reviewedAt: now - MIN,
    })
    const checking = await addClaim(await addSite({ title: 'Checking' }), owner.userId, {
      status: 'pending',
    })
    await api.db.run(sql`
      insert into leases (kind, key, owner, until, attempts, not_before)
      values ('site.claim', ${String(checking)}, 'w', 0, 2, ${now + 5 * MIN})
    `)

    const review = await list<AdminClaimRow>('claims', 'review')
    expect(review.counts).toEqual({ review: 3, checking: 1, verified: 1 })
    expect(ids(review.rows).sort()).toEqual([failed, dispute, again].map(String).sort())
    expect(ids(review.rows)).not.toContain(String(reviewed))
    const byId = new Map(review.rows.map((r) => [r.claimId, r]))
    expect(byId.get(failed)).toMatchObject({
      siteTitle: 'Open',
      readerCount: 4,
      claimant: { handle: 'jiwoo' },
      owner: null,
      error: 'home page returned HTTP 403',
      actions: ['claim.recheck', 'claim.vouch', 'claim.reject', 'claim.dismiss'],
    })
    // A blog someone else holds: a vouch would only be refused, so it is not offered.
    expect(byId.get(dispute)).toMatchObject({
      owner: { id: owner.userId, handle: 'kimchi_fan' },
      actions: ['claim.recheck', 'claim.reject', 'claim.dismiss'],
    })
    const inFlight = (await list<AdminClaimRow>('claims', 'checking')).rows[0]
    expect(inFlight).toMatchObject({
      claimId: checking,
      attempts: 2,
      nextTry: now + 5 * MIN,
      actions: ['claim.vouch', 'claim.reject'],
    })
    expect((await list<AdminClaimRow>('claims', 'verified')).rows[0]).toMatchObject({
      claimId: verified,
      owner: null,
      actions: ['claim.remove'],
    })
    expect(ids((await list<AdminClaimRow>('claims', 'review', 'kimchi')).rows)).toEqual([
      String(dispute),
    ])

    const detail = await record<AdminClaimDetail>('claims', failed)
    expect(detail.tokenHead).toBe('abcdef01')
    expect(detail.claim.claimId).toBe(failed)
    expect(detail.history).toEqual([])
    expect((await api.request('/api/v1/admin/claims/999', { as: ops })).status).toBe(404)
    expect((await api.request('/api/v1/admin/claims/x', { as: ops })).status).toBe(404)
  })

  test('Feeds: failing, timing out, dead, paused and merged, with the relay where there is one', async () => {
    const site = await addSite({ title: 'Blog' })
    const failing = await addFeed(site, { errors: 2, lastError: 'parse: unescaped &' })
    const timing = await addFeed(site, { errors: 4, timeouts: 4 })
    const relayed = await addFeed(site, { errors: 3, timeouts: 3, region: 'cn' })
    const dead = await addFeed(site, { status: 'dead', errors: 30 })
    const paused = await addFeed(site, { status: 'paused' })
    const merged = await addFeed(site, { status: 'paused', mergedInto: failing })
    await addFeed(site)

    const failingList = await list<AdminFeedRow>('feeds', 'failing')
    expect(failingList.counts).toEqual({
      failing: 1,
      timeout: 2,
      dead: 1,
      paused: 1,
      merged: 1,
      fetching: 1,
    })
    expect(failingList.rows[0]).toMatchObject({
      feedId: failing,
      siteTitle: 'Blog',
      lastError: 'parse: unescaped &',
      actions: ['feed.fetch', 'feed.pause'],
    })
    const timeout = async () => (await list<AdminFeedRow>('feeds', 'timeout')).rows
    expect(new Map((await timeout()).map((r) => [r.feedId, r.actions]))).toEqual(
      new Map([
        [timing, ['feed.fetch', 'feed.pause']],
        // On the relay, going direct is offered with or without one.
        [relayed, ['feed.fetch', 'feed.pause', 'feed.global']],
      ]),
    )
    await heartbeat(true)
    expect((await timeout()).find((r) => r.feedId === timing)?.actions).toEqual([
      'feed.fetch',
      'feed.pause',
      'feed.relay',
    ])
    const actionsIn = async (f: string) => (await list<AdminFeedRow>('feeds', f)).rows[0]?.actions
    expect(await actionsIn('dead')).toEqual(['feed.revive'])
    expect(await actionsIn('paused')).toEqual(['feed.resume'])
    expect((await list<AdminFeedRow>('feeds', 'merged')).rows[0]).toMatchObject({
      feedId: merged,
      mergedInto: failing,
      actions: [],
    })
    expect((await list<AdminFeedRow>('feeds', 'paused')).rows[0]?.feedId).toBe(paused)
    expect((await list<AdminFeedRow>('feeds', 'dead')).rows[0]?.feedId).toBe(dead)

    const detail = await record<AdminFeedDetail>('feeds', timing)
    expect(detail).toMatchObject({ relay: true, feed: { feedId: timing, timeoutStreak: 4 } })
    await heartbeat(false)
    expect((await record<AdminFeedDetail>('feeds', timing)).relay).toBe(false)
  })

  test('a site’s record: its feeds, claims, tokens this month and history', async () => {
    const claimant = await member('claimant@x.test', 'jiwoo')
    const site = await addSite({ title: 'Blog', listing: 'listed' })
    const feed = await addFeed(site)
    const merged = await addFeed(site, { status: 'paused', mergedInto: feed })
    const claim = await addClaim(site, claimant.userId)
    const now = api.clock.now()
    await api.db.run(sql`
      insert into llm_calls (job, feed_id, model, input_tokens, output_tokens, latency_ms, created_at)
      values ('translate.title', ${feed}, 'm', 100, 50, 1, ${now - DAY}),
        ('translate.body', ${merged}, 'm', 1000, 500, 1, ${now - 2 * DAY}),
        ('translate.body', ${feed}, 'm', 7, 7, 1, ${now - 31 * DAY})
    `)
    await act('site.feature', [site])
    const detail = await record<AdminSiteDetail>('sites', site)
    expect(detail.site).toMatchObject({ siteId: site, listing: 'featured', feedCount: 1 })
    expect(detail.feeds.map((f) => f.feedId)).toEqual([feed, merged])
    expect(detail.claims.map((c) => c.claimId)).toEqual([claim])
    expect(detail.tokens30d).toBe(1650)
    expect(detail.history).toMatchObject([
      { action: 'site.feature', actor: { id: ops.userId }, from: { listing: 'listed' } },
    ])
    expect((await api.request('/api/v1/admin/sites/0', { as: ops })).status).toBe(404)
  })
})

describe('listing', () => {
  /** Three members, each subscribing to the feed: what lists an unclaimed blog (ADR 0018). */
  async function threeSubscribe(feedId: number) {
    for (const n of [1, 2, 3]) await subscribe(await signedIn(`r${n}@x.test`), feedId)
  }

  test('Hide survives three subscribes', async () => {
    const site = await addSite()
    const feed = await addFeed(site)
    expect(await outcome('site.hide', site)).toBe('done')
    await threeSubscribe(feed)
    expect((await siteOf(site))?.listing).toBe('rejected')
  })

  test('List survives three subscribes, and so does Feature', async () => {
    const listed = await addSite()
    const featured = await addSite()
    await act('site.list', [listed])
    await act('site.feature', [featured])
    await threeSubscribe(await addFeed(listed))
    await threeSubscribe(await addFeed(featured))
    expect((await siteOf(listed))?.listing).toBe('listed')
    expect((await siteOf(featured))?.listing).toBe('featured')
  })

  test('Restore follows the doors: private with few readers, then listed when three subscribe', async () => {
    const site = await addSite({ listing: 'rejected' })
    const feed = await addFeed(site)
    expect(await outcome('site.restore', site)).toBe('done')
    expect((await siteOf(site))?.listing).toBe('private')
    await threeSubscribe(feed)
    expect((await siteOf(site))?.listing).toBe('listed')
    expect(await outcome('site.restore', site)).toBe('not_applicable')
  })
})

describe('reviewing for Discover (ADR 0041)', () => {
  async function threeSubscribe(feedId: number) {
    for (const n of [1, 2, 3]) await subscribe(await signedIn(`r${n}@x.test`), feedId)
  }
  const queued = async () => ids((await list<AdminSiteRow>('discover', 'candidates')).rows)
  const notForDiscover = async () => ids((await list<AdminSiteRow>('discover', 'dismissed')).rows)
  /** The blogs public Discover lists, as anyone sees it. */
  const publicDiscover = async () =>
    (
      (await (await api.request('/api/v1/public/discover')).json()) as { sites: { id: number }[] }
    ).sites.map((s) => s.id)
  /** A blog's review and its stamp, as an undo must give them back. */
  const reviewOf = async (site: number) => {
    const row = await siteOf(site)
    return { listing: row?.listing, review: row?.review, reviewedAt: row?.reviewed_at }
  }

  test('Not for Discover: out of the queue, nothing synced, and undone while untouched', async () => {
    const { site } = await addReviewable()
    const before = await siteOf(site)
    const dismissed = await act('site.dismiss', [site])
    expect(dismissed.done).toEqual([String(site)])
    const after = await siteOf(site)
    expect(after).toMatchObject({
      listing: 'private',
      review: 'dismissed',
      reviewed_at: api.clock.now(),
    })
    // The review is the console's alone: no device holds it, so no seq moves.
    expect(after?.seq).toBe(before?.seq)
    expect(await queued()).toEqual([])
    expect(await notForDiscover()).toEqual([String(site)])
    // Once is enough: a dismissed blog has nothing left to dismiss.
    expect(await outcome('site.dismiss', site)).toBe('not_applicable')

    expect((await undo(dismissed.undo?.group)).status).toBe(200)
    expect(await reviewOf(site)).toEqual({ listing: 'private', review: null, reviewedAt: null })
    expect(await queued()).toEqual([String(site)])
    const { history } = await record<AdminSiteDetail>('sites', site)
    expect(history.map((h) => h.action)).toEqual(['undo', 'site.dismiss'])
  })

  test('Not for Discover applies only to an undecided blog nobody claimed', async () => {
    const owner = await member('owner@x.test', 'owner')
    expect(await outcome('site.dismiss', await addSite({ listing: 'listed' }))).toBe(
      'not_applicable',
    )
    expect(await outcome('site.dismiss', await addSite({ claimedBy: owner.userId }))).toBe(
      'not_applicable',
    )
    expect(await outcome('site.dismiss', 999_999)).toBe('not_found')
  })

  test('List and Feature record listed, Hide over nothing dismissed, and an undone List queues again', async () => {
    const listed = await addReviewable()
    const featured = await addReviewable()
    const hidden = await addReviewable()
    const list = await act('site.list', [listed.site])
    await act('site.feature', [featured.site])
    await act('site.hide', [hidden.site])
    const now = api.clock.now()
    expect(await reviewOf(listed.site)).toEqual({
      listing: 'listed',
      review: 'listed',
      reviewedAt: now,
    })
    expect(await reviewOf(featured.site)).toEqual({
      listing: 'featured',
      review: 'listed',
      reviewedAt: now,
    })
    expect(await reviewOf(hidden.site)).toEqual({
      listing: 'rejected',
      review: 'dismissed',
      reviewedAt: now,
    })
    expect(await queued()).toEqual([])

    api.clock.advance(MIN)
    expect((await undo(list.undo?.group)).status).toBe(200)
    expect(await reviewOf(listed.site)).toEqual({
      listing: 'private',
      review: null,
      reviewedAt: null,
    })
    expect(await queued()).toEqual([String(listed.site)])
  })

  test('each decision is stamped when made, and its undo gives back the review and stamp before', async () => {
    const { site } = await addReviewable()
    await act('site.dismiss', [site])
    const dismissedAt = api.clock.now()
    const before = { listing: 'private', review: 'dismissed', reviewedAt: dismissedAt }
    // Each decision over the dismissal: the stamp dates it, not the dismissal it overturned.
    for (const [action, listing, review] of [
      ['site.list', 'listed', 'listed'],
      ['site.feature', 'featured', 'listed'],
      ['site.hide', 'rejected', 'dismissed'],
    ] as const) {
      api.clock.advance(DAY)
      const decided = await act(action, [site])
      expect({ action, ...(await reviewOf(site)) }).toEqual({
        action,
        listing,
        review,
        reviewedAt: api.clock.now(),
      })
      expect((await undo(decided.undo?.group)).status).toBe(200)
      expect({ action, ...(await reviewOf(site)) }).toEqual({ action, ...before })
    }
    // And a Hide over a List keeps the List's review, undone back to the List's stamp.
    api.clock.advance(DAY)
    await act('site.list', [site])
    const listedAt = api.clock.now()
    api.clock.advance(DAY)
    const hidden = await act('site.hide', [site])
    expect(await reviewOf(site)).toEqual({
      listing: 'rejected',
      review: 'listed',
      reviewedAt: api.clock.now(),
    })
    expect((await undo(hidden.undo?.group)).status).toBe(200)
    expect(await reviewOf(site)).toEqual({
      listing: 'listed',
      review: 'listed',
      reviewedAt: listedAt,
    })
  })

  test('a List since stands in the way of undoing Not for Discover', async () => {
    const { site } = await addReviewable()
    const dismissed = await act('site.dismiss', [site])
    await act('site.list', [site])
    const res = await undo(dismissed.undo?.group)
    expect(res.status).toBe(409)
    expect(await reviewOf(site)).toEqual({
      listing: 'listed',
      review: 'listed',
      reviewedAt: api.clock.now(),
    })
  })

  test('a blog listed from the queue stays in Discover when it is featured and unfeatured', async () => {
    const { site } = await addReviewable()
    await act('site.list', [site])
    await act('site.feature', [site])
    const unfeatured = await act('site.restore', [site])
    expect(unfeatured.done).toEqual([String(site)])
    expect(await reviewOf(site)).toEqual({
      listing: 'listed',
      review: 'listed',
      reviewedAt: api.clock.now(),
    })
    expect(await publicDiscover()).toEqual([site])
    expect(await queued()).toEqual([])
    expect(await notForDiscover()).toEqual([])
    expect((await undo(unfeatured.undo?.group)).status).toBe(200)
    expect((await siteOf(site))?.listing).toBe('featured')
  })

  test('a blog featured straight from the queue stays in Discover when unfeatured', async () => {
    const { site } = await addReviewable()
    await act('site.feature', [site])
    expect(await outcome('site.restore', site)).toBe('done')
    expect(await reviewOf(site)).toEqual({
      listing: 'listed',
      review: 'listed',
      reviewedAt: api.clock.now(),
    })
    expect(await publicDiscover()).toEqual([site])
    expect(await notForDiscover()).toEqual([])
  })

  test('Hide and Restore: a listed blog comes back listed, one from the queue private and dismissed', async () => {
    const listed = await addReviewable()
    const queuedBlog = await addReviewable()
    await act('site.list', [listed.site])
    await act('site.hide', [listed.site, queuedBlog.site])
    await act('site.restore', [listed.site, queuedBlog.site])
    expect(await reviewOf(listed.site)).toMatchObject({ listing: 'listed', review: 'listed' })
    expect(await reviewOf(queuedBlog.site)).toMatchObject({
      listing: 'private',
      review: 'dismissed',
    })
    // Hiding answered the queue's question: restored, the blog is not asked about again.
    expect(await queued()).toEqual([])
    expect(await notForDiscover()).toEqual([String(queuedBlog.site)])
    expect(await publicDiscover()).toEqual([listed.site])
  })

  test('an operator-listed blog stays listed when the claim made since is removed', async () => {
    const owner = await signedIn('owner@x.test')
    const { site } = await addReviewable()
    await act('site.list', [site])
    // Its blogger claims it, as a verified check leaves the rows.
    await api.db.run(sql`update sites set claimed_by = ${owner.userId},
      claimed_at = ${api.clock.now()} where id = ${site}`)
    const claim = await addClaim(site, owner.userId, { status: 'verified' })
    const removed = await act('claim.remove', [claim])
    expect(removed.done).toEqual([String(claim)])
    expect(await siteOf(site)).toMatchObject({
      claimed_by: null,
      listing: 'listed',
      review: 'listed',
    })
    expect(await publicDiscover()).toEqual([site])
    expect(await notForDiscover()).toEqual([])
  })

  test('three readers still list a blog judged not for Discover; Hide is the veto', async () => {
    const dismissed = await addReviewable()
    const hidden = await addReviewable()
    await act('site.dismiss', [dismissed.site, hidden.site])
    await act('site.hide', [hidden.site])
    await threeSubscribe(dismissed.feed)
    await threeSubscribe(hidden.feed)
    expect((await siteOf(dismissed.site))?.listing).toBe('listed')
    expect((await siteOf(hidden.site))?.listing).toBe('rejected')
  })
})

describe('a blog’s topics and translation', () => {
  test('topics: replaced whole, unknown ones dropped, and undone while unchanged', async () => {
    const site = await addSite({ listing: 'listed' })
    const before = (await siteOf(site))?.seq ?? 0
    const first = await act('site.topics', [site], { topics: ['tech', 'nonsense', 'food', 'tech'] })
    expect(first.done).toEqual([String(site)])
    expect(await topicsOf(site)).toEqual(['food', 'tech'])
    expect((await siteOf(site))?.seq).toBeGreaterThan(before)
    expect(await outcome('site.topics', site, { topics: ['tech', 'food'] })).toBe('not_applicable')
    const second = await act('site.topics', [site], { topics: ['life'] })
    expect(await topicsOf(site)).toEqual(['life'])
    // The first change has been changed since: its undo restores nothing.
    expect((await undo(first.undo?.group)).status).toBe(409)
    expect(await topicsOf(site)).toEqual(['life'])
    expect((await undo(second.undo?.group)).status).toBe(200)
    expect(await topicsOf(site)).toEqual(['food', 'tech'])
    // And once the second is undone, the first holds again and can be.
    expect((await undo(first.undo?.group)).status).toBe(200)
    expect(await topicsOf(site)).toEqual([])
    expect(await outcome('site.topics', 999, { topics: [] })).toBe('not_found')
  })

  test('translation: paused and allowed, each undone', async () => {
    const site = await addSite()
    const off = await act('site.translationOff', [site])
    expect((await siteOf(site))?.translation_opt_out).toBe(1)
    expect(await outcome('site.translationOff', site)).toBe('not_applicable')
    expect((await undo(off.undo?.group)).status).toBe(200)
    expect((await siteOf(site))?.translation_opt_out).toBe(0)
    await api.db.run(sql`update sites set translation_opt_out = 1 where id = ${site}`)
    const on = await act('site.translationOn', [site])
    expect((await siteOf(site))?.translation_opt_out).toBe(0)
    await api.db.run(sql`update sites set translation_opt_out = 1 where id = ${site}`)
    expect((await undo(on.undo?.group)).status).toBe(409)
  })

  test('Fetch all feeds asks for every active feed now, and has no undo', async () => {
    const site = await addSite()
    const a = await addFeed(site, { url: 'https://a.test/feed' })
    const b = await addFeed(site, { url: 'https://b.test/feed', errors: 2 })
    const paused = await addFeed(site, { status: 'paused' })
    const res = await act('site.fetchAll', [site])
    expect(res).toMatchObject({ done: [String(site)], undo: null })
    expect((await feedOf(a))?.refetch_requested_at).toBe(api.clock.now())
    expect((await feedOf(b))?.refetch_requested_at).toBe(api.clock.now())
    expect((await feedOf(paused))?.refetch_requested_at).toBeNull()
    expect(api.jobs.sent.map((j) => j.body.key).sort()).toEqual([String(a), String(b)].sort())
    const empty = await addSite()
    expect(await outcome('site.fetchAll', empty)).toBe('not_applicable')
    expect(await outcome('site.fetchAll', 999)).toBe('not_found')
  })
})

describe('claims', () => {
  beforeEach(() => {
    server.text(
      '/feed.xml',
      rss({ title: 'Mine', link: server.url('/'), items: [{ guid: 'a', title: 'A' }] }),
    )
  })
  const serveHome = (html: string, before?: () => Promise<void>) =>
    server.set('/', async (_req, res) => {
      await before?.()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  const DECLARES_FEED = () =>
    `<html><head><link rel="alternate" type="application/rss+xml" href="${server.url('/feed.xml')}"></head></html>`

  /** A member who asked Tela to check their claim on the fixture blog, as the claim page does. */
  async function memberClaim(email = 'blogger@x.test') {
    const blogger = await signedIn(email)
    serveHome(DECLARES_FEED())
    const started = await api.request('/api/v1/claims', {
      as: blogger,
      body: { url: server.url('/') },
    })
    const { siteId } = (await started.json()) as { siteId: number }
    await api.request(`/api/v1/claims/${siteId}/verify`, { as: blogger, body: {} })
    const row = await one<{ id: number }>(
      api.db,
      sql`select id from site_claims where site_id = ${siteId} and user_id = ${blogger.userId}`,
    )
    api.jobs.take('misc')
    await api.db.run(sql`delete from leases`)
    return { blogger, siteId, claimId: row?.id ?? 0 }
  }

  /** Run the check a message names, as the queue's consumer would. */
  async function runCheck() {
    const [message] = api.jobs.take('misc')
    expect(message?.kind).toBe('site.claim')
    if (!message) throw new Error('no check was sent')
    return verifyClaimJob(ingest(), message as Lease)
  }

  test('Re-check: a failed claim is checked again at once', async () => {
    const { claimId } = await memberClaim()
    await api.db.run(
      sql`update site_claims set status = 'failed', error = 'x' where id = ${claimId}`,
    )
    expect(await outcome('claim.recheck', claimId)).toBe('done')
    expect(await claimOf(claimId)).toMatchObject({ status: 'pending', error: null })
    expect(api.jobs.sent).toMatchObject([{ queue: 'misc', body: { key: String(claimId) } }])
    expect(await outcome('claim.recheck', claimId)).toBe('not_applicable')
    expect(await outcome('claim.recheck', 999)).toBe('not_found')
  })

  test('Verify by hand: the check passes with no proof on the page', async () => {
    const { blogger, siteId, claimId } = await memberClaim()
    await api.db.run(sql`update site_claims set status = 'failed' where id = ${claimId}`)
    const vouched = await act('claim.vouch', [claimId])
    expect(vouched).toMatchObject({ done: [String(claimId)], undo: null })
    expect(await claimOf(claimId)).toMatchObject({ status: 'pending', vouched_by: ops.userId })
    expect(await runCheck()).toMatchObject({ status: 'verified', vouched: true })
    expect((await siteOf(siteId))?.claimed_by).toBe(blogger.userId)
    const row = (await list<AdminClaimRow>('claims', 'verified')).rows[0]
    expect(row).toMatchObject({ claimId, vouched: true })
  })

  test('a member asking for the check again clears the vouch: theirs reads their proof', async () => {
    const { blogger, siteId, claimId } = await memberClaim()
    await act('claim.vouch', [claimId])
    api.jobs.take('misc')
    await api.db.run(sql`delete from leases`)
    expect((await claimOf(claimId))?.vouched_by).toBe(ops.userId)
    await api.request(`/api/v1/claims/${siteId}/verify`, { as: blogger, body: {} })
    expect(await claimOf(claimId)).toMatchObject({ status: 'pending', vouched_by: null })
    expect(await runCheck()).toMatchObject({ status: 'failed' })
  })

  test('a vouch ends with the claim it vouched for: removed, a re-check asks for proof again', async () => {
    const { siteId, claimId } = await memberClaim()
    await act('claim.vouch', [claimId])
    expect(await runCheck()).toMatchObject({ status: 'verified', vouched: true })
    await api.db.run(sql`delete from leases`)
    expect(await outcome('claim.remove', claimId)).toBe('done')
    expect((await claimOf(claimId))?.vouched_by).toBeNull()
    expect(await outcome('claim.recheck', claimId)).toBe('done')
    expect(await runCheck()).toMatchObject({ status: 'failed' })
    expect((await siteOf(siteId))?.claimed_by).toBeNull()
  })

  test('Verify by hand is refused on a blog someone else holds, and on a verified claim', async () => {
    const { claimId, siteId } = await memberClaim()
    const owner = await signedIn('owner@x.test')
    await api.db.run(sql`update sites set claimed_by = ${owner.userId} where id = ${siteId}`)
    expect(await outcome('claim.vouch', claimId)).toBe('taken')
    const verified = await addClaim(siteId, owner.userId, { status: 'verified' })
    expect(await outcome('claim.vouch', verified)).toBe('not_applicable')
    expect(await outcome('claim.vouch', 999)).toBe('not_found')
    expect((await claimOf(claimId))?.vouched_by).toBeNull()
  })

  test('Verify by hand cuts off a check already running, which would fail it for want of proof', async () => {
    const { claimId } = await memberClaim()
    const running = await hold('site.claim', claimId)
    expect(await outcome('claim.vouch', claimId)).toBe('done')
    expect(await verifyClaimJob(ingest(), running)).toEqual({ status: 'lost' })
    expect(await runCheck()).toMatchObject({ status: 'verified', vouched: true })
  })

  test('Reject: the reason is the claimant’s to read, and a check in flight is cut off', async () => {
    const { claimId, siteId } = await memberClaim()
    expect(await outcome('claim.reject', claimId, { reason: '  ' })).toBe('invalid')
    const running = await hold('site.claim', claimId)
    // The page has the proof, and the operator rejects while the check is reading it.
    const token = await one<{ token: string }>(
      api.db,
      sql`select token from site_claims where id = ${claimId}`,
    )
    serveHome(
      `<html><head><meta name="tela-site-verification" content="${token?.token}"></head></html>`,
      async () => {
        expect(await outcome('claim.reject', claimId, { reason: 'Not a personal blog' })).toBe(
          'done',
        )
      },
    )
    expect(await verifyClaimJob(ingest(), running)).toEqual({ status: 'lost' })
    expect(await claimOf(claimId)).toMatchObject({
      status: 'failed',
      error: 'Not a personal blog',
      vouched_by: null,
      reviewed_at: api.clock.now(),
    })
    expect((await siteOf(siteId))?.claimed_by).toBeNull()
    expect(await leaseOf('site.claim', claimId)).toBeUndefined()
    // Decided: out of the review queue.
    expect((await list<AdminClaimRow>('claims', 'review')).rows).toEqual([])
  })

  test('Dismiss: out of the queue until it fails again, and undone while untouched', async () => {
    const claimant = await signedIn('c@x.test')
    const claim = await addClaim(await addSite(), claimant.userId)
    const dismissed = await act('claim.dismiss', [claim])
    expect((await list<AdminClaimRow>('claims', 'review')).rows).toEqual([])
    expect(await outcome('claim.dismiss', claim)).toBe('not_applicable')
    expect((await undo(dismissed.undo?.group)).status).toBe(200)
    expect(ids((await list<AdminClaimRow>('claims', 'review')).rows)).toEqual([String(claim)])

    const again = await act('claim.dismiss', [claim])
    api.clock.advance(MIN)
    await api.db.run(
      sql`update site_claims set last_checked_at = ${api.clock.now()} where id = ${claim}`,
    )
    expect(ids((await list<AdminClaimRow>('claims', 'review')).rows)).toEqual([String(claim)])
    await act('claim.dismiss', [claim])
    expect((await undo(again.undo?.group)).status).toBe(409)
  })

  test('Remove: the blog loses its owner, the claimant’s device hears of it, and an undo gives it back', async () => {
    const owner = await signedIn('owner@x.test')
    const site = await addSite({
      listing: 'listed',
      claimedBy: owner.userId,
      optOut: 1,
      readers: 1,
    })
    const feed = await addFeed(site)
    const claim = await addClaim(site, owner.userId, { status: 'verified' })
    const cursor = (
      (await (await api.request('/api/v1/sync?cursor=0', { as: owner })).json()) as PullResponse
    ).cursor
    await hold('site.claim', claim)

    const removed = await act('claim.remove', [claim])
    expect(removed.undo).not.toBeNull()
    expect(await claimOf(claim)).toMatchObject({
      status: 'failed',
      error: 'removed by an operator',
    })
    expect(await siteOf(site)).toMatchObject({
      claimed_by: null,
      claimed_at: null,
      declared_feed_urls: '[]',
      translation_opt_out: 0,
      // One reader is not enough for the doors: the listing only the claim opened is closed.
      listing: 'private',
    })
    expect(
      await one(api.db, sql`select id from feeds where id = ${feed} and site_id = ${site}`),
    ).toBeDefined()
    expect(await leaseOf('site.claim', claim)).toBeUndefined()
    const pull = (await (
      await api.request(`/api/v1/sync?cursor=${cursor}`, { as: owner })
    ).json()) as PullResponse
    expect(pull.rows.claims).toMatchObject([
      { id: claim, status: 'failed', error: 'removed by an operator' },
    ])
    expect(await outcome('claim.remove', claim)).toBe('not_applicable')

    expect((await undo(removed.undo?.group)).status).toBe(200)
    expect(await claimOf(claim)).toMatchObject({ status: 'verified', error: null })
    expect(await siteOf(site)).toMatchObject({
      claimed_by: owner.userId,
      translation_opt_out: 1,
      listing: 'listed',
    })
    const home = await one<{ home_url: string }>(
      api.db,
      sql`select home_url from sites where id = ${site}`,
    )
    expect(JSON.parse((await siteOf(site))?.declared_feed_urls ?? '')).toEqual([
      `${home?.home_url}/feed`,
    ])
  })

  test('an undone removal keeps a translation pause an operator set after it', async () => {
    const owner = await signedIn('owner@x.test')
    const site = await addSite({ listing: 'listed', claimedBy: owner.userId, optOut: 0 })
    const claim = await addClaim(site, owner.userId, { status: 'verified' })
    const removed = await act('claim.remove', [claim])
    // Another tab pauses the blog's translation; that is the site's change, not the claim's.
    expect(await outcome('site.translationOff', site)).toBe('done')
    expect((await undo(removed.undo?.group)).status).toBe(200)
    expect(await siteOf(site)).toMatchObject({ claimed_by: owner.userId, translation_opt_out: 1 })
  })

  test('an undone removal keeps what an operator chose for the blog since, even a return', async () => {
    const owner = await signedIn('owner@x.test')
    // Paused by its owner; the removal clears that with the owner.
    const site = await addSite({
      listing: 'listed',
      claimedBy: owner.userId,
      optOut: 1,
      readers: 3,
    })
    const claim = await addClaim(site, owner.userId, { status: 'verified' })
    const removed = await act('claim.remove', [claim])
    // Another tab pauses it and then allows it again, and hides it and restores it: each ends
    // where the removal left it, so the values alone cannot tell anyone chose.
    expect(await outcome('site.translationOff', site)).toBe('done')
    expect(await outcome('site.translationOn', site)).toBe('done')
    expect(await outcome('site.hide', site)).toBe('done')
    expect(await outcome('site.restore', site)).toBe('done')
    expect((await undo(removed.undo?.group)).status).toBe(200)
    expect(await siteOf(site)).toMatchObject({
      claimed_by: owner.userId,
      translation_opt_out: 0,
      listing: 'listed',
    })
  })

  test('an undone removal restores what a later action left alone: Fetch now is no choice', async () => {
    const owner = await signedIn('owner@x.test')
    // Listed only by its claim (one reader), and paused by its owner.
    const site = await addSite({
      listing: 'listed',
      claimedBy: owner.userId,
      optOut: 1,
      readers: 1,
    })
    await addFeed(site)
    const claim = await addClaim(site, owner.userId, { status: 'verified' })
    const removed = await act('claim.remove', [claim])
    expect(await siteOf(site)).toMatchObject({ listing: 'private', translation_opt_out: 0 })
    // Another tab fetches the blog's feeds: it writes neither the listing nor the pause.
    expect(await outcome('site.fetchAll', site)).toBe('done')
    expect((await undo(removed.undo?.group)).status).toBe(200)
    expect(await siteOf(site)).toMatchObject({
      claimed_by: owner.userId,
      listing: 'listed',
      translation_opt_out: 1,
    })
  })

  test('an undo is not stopped by a later action that wrote something else', async () => {
    const site = await addSite({ listing: 'listed' })
    await addFeed(site)
    const featured = await act('site.feature', [site])
    expect(await outcome('site.fetchAll', site)).toBe('done')
    expect(await outcome('site.translationOff', site)).toBe('done')
    expect((await undo(featured.undo?.group)).status).toBe(200)
    expect(await siteOf(site)).toMatchObject({ listing: 'listed', translation_opt_out: 1 })
  })

  test('Remove keeps an editor’s listing, and its undo waits for nobody to have claimed the blog', async () => {
    const owner = await signedIn('owner@x.test')
    const next = await signedIn('next@x.test')
    const site = await addSite({ listing: 'featured', claimedBy: owner.userId })
    const claim = await addClaim(site, owner.userId, { status: 'verified' })
    const removed = await act('claim.remove', [claim])
    expect((await siteOf(site))?.listing).toBe('featured')
    await api.db.run(sql`update sites set claimed_by = ${next.userId} where id = ${site}`)
    expect((await undo(removed.undo?.group)).status).toBe(409)
    expect((await claimOf(claim))?.status).toBe('failed')
    expect((await siteOf(site))?.claimed_by).toBe(next.userId)
  })
})

describe('feeds', () => {
  test('Fetch now: an active feed is asked for and sent; a paused one is not', async () => {
    const site = await addSite()
    const feed = await addFeed(site, { errors: 2 })
    const paused = await addFeed(site, { status: 'paused' })
    expect(await act('feed.fetch', [feed])).toMatchObject({ done: [String(feed)], undo: null })
    expect((await feedOf(feed))?.refetch_requested_at).toBe(api.clock.now())
    expect(api.jobs.sent).toMatchObject([{ queue: 'fetch', body: { key: String(feed) } }])
    expect(await outcome('feed.fetch', paused)).toBe('not_applicable')
    expect(await outcome('feed.fetch', 'nope')).toBe('not_found')
  })

  test('Pause while a fetch runs: the fetch is lost, and the feed stays paused', async () => {
    const feedUrl = server.url('/slow.xml')
    const site = await addSite()
    const feed = await addFeed(site, { url: feedUrl, nextFetchAt: 0 })
    const running = await hold('feed.fetch', feed)
    let paused: AdminActResponse | undefined
    server.set('/slow.xml', async (_req, res) => {
      paused = await act('feed.pause', [feed])
      res.writeHead(500)
      res.end()
    })
    // The fetch read the feed as active; its error would write that back, but its lease is gone.
    expect(await ingestFeed(ingest(), running)).toEqual({ status: 'lost' })
    expect(paused?.done).toEqual([String(feed)])
    expect(await feedOf(feed)).toMatchObject({ status: 'paused', error_count: 0 })
    expect(await leaseOf('feed.fetch', feed)).toBeUndefined()
    // Nothing fetches a paused feed, and nothing resumes it on its own.
    await daily(api.db, api.clock.now() + 8 * DAY)
    expect((await feedOf(feed))?.status).toBe('paused')

    expect((await undo(paused?.undo?.group)).status).toBe(200)
    expect(await feedOf(feed)).toMatchObject({ status: 'active', next_fetch_at: api.clock.now() })
  })

  test('Resume: due at once; its undo pauses again and cuts off the fetch it let start', async () => {
    const site = await addSite()
    const feed = await addFeed(site, { status: 'paused' })
    const merged = await addFeed(site, { status: 'paused', mergedInto: feed })
    expect(await outcome('feed.resume', merged)).toBe('not_applicable')
    const resumed = await act('feed.resume', [feed])
    expect(await feedOf(feed)).toMatchObject({ status: 'active', next_fetch_at: api.clock.now() })
    expect(await outcome('feed.pause', merged)).toBe('not_applicable')
    await hold('feed.fetch', feed)
    expect((await undo(resumed.undo?.group)).status).toBe(200)
    expect((await feedOf(feed))?.status).toBe('paused')
    expect(await leaseOf('feed.fetch', feed)).toBeUndefined()
  })

  test('Revive: a dead feed five errors from dying again, fetched now', async () => {
    const site = await addSite()
    const feed = await addFeed(site, { status: 'dead', errors: 30 })
    expect(await act('feed.revive', [feed])).toMatchObject({ done: [String(feed)], undo: null })
    expect(await feedOf(feed)).toMatchObject({
      status: 'active',
      error_count: 25,
      next_fetch_at: api.clock.now(),
    })
    expect(api.jobs.sent).toMatchObject([{ queue: 'fetch', body: { key: String(feed) } }])
    expect(await outcome('feed.revive', feed)).toBe('not_applicable')
  })

  test('Use the relay: refused without one; with one, it sticks through the daily reprobe', async () => {
    const site = await addSite()
    const feed = await addFeed(site, { errors: 5, timeouts: 5 })
    // A feed the timeouts flipped a week ago: the reprobe tries it directly again.
    const flipped = await addFeed(site, { region: 'cn', flippedAt: api.clock.now() - 8 * DAY })
    expect(await outcome('feed.relay', feed)).toBe('no_relay')
    await heartbeat(true)
    await hold('feed.fetch', feed)
    const relayed = await act('feed.relay', [feed])
    expect(relayed.done).toEqual([String(feed)])
    expect(await feedOf(feed)).toMatchObject({
      fetch_region: 'cn',
      region_flipped_at: null,
      timeout_streak: 0,
    })
    expect(await leaseOf('feed.fetch', feed)).toBeUndefined()
    expect(await outcome('feed.relay', feed)).toBe('not_applicable')

    await daily(api.db, api.clock.now() + 8 * DAY)
    expect((await feedOf(feed))?.fetch_region).toBe('cn')
    expect((await feedOf(flipped))?.fetch_region).toBe('global')

    // Undone while it still holds: global again, its timeouts as the fetches since left them.
    expect((await undo(relayed.undo?.group)).status).toBe(200)
    expect(await feedOf(feed)).toMatchObject({ fetch_region: 'global', timeout_streak: 0 })
  })

  test('Use the relay pins a feed the timeouts flipped, and Fetch directly undoes only while it holds', async () => {
    await heartbeat(true)
    const site = await addSite()
    const flippedAt = api.clock.now() - DAY
    const feed = await addFeed(site, { region: 'cn', flippedAt })
    const pinned = await act('feed.relay', [feed])
    expect(await feedOf(feed)).toMatchObject({ fetch_region: 'cn', region_flipped_at: null })
    expect((await undo(pinned.undo?.group)).status).toBe(200)
    expect(await feedOf(feed)).toMatchObject({ fetch_region: 'cn', region_flipped_at: flippedAt })

    const direct = await act('feed.global', [feed])
    expect(await feedOf(feed)).toMatchObject({ fetch_region: 'global', region_flipped_at: null })
    expect(await outcome('feed.global', feed)).toBe('not_applicable')
    await act('feed.relay', [feed])
    expect((await undo(direct.undo?.group)).status).toBe(409)
    expect((await feedOf(feed))?.fetch_region).toBe('cn')
  })
})
