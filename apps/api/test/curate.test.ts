import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { first } from '@tela/data'
import { sql } from 'drizzle-orm'
import { FixtureServer, rss } from '../../../packages/ingest/test/fixture-server'
import { ADMIN_TOKEN, createTestApi, signedIn, type TestApi } from './helpers'

let server: FixtureServer
let api: TestApi

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(async () => {
  server.reset()
  api = await createTestApi()
  server.text(
    '/feed.xml',
    rss({ title: 'Curated Blog', link: server.url('/'), items: [{ guid: 'a', title: 'A' }] }),
  )
})

const curate = (body: unknown, token = ADMIN_TOKEN) =>
  api.request('/api/admin/curate', { body, headers: { authorization: `Bearer ${token}` } })

describe('curating Discover', () => {
  test('adds the feed, features its blog with its topics, and sends the first fetch', async () => {
    const res = await curate({
      feedUrl: server.url('/feed.xml'),
      topics: ['tech', 'essays', 'nope'],
      featured: true,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      siteId: number
      listing: string
      topics: string[]
      created: boolean
    }
    expect(body).toMatchObject({ listing: 'featured', topics: ['essays', 'tech'], created: true })
    expect(api.jobs.sent.map((j) => j.body.kind)).toEqual(['feed.fetch'])
    const listed = (await (await api.request('/api/v1/public/discover')).json()) as {
      sites: { id: number }[]
    }
    expect(listed.sites.map((s) => s.id)).toEqual([body.siteId])
    // An editor's pick is a decision for Discover (ADR 0041): unfeatured later, it stays listed,
    // and does not wait in the review queue for the question featuring answered.
    expect(
      await first<{ review: string | null; reviewed_at: number | null }>(
        api.db,
        sql`select review, reviewed_at from sites where id = ${body.siteId}`,
      ),
    ).toEqual({ review: 'listed', reviewed_at: api.clock.now() })
  })

  test('is idempotent, and leaves what a person decided alone', async () => {
    const first_ = (await (
      await curate({ feedUrl: server.url('/feed.xml'), topics: ['tech'], featured: true })
    ).json()) as {
      siteId: number
    }
    const again = (await (
      await curate({ feedUrl: server.url('/feed.xml'), topics: ['tech'], featured: true })
    ).json()) as {
      created: boolean
    }
    expect(again.created).toBe(false)
    // An operator rejected it; a blogger claimed it and picked their own topics.
    await api.db.run(sql`update sites set listing = 'rejected' where id = ${first_.siteId}`)
    await curate({ feedUrl: server.url('/feed.xml'), topics: ['food'], featured: true })
    expect(
      await first<{ listing: string }>(
        api.db,
        sql`select listing from sites where id = ${first_.siteId}`,
      ),
    ).toEqual({ listing: 'rejected' })
    const blogger = await signedIn(api, 'blogger@x.test')
    await api.db.run(
      sql`update sites set listing = 'listed', claimed_by = ${blogger.userId} where id = ${first_.siteId}`,
    )
    const claimed = (await (
      await curate({ feedUrl: server.url('/feed.xml'), topics: ['food'], featured: true })
    ).json()) as {
      listing: string
      topics: string[]
    }
    expect(claimed).toMatchObject({ listing: 'featured', topics: ['tech'] })
  })

  test('lists what the list does not feature, and moves a blog between the two', async () => {
    const add = (featured: boolean) =>
      curate({ feedUrl: server.url('/feed.xml'), topics: ['tech'], featured })
    const listed = (await (await add(false)).json()) as { siteId: number; listing: string }
    expect(listed.listing).toBe('listed')
    // An editor's decision either way (ADR 0041): it is out of the review queue.
    expect(
      await first<{ review: string | null }>(
        api.db,
        sql`select review from sites where id = ${listed.siteId}`,
      ),
    ).toEqual({ review: 'listed' })
    expect(((await (await add(true)).json()) as { listing: string }).listing).toBe('featured')
    // Unmarked in the list, a featured blog goes back to listed, and stays in Discover.
    expect(((await (await add(false)).json()) as { listing: string }).listing).toBe('listed')
    const discover = (await (await api.request('/api/v1/public/discover')).json()) as {
      sites: { id: number }[]
    }
    expect(discover.sites.map((s) => s.id)).toEqual([listed.siteId])
    // A rejected blog is the operator's veto, whatever the list says.
    await api.db.run(sql`update sites set listing = 'rejected' where id = ${listed.siteId}`)
    expect(((await (await add(true)).json()) as { listing: string }).listing).toBe('rejected')
  })

  test('needs to be told whether to feature, so an older script cannot feature the whole list', async () => {
    const res = await curate({ feedUrl: server.url('/feed.xml'), topics: ['tech'] })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'featured_required' })
    expect(api.jobs.sent).toEqual([])
  })

  test('needs the admin token, and says what went wrong with a feed', async () => {
    expect((await curate({ feedUrl: server.url('/feed.xml') }, 'wrong')).status).toBe(403)
    const bad = await curate({ feedUrl: 'not a url at all', featured: true })
    expect(bad.status).toBe(422)
    expect(await bad.json()).toEqual({ error: 'invalid_url' })
    server.set('/feed.xml', (_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const gone = await curate({ feedUrl: server.url('/feed.xml'), featured: true })
    expect(gone.status).toBe(422)
  })
})
