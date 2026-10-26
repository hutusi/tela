import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, dueExtractions, first, type Lease, REDUE, type TelaDb } from '@tela/data'
import { createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { createHttpClient } from '../src/http'
import { extractArticleJob, type IngestContext, ingestFeed, registerFeed } from '../src/pipeline'
import { FixtureServer, longHtml, rss } from './fixture-server'

const NOW = Date.UTC(2026, 8, 4, 10)
const MIN = 60_000
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})

let server: FixtureServer
let db: TelaDb
let blobs: ReturnType<typeof memoryBlobs>
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
  blobs = memoryBlobs()
  clock = fakeClock(NOW)
})

const ctx = (): IngestContext => ({ db, blobs, http, clock, random: () => 0.5 })

async function claim(kind: Lease['kind'], key: number, owner = 'w1'): Promise<Lease> {
  const got = await claimDue(db, {
    kind,
    owner,
    now: clock.now(),
    ttlMs: 2 * MIN,
    limit: 1,
    due: sql`select ${key} as key, null as host, 0 as ord`,
  })
  if (got.length !== 1) throw new Error(`could not claim ${kind} ${key}`)
  return { kind, key: String(key), owner }
}

function teasers(text = 'Just a teaser', count = 3) {
  return rss({
    link: server.url('/'),
    items: Array.from({ length: count }, (_, i) => i + 1).map((n) => ({
      guid: `p${n}`,
      link: server.url(`/posts/${n}`),
      title: `Post ${n}`,
      description: `<p>${text} ${n}…</p>`,
      date: `Thu, 0${n} Sep 2026 08:00:00 GMT`,
    })),
  })
}

function page(paragraphs: number) {
  return `<html><head><title>Post 1</title></head><body>
    <nav><a href="/">Home</a> <a href="/about">About</a></nav>
    <article><h1>Post 1</h1>${longHtml(paragraphs)}</article>
    <footer>© the author</footer>
  </body></html>`
}

function servePage(path: string, html: string, status = 200) {
  server.set(path, (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
}

async function summaryFeed(text?: string, count?: number) {
  server.text('/feed.xml', teasers(text, count))
  const { feedId } = await registerFeed(db, { feedUrl: server.url('/feed.xml'), now: clock.now() })
  await ingestFeed(ctx(), await claim('feed.fetch', feedId))
  return feedId
}

const article = (id = 1) =>
  first<{
    current_version: number
    content_key: string
    extract_state: string
    word_count: number
    title_hash: string
  }>(
    db,
    sql`select current_version, content_key, extract_state, word_count, title_hash from articles where id = ${id}`,
  )

describe('extractArticleJob', () => {
  test('a summary article is due on arrival and gains a current readability version', async () => {
    await summaryFeed()
    const due = await claimDue(db, {
      kind: 'article.extract',
      owner: 'x',
      now: clock.now(),
      ttlMs: MIN,
      limit: 10,
      due: dueExtractions(),
    })
    // All three are due, but they share a host: politeness takes one at a time.
    expect(due).toHaveLength(1)
    await db.run(sql`delete from leases`)

    const before = await article()
    servePage('/posts/1', page(6))
    const result = await extractArticleJob(ctx(), await claim('article.extract', 1))
    expect(result).toMatchObject({ status: 'extracted', version: 2 })
    const after = await article()
    expect(after?.current_version).toBe(2)
    expect(after?.extract_state).toBe('done')
    expect(after?.word_count).toBeGreaterThan(100)
    // The excerpt changed with the body, so title translations will be redone.
    expect(after?.title_hash).not.toBe(before?.title_hash)
    const version = await first<{ provenance: string; source_url: string }>(
      db,
      sql`select provenance, source_url from article_versions where article_id = 1 and version = 2`,
    )
    expect(version).toEqual({ provenance: 'readability', source_url: server.url('/posts/1') })
    const object = JSON.parse(await (await blobs.get(`c/${after?.content_key}.json`))!.text())
    expect(JSON.stringify(object.blocks)).toContain('Paragraph 6.')
  })

  test('end to end: an edited summary keeps the extraction, then re-extraction replaces it', async () => {
    const feedId = await summaryFeed()
    servePage('/posts/1', page(6))
    await extractArticleJob(ctx(), await claim('article.extract', 1))
    expect((await article())?.current_version).toBe(2)

    // The feed edits its teaser: version 3 is the new summary; the extraction stays current.
    server.text('/feed.xml', teasers('An edited teaser'))
    clock.advance(MIN)
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    expect(await article()).toMatchObject({ current_version: 2, extract_state: 'due' })

    // Re-extraction of the edited post adds version 4, which becomes current.
    servePage('/posts/1', page(8))
    clock.advance(MIN)
    expect(await extractArticleJob(ctx(), await claim('article.extract', 1))).toMatchObject({
      status: 'extracted',
      version: 4,
    })
    expect(await article()).toMatchObject({ current_version: 4, extract_state: 'done' })
  })

  test('re-extracting a page that has not changed adds no version', async () => {
    const feedId = await summaryFeed()
    servePage('/posts/1', page(6))
    await extractArticleJob(ctx(), await claim('article.extract', 1))
    // The teaser is edited, which asks for extraction again; the page itself is the same.
    server.text('/feed.xml', teasers('An edited teaser'))
    clock.advance(MIN)
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    clock.advance(MIN)
    expect(await extractArticleJob(ctx(), await claim('article.extract', 1))).toMatchObject({
      status: 'settled',
      state: 'done',
      reason: 'the page is unchanged since its last extraction',
    })
    const versions = await db.all<{ version: number; provenance: string }>(
      sql`select version, provenance from article_versions where article_id = 1 order by version`,
    )
    expect(versions).toEqual([
      { version: 1, provenance: 'feed' },
      { version: 2, provenance: 'readability' },
      { version: 3, provenance: 'feed' },
    ])
    expect(await article()).toMatchObject({ current_version: 2, extract_state: 'done' })
  })

  test('settles as failed when the page has no article in it, adding no version', async () => {
    await summaryFeed()
    servePage('/posts/1', '<html><body><nav>Home</nav><p>Just a teaser 1…</p></body></html>')
    expect(await extractArticleJob(ctx(), await claim('article.extract', 1))).toMatchObject({
      status: 'settled',
      state: 'failed',
      reason: 'no article content found',
    })
    expect(await db.all(sql`select 1 from article_versions where article_id = 1`)).toHaveLength(1)
  })

  test('settles as done when the page is not clearly longer than what the feed gave', async () => {
    // Two items: too few to classify, and short enough that extraction is worth a look.
    const body = `<p>${'A sentence of the feed body that is the whole post already. '.repeat(7)}</p>`
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [1, 2].map((n) => ({
          guid: `u${n}`,
          link: server.url(`/posts/${n}`),
          title: `Post ${n}`,
          description: 'x',
          content: body,
        })),
      }),
    )
    const { feedId } = await registerFeed(db, {
      feedUrl: server.url('/feed.xml'),
      now: clock.now(),
    })
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    expect((await article())?.extract_state).toBe('due')
    servePage('/posts/1', `<html><body><article><h1>Post 1</h1>${body}</article></body></html>`)
    expect(await extractArticleJob(ctx(), await claim('article.extract', 1))).toMatchObject({
      status: 'settled',
      state: 'done',
    })
    expect(await article()).toMatchObject({ current_version: 1, extract_state: 'done' })
  })

  test('a 404 settles as failed; a 503 or a timeout asks for a retry and changes nothing', async () => {
    await summaryFeed()
    servePage('/posts/1', 'gone', 404)
    expect(await extractArticleJob(ctx(), await claim('article.extract', 1))).toMatchObject({
      status: 'settled',
      state: 'failed',
    })
    expect((await article(1))?.extract_state).toBe('failed')

    servePage('/posts/2', 'busy', 503)
    expect(await extractArticleJob(ctx(), await claim('article.extract', 2))).toEqual({
      status: 'retry',
      error: 'http 503',
    })
    expect((await article(2))?.extract_state).toBe('due')

    server.set('/posts/3', async () => {
      await new Promise((r) => setTimeout(r, 1000))
    })
    expect(await extractArticleJob(ctx(), await claim('article.extract', 3))).toMatchObject({
      status: 'retry',
    })
  })

  test('a holder whose lease was taken over adds no version', async () => {
    await summaryFeed()
    servePage('/posts/1', page(6))
    const stale = await claim('article.extract', 1, 'stalled')
    clock.advance(3 * MIN)
    await claim('article.extract', 1, 'fresh')
    expect(await extractArticleJob(ctx(), stale)).toEqual({ status: 'lost' })
    expect((await article())?.current_version).toBe(1)
  })
})

describe('a page Tela may not fetch (ADR 0061)', () => {
  const robots = (body: string, status = 200) =>
    server.set('/robots.txt', (_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(body)
    })
  const kept = () =>
    first<{ status: number; body: string; fetched_at: number }>(
      db,
      sql`select status, body, fetched_at from robots_rules where origin = ${server.origin}`,
    )
  const asked = (path: string) => server.requests.filter((r) => r.path === path).length
  const marks = () =>
    db.all<{ id: number; extract_state: string; extract_refused: number }>(
      sql`select id, extract_state, extract_refused from articles order by id`,
    )
  const extract = async (id: number) => {
    const result = await extractArticleJob(ctx(), await claim('article.extract', id))
    await db.run(sql`delete from leases`)
    return result
  }

  test("robots.txt refusing it keeps the feed's excerpt, and is asked once for the host", async () => {
    await summaryFeed()
    const before = await article(1)
    robots('User-agent: *\nAllow: /\n\nUser-agent: Tela\nDisallow: /posts/\n')
    servePage('/posts/1', page(6))
    servePage('/posts/2', page(6))
    server.requests.length = 0
    expect(await extract(1)).toEqual({
      status: 'settled',
      state: 'failed',
      reason: `robots.txt disallows the page for ${server.origin}`,
    })
    expect(await extract(2)).toMatchObject({ status: 'settled', state: 'failed' })
    // The post is still the feed's, and nothing else was asked of the blog.
    expect(await article(1)).toEqual({ ...before!, extract_state: 'failed' })
    expect(server.requests.map((r) => r.path)).toEqual(['/robots.txt'])
    expect(await kept()).toEqual({
      status: 200,
      body: 'User-agent: Tela\nDisallow: /posts/\n',
      fetched_at: NOW,
    })
  })

  test('no robots.txt (a 404) allows every page; one that fails to answer allows none', async () => {
    await summaryFeed()
    servePage('/posts/1', page(6))
    servePage('/posts/2', page(6))
    servePage('/posts/3', page(6))
    // The fixture server answers a path it has no route for with a 404.
    expect(await extract(1)).toMatchObject({ status: 'extracted' })
    expect(await kept()).toMatchObject({ status: 404, body: '' })

    // A day on, robots.txt is asked again, and a server error holds every page back.
    clock.advance(24 * 60 * MIN + 1)
    robots('down', 503)
    server.requests.length = 0
    expect(await extract(2)).toEqual({
      status: 'settled',
      state: 'failed',
      reason: `robots.txt of ${server.origin} is unreachable`,
    })
    expect(asked('/posts/2')).toBe(0)
    // Within the hour it is not asked again.
    clock.advance(30 * MIN)
    expect(await extract(3)).toMatchObject({ state: 'failed' })
    expect(asked('/robots.txt')).toBe(1)
    expect(await kept()).toMatchObject({ status: 503 })
  })

  test('rules that change make the posts they refused due again, and only those', async () => {
    await summaryFeed(undefined, 4)
    robots('User-agent: *\nDisallow: /posts/1\nDisallow: /posts/2\n')
    servePage('/posts/1', page(6))
    servePage('/posts/2', page(6))
    servePage('/posts/3', 'gone', 404)
    expect(await extract(1)).toMatchObject({ state: 'failed' })
    expect(await extract(2)).toMatchObject({ state: 'failed' })
    // Allowed, and gone: it fails on its own, and no change of rules brings it back.
    expect(await extract(3)).toMatchObject({ state: 'failed', reason: 'http 404' })
    expect(await marks()).toEqual([
      { id: 1, extract_state: 'failed', extract_refused: 1 },
      { id: 2, extract_state: 'failed', extract_refused: 1 },
      { id: 3, extract_state: 'failed', extract_refused: 0 },
      { id: 4, extract_state: 'due', extract_refused: 0 },
    ])

    // The writer lets Tela in. Nothing asks until a page is due: the blog's next post.
    robots('User-agent: *\nDisallow: /\n\nUser-agent: Tela\nAllow: /\n')
    clock.advance(24 * 60 * MIN + 1)
    expect(await extract(4)).toMatchObject({ status: 'settled' })
    expect(await marks()).toEqual([
      { id: 1, extract_state: 'due', extract_refused: 0 },
      { id: 2, extract_state: 'due', extract_refused: 0 },
      { id: 3, extract_state: 'failed', extract_refused: 0 },
      { id: 4, extract_state: 'failed', extract_refused: 0 },
    ])
    expect(await extract(1)).toMatchObject({ status: 'extracted' })

    // Read again a day later and the same, they make nothing due again.
    servePage('/posts/2', 'gone', 404)
    expect(await extract(2)).toMatchObject({ state: 'failed' })
    clock.advance(24 * 60 * MIN + 1)
    await db.run(sql`update articles set extract_state = 'due' where id = 4`)
    await extract(4)
    expect((await article(2))?.extract_state).toBe('failed')
  })

  test('a robots.txt that answers again retries what it held back, not what failed alone', async () => {
    await summaryFeed()
    servePage('/posts/1', 'gone', 404)
    expect(await extract(1)).toMatchObject({ state: 'failed', reason: 'http 404' })
    clock.advance(24 * 60 * MIN + 1)
    robots('down', 503)
    expect(await extract(2)).toMatchObject({ state: 'failed' })
    expect(await marks()).toEqual([
      { id: 1, extract_state: 'failed', extract_refused: 0 },
      { id: 2, extract_state: 'failed', extract_refused: 1 },
      { id: 3, extract_state: 'due', extract_refused: 0 },
    ])

    // An hour on, it answers that there is no file: what it held back is asked for again.
    clock.advance(60 * MIN + 1)
    server.set('/robots.txt', (_req, res) => {
      res.writeHead(404)
      res.end()
    })
    servePage('/posts/3', page(6))
    expect(await extract(3)).toMatchObject({ status: 'extracted' })
    expect(await marks()).toEqual([
      { id: 1, extract_state: 'failed', extract_refused: 0 },
      { id: 2, extract_state: 'due', extract_refused: 0 },
      { id: 3, extract_state: 'done', extract_refused: 0 },
    ])
  })

  test('a page redirected on its own origin is judged by the path it landed on', async () => {
    await summaryFeed()
    const before = await article(1)
    robots('User-agent: *\nDisallow: /private/\n')
    server.redirect('/posts/1', server.url('/private/post-1'))
    servePage('/private/post-1', page(6))
    server.redirect('/posts/2', server.url('/moved/post-2'))
    servePage('/moved/post-2', page(6))
    expect(await extract(1)).toEqual({
      status: 'settled',
      state: 'failed',
      reason: `robots.txt disallows the page for ${server.origin}`,
    })
    // Still the feed's post, marked as refused, and robots.txt read once for both.
    expect(await article(1)).toEqual({ ...before!, extract_state: 'failed' })
    expect((await marks())[0]).toEqual({ id: 1, extract_state: 'failed', extract_refused: 1 })
    expect(await extract(2)).toMatchObject({ status: 'extracted' })
    expect(server.requestsFor('/robots.txt')).toHaveLength(1)
  })

  test('a page redirected to another origin asks that origin too', async () => {
    const other = await FixtureServer.start()
    try {
      await summaryFeed()
      const before = await article(1)
      // The blog's own robots.txt is a 404: everything goes. Where its posts moved, not all.
      other.set('/robots.txt', (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('User-agent: *\nDisallow: /posts/1\n')
      })
      server.redirect('/posts/1', other.url('/posts/1'))
      server.redirect('/posts/2', other.url('/posts/2'))
      for (const path of ['/posts/1', '/posts/2']) {
        other.set(path, (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(page(6))
        })
      }
      expect(await extract(1)).toEqual({
        status: 'settled',
        state: 'failed',
        reason: `robots.txt disallows the page for ${other.origin}`,
      })
      // Still the feed's post, marked as refused, and both origins' rules kept.
      expect(await article(1)).toEqual({ ...before!, extract_state: 'failed' })
      expect((await marks())[0]).toEqual({ id: 1, extract_state: 'failed', extract_refused: 1 })
      expect(
        await db.all(sql`select origin, status, body from robots_rules order by origin`),
      ).toEqual(
        [
          { origin: server.origin, status: 404, body: '' },
          { origin: other.origin, status: 200, body: 'User-agent: *\nDisallow: /posts/1\n' },
        ].sort((a, b) => (a.origin < b.origin ? -1 : 1)),
      )

      // Allowed there, the page is extracted from where it landed.
      expect(await extract(2)).toMatchObject({ status: 'extracted' })
      expect(
        await first<{ source_url: string }>(
          db,
          sql`select source_url from article_versions where article_id = 2 and provenance = 'readability'`,
        ),
      ).toEqual({ source_url: other.url('/posts/2') })
    } finally {
      await other.stop()
    }
  })

  test('a retry keeps what robots.txt said, so the next attempt does not ask it again', async () => {
    await summaryFeed()
    servePage('/posts/1', 'busy', 503)
    const lease = await claim('article.extract', 1)
    expect(await extractArticleJob(ctx(), lease)).toEqual({ status: 'retry', error: 'http 503' })
    expect(await kept()).toMatchObject({ status: 404 })
    // The lease is still the holder's, for the runner to back off.
    expect(
      await first<{ owner: string }>(
        db,
        sql`select owner from leases where kind = 'article.extract' and key = '1'`,
      ),
    ).toEqual({ owner: lease.owner })
  })
})

describe('a blog whose writer asked for only its feed (ADR 0061)', () => {
  async function feedOnlySummaryFeed() {
    server.text('/feed.xml', teasers())
    const { feedId, siteId } = await registerFeed(db, {
      feedUrl: server.url('/feed.xml'),
      now: clock.now(),
    })
    await db.run(sql`update sites set feed_only = 1 where id = ${siteId}`)
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    return feedId
  }
  const dueNow = () =>
    claimDue(db, {
      kind: 'article.extract',
      owner: 'x',
      now: clock.now(),
      ttlMs: MIN,
      limit: 10,
      due: dueExtractions(),
    })

  test('a summary is stored as the post, and no page is ever due', async () => {
    await feedOnlySummaryFeed()
    const states = await db.all<{ extract_state: string }>(sql`select extract_state from articles`)
    expect(states.map((a) => a.extract_state)).toEqual(['none', 'none', 'none'])
    expect(await dueNow()).toHaveLength(0)
  })

  test('an edited summary does not make the page due either', async () => {
    const feedId = await feedOnlySummaryFeed()
    server.text('/feed.xml', teasers('An edited teaser'))
    clock.advance(MIN)
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    expect(await article()).toMatchObject({ current_version: 2, extract_state: 'none' })
  })

  test('a post found due before the switch is settled without a request', async () => {
    const feedId = await summaryFeed()
    await db.run(sql`update sites set feed_only = 1
      where id = (select site_id from feeds where id = ${feedId})`)
    servePage('/posts/1', page(6))
    server.requests.length = 0
    expect(await extractArticleJob(ctx(), await claim('article.extract', 1))).toEqual({
      status: 'settled',
      state: 'none',
      reason: 'its writer asked for only what the feed provides',
    })
    expect(server.requests).toHaveLength(0)
    expect((await article())?.extract_state).toBe('none')
  })

  test('a post left due when the switch came back on is claimed and settled, unfetched', async () => {
    // An operator's undo of "fetch pages again" puts the column back and nothing else: the
    // blog's posts made due meanwhile are still due. The sweep finds them all the same.
    const feedId = await summaryFeed()
    await db.run(sql`update sites set feed_only = 1
      where id = (select site_id from feeds where id = ${feedId})`)
    servePage('/posts/1', page(6))
    server.requests.length = 0
    for (let n = 0; n < 3; n++) {
      const [due] = await dueNow()
      expect(due).toBeDefined()
      const lease = { kind: 'article.extract' as const, key: due!.key, owner: 'x' }
      expect(await extractArticleJob(ctx(), lease)).toMatchObject({
        status: 'settled',
        state: 'none',
      })
    }
    expect(await dueNow()).toHaveLength(0)
    const states = await db.all<{ extract_state: string }>(sql`select extract_state from articles`)
    expect(states.map((a) => a.extract_state)).toEqual(['none', 'none', 'none'])
    expect(server.requests).toHaveLength(0)
  })

  test('a page read while the switch was turned on is not kept', async () => {
    const feedId = await summaryFeed()
    server.set('/posts/1', async (_req, res) => {
      // The writer turns it on while Tela reads the page, settling the post as the Dashboard does.
      await db.run(sql`update sites set feed_only = 1
        where id = (select site_id from feeds where id = ${feedId})`)
      await db.run(sql`update articles set extract_state = 'none' where extract_state = 'due'`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page(6))
    })
    expect(await extractArticleJob(ctx(), await claim('article.extract', 1))).toEqual({
      status: 'retry',
      error: 'the article changed meanwhile',
    })
    expect(await article()).toMatchObject({ current_version: 1, extract_state: 'none' })
    expect(await db.all(sql`select version from article_versions where article_id = 1`)).toEqual([
      { version: 1 },
    ])
    // Released, and not due: nothing claims it again.
    expect(await dueNow()).toHaveLength(0)
  })

  test("an operator's retry of a failed page leaves a feed-only blog's post alone", async () => {
    const feedId = await summaryFeed()
    servePage('/posts/1', 'gone', 404)
    await extractArticleJob(ctx(), await claim('article.extract', 1))
    await db.run(sql`update sites set feed_only = 1
      where id = (select site_id from feeds where id = ${feedId})`)
    await db.batch(REDUE['article.extract'].statements(db, '1', clock.now(), {}) as never)
    expect((await article())?.extract_state).toBe('failed')
  })
})
