import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, dueExtractions, first, type Lease, type TelaDb } from '@tela/data'
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

function teasers(text = 'Just a teaser') {
  return rss({
    link: server.url('/'),
    items: [1, 2, 3].map((n) => ({
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

async function summaryFeed(text?: string) {
  server.text('/feed.xml', teasers(text))
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
