import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, first, type TelaDb } from '@tela/data'
import { createTestDb } from '@tela/data/testing'
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

  test("names a blog whose feed names it poorly, and leaves a writer's name alone", async () => {
    const add = (title?: string) =>
      curate({ feedUrl: server.url('/feed.xml'), topics: [], featured: false, title })
    const named = (await (await add('Le blog')).json()) as { siteId: number; title: string }
    expect(named.title).toBe('Le blog')
    // Without a title the feed's name stands: nothing reverts the one an editor set.
    expect(((await (await add()).json()) as { title: string }).title).toBe('Le blog')
    const blogger = await signedIn(api, 'writer@x.test')
    await api.db.run(
      sql`update sites set claimed_by = ${blogger.userId} where id = ${named.siteId}`,
    )
    expect(((await (await add('Another name')).json()) as { title: string }).title).toBe('Le blog')
    for (const bad of ['', '   ', 'x'.repeat(201)]) {
      const res = await add(bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_title' })
    }
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

describe('a section that became a blog of its own (ADR 0069)', () => {
  const RESEARCH = 'https://feeds.example/research.xml'
  const ENGINEERING = 'https://feeds.example/engineering.xml'

  /**
   * The lab as Tela had it before blogs by path: one blog at the fixture's origin read through
   * two section feeds kept elsewhere, listed under AI, with a reader.
   */
  async function lab(db?: TelaDb) {
    api = await createTestApi(
      {},
      {
        blogRules: {
          sharedHosts: [],
          pathBlogs: [server.url('/research'), server.url('/engineering')],
        },
        ...(db ? { db } : {}),
      },
    )
    await api.db.batch([
      bumpSeq(api.db),
      api.db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at, seq)
        values (1, ${server.origin}, 'Lab', 'listed', 0, 0, ${currentSeq})`),
      api.db.run(sql`insert into site_topics (site_id, topic) values (1, 'ai')`),
      api.db.run(sql`insert into feeds (id, site_id, feed_url, host, last_fetched_at, next_fetch_at,
          created_at, updated_at, seq)
        values (11, 1, ${RESEARCH}, 'feeds.example', 1, 0, 0, 0, ${currentSeq}),
          (12, 1, ${ENGINEERING}, 'feeds.example', 1, 0, 0, 0, ${currentSeq})`),
    ] as never)
  }

  const entry = (feedUrl: string, section: string, title: string) =>
    curate({ feedUrl, topics: ['ai'], featured: false, title, home: server.url(section) })
  const blogs = () =>
    api.db.all<{ id: number; home_url: string; title: string; listing: string }>(
      sql`select id, home_url, title, listing from sites order by id`,
    )

  test('splits the first off and renames the blog for the last, which keeps its id', async () => {
    await lab()
    expect((await entry(ENGINEERING, '/engineering', 'Lab Engineering')).status).toBe(200)
    expect((await entry(RESEARCH, '/research', 'Lab Research')).status).toBe(200)
    const after = await blogs()
    expect(after.map((s) => [s.home_url.replace(server.origin, ''), s.title, s.listing])).toEqual([
      ['/research', 'Lab Research', 'listed'],
      ['/engineering', 'Lab Engineering', 'listed'],
    ])
    expect(after[0]?.id).toBe(1)
    const topics = await api.db.all<{ site_id: number; topic: string }>(
      sql`select site_id, topic from site_topics order by site_id`,
    )
    expect(topics.map((t) => t.topic)).toEqual(['ai', 'ai'])

    // Again, nothing moves.
    await entry(ENGINEERING, '/engineering', 'Lab Engineering')
    await entry(RESEARCH, '/research', 'Lab Research')
    expect(await blogs()).toEqual(after)
  })

  /** Engineering's entry, featured and tagged otherwise, so a write to the wrong blog shows. */
  const featuredEntry = () =>
    curate({
      feedUrl: ENGINEERING,
      topics: ['tech'],
      featured: true,
      title: 'Lab Engineering',
      home: server.url('/engineering'),
    })
  /** The lab's blog: its name, listing, topics and how many feeds it holds. */
  const labBlog = () =>
    first(
      api.db,
      sql`select title, listing,
          (select group_concat(topic) from site_topics where site_id = 1) as topics,
          (select count(*) from feeds where site_id = 1) as feeds
        from sites where id = 1`,
    )
  const untouched = { title: 'Lab', listing: 'listed', topics: 'ai', feeds: 2 }

  test('moves nothing off a blog someone claimed', async () => {
    await lab()
    const blogger = await signedIn(api, 'lab@x.test')
    await api.db.run(sql`update sites set claimed_by = ${blogger.userId} where id = 1`)
    const res = await entry(ENGINEERING, '/engineering', 'Lab Engineering')
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'home_blocked' })
    expect((await blogs()).map((s) => s.home_url)).toEqual([server.origin])
  })

  test('names, tags and lists nothing when the feed cannot reach the blog the list names', async () => {
    await lab()
    const blogger = await signedIn(api, 'lab@x.test')
    await api.db.run(sql`insert into sites (home_url, claimed_by, created_at, updated_at)
      values (${server.url('/engineering')}, ${blogger.userId}, 0, 0)`)
    const res = await featuredEntry()
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'home_blocked' })
    expect(await labBlog()).toEqual(untouched)
  })

  test('a claim verified while curate moves the feed stops the whole entry', async () => {
    const base = (await createTestDb()).db
    let meanwhile: (() => Promise<unknown>) | null = null
    let raced = false
    const isMove = (items: unknown[]) =>
      items.some((i) =>
        (i as { getQuery?: () => { sql: string } }).getQuery?.().sql.includes('lease_fence'),
      )
    // The claim lands after curate decided the move and before its batch runs.
    const db = new Proxy(base, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop !== 'batch') return typeof value === 'function' ? value.bind(target) : value
        return async (items: unknown[]) => {
          if (meanwhile && isMove(items)) {
            await meanwhile()
            meanwhile = null
            raced = true
          }
          return target.batch(items as never)
        }
      },
    })
    await lab(db)
    const blogger = await signedIn(api, 'lab@x.test')
    meanwhile = () =>
      base.run(sql`insert into sites (home_url, claimed_by, created_at, updated_at)
        values (${server.url('/engineering')}, ${blogger.userId}, 0, 0)`)
    const res = await featuredEntry()
    expect(raced).toBe(true)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'home_blocked' })
    expect(await labBlog()).toEqual(untouched)
  })

  test("moves no feed of a hidden blog onto one that isn't, nor drops its other no's", async () => {
    await lab()
    await api.db.batch([
      bumpSeq(api.db),
      api.db.run(sql`update sites set listing = 'rejected', review = 'dismissed', feed_only = 1,
        translation_opt_out = 1 where id = 1`),
      api.db.run(sql`insert into sites (id, home_url, listing, created_at, updated_at, seq)
        values (2, ${server.url('/engineering')}, 'listed', 0, 0, ${currentSeq})`),
    ] as never)
    const res = await entry(ENGINEERING, '/engineering', 'Lab Engineering')
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'home_blocked' })
    const feeds = await api.db.all<{ site_id: number }>(sql`select site_id from feeds`)
    expect(feeds).toEqual([{ site_id: 1 }, { site_id: 1 }])
    expect((await blogs()).map((s) => s.listing)).toEqual(['rejected', 'listed'])
  })

  test('a section split off a hidden blog stays hidden, and curate leaves both alone', async () => {
    await lab()
    await api.db.run(sql`update sites set listing = 'rejected', review = 'dismissed' where id = 1`)
    expect((await entry(ENGINEERING, '/engineering', 'Lab Engineering')).status).toBe(200)
    expect((await entry(RESEARCH, '/research', 'Lab Research')).status).toBe(200)
    expect((await blogs()).map((s) => [s.home_url.replace(server.origin, ''), s.listing])).toEqual([
      ['/research', 'rejected'],
      ['/engineering', 'rejected'],
    ])
    const topics = await api.db.all<{ site_id: number }>(sql`select site_id from site_topics`)
    expect(topics).toEqual([{ site_id: 1 }])
  })

  test('a section split off a blog already fetched has its language and description', async () => {
    await lab()
    await api.db.batch([
      bumpSeq(api.db),
      api.db.run(sql`update sites set description = 'The lab', primary_lang = 'en' where id = 1`),
      api.db.run(sql`update feeds set description = 'How the lab builds' where id = 12`),
      api.db.run(sql`insert into articles (feed_id, dedup_key, source_lang, fetched_at, sort_at)
        values (11, 'r1', 'en', 1, 1), (11, 'r2', 'en', 1, 1), (12, 'e1', 'fr', 1, 1)`),
    ] as never)
    expect((await entry(ENGINEERING, '/engineering', 'Lab Engineering')).status).toBe(200)
    const sites = await api.db.all<{ description: string; primary_lang: string }>(
      sql`select description, primary_lang from sites order by id`,
    )
    expect(sites).toEqual([
      { description: 'The lab', primary_lang: 'en' },
      { description: 'How the lab builds', primary_lang: 'fr' },
    ])
  })

  test('refuses a home that is no address', async () => {
    await lab()
    const res = await curate({ feedUrl: RESEARCH, featured: false, home: 'research' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_home' })
  })
})
