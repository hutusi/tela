import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  adoptExtractedVersion,
  claimDue,
  dueReprocessing,
  first,
  type Lease,
  type TelaDb,
} from '@tela/data'
import { createTestDb } from '@tela/data/testing'
import type { Blobs } from '@tela/platform'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { PIPELINE_VERSION } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createHttpClient } from '../src/http'
import {
  commit,
  extractArticleJob,
  type IngestContext,
  ingestFeed,
  registerFeed,
  reprocessArticleJob,
} from '../src/pipeline'
import { FixtureServer, longHtml, rss } from './fixture-server'

const NOW = Date.UTC(2026, 9, 25, 10)
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

/** A full-content feed with two posts, fetched once: each has version 1, made by this pipeline. */
async function fullFeed() {
  server.text(
    '/feed.xml',
    rss({
      link: server.url('/'),
      items: [1, 2].map((n) => ({
        guid: `p${n}`,
        link: server.url(`/posts/${n}`),
        title: `Post ${n}`,
        description: 'x',
        content: longHtml(4),
        date: `Thu, 0${n} Oct 2026 08:00:00 GMT`,
      })),
    }),
  )
  const { feedId } = await registerFeed(db, { feedUrl: server.url('/feed.xml'), now: clock.now() })
  await ingestFeed(ctx(), await claim('feed.fetch', feedId))
  await db.run(sql`delete from leases`)
  return feedId
}

const due = async () =>
  (await db.all<{ key: number }>(sql`select key from (${dueReprocessing()}) order by key`)).map(
    (r) => Number(r.key),
  )

const article = (id = 1) =>
  first<{ current_version: number; content_key: string; extract_state: string; seq: number }>(
    db,
    sql`select current_version, content_key, extract_state, seq from articles where id = ${id}`,
  )

const version = (id: number, v: number) =>
  first<{
    provenance: string
    content_key: string
    raw_key: string | null
    pipeline_version: number
  }>(
    db,
    sql`select provenance, content_key, raw_key, pipeline_version from article_versions
        where article_id = ${id} and version = ${v}`,
  )

describe('reprocessArticleJob', () => {
  test('a version made by this pipeline is not due; one made by an older pipeline is', async () => {
    await fullFeed()
    expect(await due()).toEqual([])
    expect((await version(1, 1))?.pipeline_version).toBe(PIPELINE_VERSION)
    await db.run(sql`update article_versions set pipeline_version = 0 where article_id = 1`)
    expect(await due()).toEqual([1])
  })

  test('a body that comes out the same is stamped current, and gains no version', async () => {
    await fullFeed()
    await db.run(sql`update article_versions set pipeline_version = 0`)
    const before = await article()
    const result = await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))
    expect(result).toEqual({ status: 'unchanged' })
    expect(await article()).toMatchObject({ current_version: 1, content_key: before?.content_key })
    expect((await version(1, 1))?.pipeline_version).toBe(PIPELINE_VERSION)
    // The other post is still due: one article per lease.
    expect(await due()).toEqual([2])
  })

  test('a body the pipeline now makes differently becomes a new current version', async () => {
    await fullFeed()
    const made = await article()
    // What an older pipeline left: another object, under another key, and an extraction state
    // that reprocessing has no business touching.
    await db.batch([
      db.run(sql`update article_versions set pipeline_version = 0, content_key = 'older'
        where article_id = 1`),
      db.run(sql`update articles set content_key = 'older', extract_state = 'none' where id = 1`),
    ] as never)
    const result = await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))
    expect(result).toEqual({ status: 'reprocessed', version: 2 })

    const after = await article()
    expect(after).toMatchObject({
      current_version: 2,
      content_key: made?.content_key,
      extract_state: 'none',
    })
    expect(after?.seq).toBeGreaterThan(made?.seq ?? 0)
    const v1 = await version(1, 1)
    const v2 = await version(1, 2)
    // Made from the same raw HTML, with the same provenance, under this pipeline.
    expect(v2).toMatchObject({
      provenance: 'feed',
      raw_key: v1?.raw_key,
      pipeline_version: PIPELINE_VERSION,
    })
    expect(await blobs.get(`c/${made?.content_key}.json`)).not.toBeNull()
    // Only this article was made by the older pipeline here, and now it is current.
    expect(await due()).toEqual([])
  })

  test('a version without its raw HTML is stamped and kept as it is', async () => {
    await fullFeed()
    await db.run(sql`update article_versions set pipeline_version = 0, raw_key = null
      where article_id = 1`)
    const result = await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))
    expect(result).toEqual({ status: 'skipped', reason: 'no raw html' })
    expect((await version(1, 1))?.pipeline_version).toBe(PIPELINE_VERSION)
    expect((await article())?.current_version).toBe(1)
  })

  test('only the current version is made again', async () => {
    await fullFeed()
    // An older version lying behind the current one is history, not due.
    await db.batch([
      db.run(sql`insert into article_versions (article_id, version, provenance, content_key,
          raw_key, norm_version, pipeline_version, body_chars, created_at)
        select article_id, 2, provenance, content_key, raw_key, norm_version, ${PIPELINE_VERSION},
          body_chars, created_at from article_versions where article_id = 1 and version = 1`),
      db.run(sql`update articles set current_version = 2 where id = 1`),
      db.run(
        sql`update article_versions set pipeline_version = 0 where article_id = 1 and version = 1`,
      ),
    ] as never)
    expect(await due()).toEqual([])
  })

  test('a holder that lost its lease writes nothing', async () => {
    await fullFeed()
    await db.run(sql`update article_versions set pipeline_version = 0, content_key = 'older'
      where article_id = 1`)
    const lease = await claim('article.reprocess', 1)
    // The lease runs out and another worker takes the article.
    clock.advance(3 * MIN)
    await claim('article.reprocess', 1, 'w2')
    expect(await reprocessArticleJob(ctx(), lease)).toEqual({ status: 'lost' })
    expect((await article())?.current_version).toBe(1)
    expect(await version(1, 2)).toBeUndefined()
  })

  /** Blobs that run `meanwhile` the first time a raw body is read: a writer landing mid-job. */
  const racing = (meanwhile: () => Promise<void>): Blobs => {
    let ran = false
    return {
      get: async (key) => {
        if (!ran && key.startsWith('r/')) {
          ran = true
          await meanwhile()
        }
        return blobs.get(key)
      },
      head: (key) => blobs.head(key),
      put: (key, body, options) => blobs.put(key, body, options),
      delete: (key) => blobs.delete(key),
      list: (options) => blobs.list(options),
    }
  }

  /** Whether the article points at a version row that holds the content key it shows. */
  const consistent = async (id = 1) => {
    const row = await first<{ ok: number }>(
      db,
      sql`select count(*) as ok from articles a join article_versions v
          on v.article_id = a.id and v.version = a.current_version and v.content_key = a.content_key
          where a.id = ${id}`,
    )
    return row?.ok === 1
  }

  /** What an extraction commits, under its own lease: version 2, the article moved onto it. */
  const extractionLands = async () => {
    const lease = await claim('article.extract', 1, 'x')
    const made = {
      version: 2,
      provenance: 'readability' as const,
      contentKey: 'extracted',
      bodyChars: 9000,
      excerpt: 'Extracted',
      wordCount: 1500,
      readingMinutes: 7,
      lang: 'en',
    }
    await commit(ctx(), lease, [
      ...adoptExtractedVersion(
        db,
        { id: 1, feedId: 1, currentVersion: 1 },
        { ...made, rawKey: null, sourceUrl: null },
        made,
        'th-x',
        clock.now(),
      ),
    ])
  }

  test('a writer that moved the article meanwhile wins, and the reprocess writes nothing', async () => {
    await fullFeed()
    // Due, or the extraction would land nowhere: it adopts only a page its post still waits for.
    await db.batch([
      db.run(sql`update article_versions set pipeline_version = 0, content_key = 'older'
        where article_id = 1`),
      db.run(sql`update articles set content_key = 'older', extract_state = 'due' where id = 1`),
    ] as never)
    const lease = await claim('article.reprocess', 1)
    // Both read version 1 and both take version 2: the extraction commits first.
    const result = await reprocessArticleJob({ ...ctx(), blobs: racing(extractionLands) }, lease)
    expect(result).toEqual({ status: 'skipped', reason: 'superseded' })
    expect(await article()).toMatchObject({ current_version: 2, content_key: 'extracted' })
    expect(await consistent()).toBe(true)
  })

  test('an extraction that loses to a reprocess writes nothing, and goes again', async () => {
    await fullFeed()
    await db.run(sql`update articles set extract_state = 'due' where id = 1`)
    server.set('/posts/1', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<html><body><article><h1>Post 1</h1>${longHtml(12)}</article></body></html>`)
    })
    // The reprocess lands while the extraction is fetching the page: it takes version 2.
    await db.batch([
      db.run(sql`update article_versions set pipeline_version = 0, content_key = 'older'
        where article_id = 1`),
      db.run(sql`update articles set content_key = 'older' where id = 1`),
    ] as never)
    const extract = await claim('article.extract', 1, 'x')
    const reprocessFirst: IngestContext['http'] = {
      ...http,
      get: async (url, options) => {
        await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))
        return http.get(url, options)
      },
    }
    const result = await extractArticleJob({ ...ctx(), http: reprocessFirst }, extract)
    expect(result).toEqual({ status: 'retry', error: 'the article changed meanwhile' })
    const after = await article()
    expect(after?.current_version).toBe(2)
    expect(after?.extract_state).toBe('due')
    expect(await consistent()).toBe(true)
  })

  test('an item without a link of its own is made against the feed, as it first was', async () => {
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [
          {
            guid: 'no-link',
            title: 'A post with no link',
            description: 'x',
            content: `${longHtml(3)}<p>See <a href="/elsewhere">this</a>.</p><p><img src="/photo.jpg" alt="A photo"></p>`,
            date: 'Thu, 01 Oct 2026 08:00:00 GMT',
          },
        ],
      }),
    )
    const { feedId } = await registerFeed(db, {
      feedUrl: server.url('/feed.xml'),
      now: clock.now(),
    })
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    await db.run(sql`delete from leases`)
    const first = await article()
    const object = await (await blobs.get(`c/${first?.content_key}.json`))?.text()
    expect(object).toContain(server.url('/elsewhere'))
    // Made again from the same raw HTML, it must come out the same: the same base.
    await db.batch([
      db.run(sql`update article_versions set pipeline_version = 0, content_key = 'older'
        where article_id = 1`),
      db.run(sql`update articles set content_key = 'older' where id = 1`),
    ] as never)
    expect(await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))).toEqual({
      status: 'reprocessed',
      version: 2,
    })
    expect((await article())?.content_key).toBe(first?.content_key)
  })

  test('an excerpt the pipeline now makes differently is a new version of the same body', async () => {
    await fullFeed()
    const made = await article()
    const before = await first<{ title_hash: string }>(
      db,
      sql`select title_hash from articles where id = 1`,
    )
    // An older pipeline cut the excerpt another way; the body itself came out the same.
    await db.batch([
      db.run(sql`update article_versions set pipeline_version = 0, excerpt = 'An older excerpt'
        where article_id = 1`),
      db.run(
        sql`update articles set excerpt = 'An older excerpt', title_hash = 'th-old' where id = 1`,
      ),
    ] as never)
    expect(await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))).toEqual({
      status: 'reprocessed',
      version: 2,
    })
    const after = await first<{ content_key: string; excerpt: string; title_hash: string }>(
      db,
      sql`select content_key, excerpt, title_hash from articles where id = 1`,
    )
    // The same content key: its body translations are still its own.
    expect(after?.content_key).toBe(made?.content_key)
    expect(after?.excerpt).not.toBe('An older excerpt')
    expect(after?.title_hash).toBe(before?.title_hash)
  })

  /** A feed of one post, as the fixture serves it now. */
  const onePost = (body: string, title: string, more: { date?: string; link?: string } = {}) =>
    rss({
      link: server.url('/'),
      items: [
        {
          guid: 'p1',
          link: more.link ?? server.url('/posts/1'),
          title,
          description: 'x',
          content: body,
          date: more.date ?? 'Thu, 01 Oct 2026 08:00:00 GMT',
        },
      ],
    })

  /** Blobs that run `meanwhile` before the first write: a writer landing while a fetch stores. */
  const racingPut = (meanwhile: () => Promise<void>): Blobs => {
    let ran = false
    return {
      get: (key) => blobs.get(key),
      head: (key) => blobs.head(key),
      put: async (key, body, options) => {
        if (!ran) {
          ran = true
          await meanwhile()
        }
        return blobs.put(key, body, options)
      },
      delete: (key) => blobs.delete(key),
      list: (options) => blobs.list(options),
    }
  }

  /** The post fetched once, then stored as if by an older pipeline: due for a reprocess. */
  const fetchedThenAged = async (body = longHtml(4)) => {
    server.text('/feed.xml', onePost(body, 'Post 1'))
    const { feedId } = await registerFeed(db, {
      feedUrl: server.url('/feed.xml'),
      now: clock.now(),
    })
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    await db.run(sql`delete from leases`)
    await db.batch([
      db.run(sql`update article_versions set pipeline_version = 0, content_key = 'older'
        where article_id = 1`),
      db.run(sql`update articles set content_key = 'older' where id = 1`),
    ] as never)
    return feedId
  }

  const reprocessNow = async () => {
    await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))
  }

  test("a feed's change that loses to a reprocess is fetched again, not lost behind a 304", async () => {
    const feedId = await fetchedThenAged()
    // The feed edits the post.
    server.text('/feed.xml', onePost(`${longHtml(4)}<p>An added paragraph.</p>`, 'Post 1, edited'))
    clock.advance(2 * 60 * MIN)
    // The reprocess commits while the fetch is storing its objects: both took version 2.
    await ingestFeed(
      { ...ctx(), blobs: racingPut(reprocessNow) },
      await claim('feed.fetch', feedId),
    )
    expect(
      (await first<{ title: string }>(db, sql`select title from articles where id = 1`))?.title,
    ).toBe('Post 1')
    expect(await consistent()).toBe(true)
    const feed = await first<Record<string, unknown>>(
      db,
      sql`select etag, last_modified, last_body_hash, next_fetch_at from feeds where id = ${feedId}`,
    )
    // It forgot what would have let its next fetch skip the item, and is due now.
    expect(feed).toEqual({
      etag: null,
      last_modified: null,
      last_body_hash: null,
      next_fetch_at: clock.now(),
    })

    await db.run(sql`delete from leases`)
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    const after = await first<{ title: string; current_version: number }>(
      db,
      sql`select title, current_version from articles where id = 1`,
    )
    expect(after).toEqual({ title: 'Post 1, edited', current_version: 3 })
    expect(await consistent()).toBe(true)
  })

  test("a feed's edit lands when a reprocess made the same body first", async () => {
    const feedId = await fetchedThenAged()
    // The feed edits only the title and the date, so today's pipeline makes the same body from
    // the item as the reprocess makes from the stored HTML. A replay could not help: the next
    // fetch would find that body already stored and skip the item (Codex's third review).
    server.text(
      '/feed.xml',
      onePost(longHtml(4), 'Post 1, edited', { date: 'Fri, 02 Oct 2026 08:00:00 GMT' }),
    )
    clock.advance(2 * 60 * MIN)
    await ingestFeed(
      { ...ctx(), blobs: racingPut(reprocessNow) },
      await claim('feed.fetch', feedId),
    )
    const after = await first<{
      title: string
      published_at: number
      sort_at: number
      current_version: number
    }>(db, sql`select title, published_at, sort_at, current_version from articles where id = 1`)
    expect(after).toEqual({
      title: 'Post 1, edited',
      published_at: Date.UTC(2026, 9, 2, 8),
      sort_at: Date.UTC(2026, 9, 2, 8),
      current_version: 2,
    })
    // The reprocess's row, which holds the body the feed brought.
    expect(await version(1, 2)).toMatchObject({
      provenance: 'feed',
      pipeline_version: PIPELINE_VERSION,
    })
    expect(await consistent()).toBe(true)
    // It landed, so the feed keeps what it saved: nothing to fetch again.
    const feed = await first<{ last_body_hash: string | null; next_fetch_at: number }>(
      db,
      sql`select last_body_hash, next_fetch_at from feeds where id = ${feedId}`,
    )
    expect(feed?.last_body_hash).not.toBeNull()
    expect(feed?.next_fetch_at).toBeGreaterThan(clock.now())
  })

  test("a feed's corrected link asks for its page again when a reprocess made the same body first", async () => {
    // A summary whose page was not found at the link the feed first gave.
    const summary = '<p>A short summary of the post, with no links in it.</p>'
    const feedId = await fetchedThenAged(summary)
    await db.run(sql`update articles set extract_state = 'failed' where id = 1`)
    // The feed corrects the link, and the reprocess makes the same body first (Codex's fourth
    // review): the page at the new link is wanted, as it is when nothing races.
    const fixed = server.url('/posts/1-fixed')
    server.text('/feed.xml', onePost(summary, 'Post 1', { link: fixed }))
    clock.advance(2 * 60 * MIN)
    await ingestFeed(
      { ...ctx(), blobs: racingPut(reprocessNow) },
      await claim('feed.fetch', feedId),
    )
    expect(
      await first<{ url: string; current_version: number; extract_state: string }>(
        db,
        sql`select url, current_version, extract_state from articles where id = 1`,
      ),
    ).toEqual({ url: fixed, current_version: 2, extract_state: 'due' })
    expect(await version(1, 2)).toMatchObject({
      provenance: 'feed',
      pipeline_version: PIPELINE_VERSION,
    })
    expect(await consistent()).toBe(true)
  })

  test('a body that comes out the same keeps the language its object says', async () => {
    await fullFeed()
    const made = await article()
    // What an older detector stored, in the version, the article and the shared object alike.
    const key = `c/${made?.content_key}.json`
    const object = JSON.parse((await (await blobs.get(key))?.text()) ?? '{}')
    await blobs.put(key, JSON.stringify({ ...object, lang: 'fr' }))
    await db.batch([
      db.run(
        sql`update article_versions set pipeline_version = 0, lang = 'fr' where article_id = 1`,
      ),
      db.run(sql`update articles set source_lang = 'fr' where id = 1`),
    ] as never)
    expect(await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))).toEqual({
      status: 'unchanged',
    })
    const after = await first<{ source_lang: string; lang: string }>(
      db,
      sql`select a.source_lang, v.lang from articles a
          join article_versions v on v.article_id = a.id and v.version = a.current_version where a.id = 1`,
    )
    // Still what its object says, so a reader of the other language is not refused.
    expect(after).toEqual({ source_lang: 'fr', lang: 'fr' })
  })

  test("a feed that moved does not move an older link-less post's images", async () => {
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [
          {
            guid: 'no-link',
            title: 'A post with no link',
            description: 'x',
            content: `${longHtml(3)}<p><img src="photo.jpg" alt="A photo"></p>`,
            date: 'Thu, 01 Oct 2026 08:00:00 GMT',
          },
        ],
      }),
    )
    const { feedId } = await registerFeed(db, {
      feedUrl: server.url('/feed.xml'),
      now: clock.now(),
    })
    await ingestFeed(ctx(), await claim('feed.fetch', feedId))
    await db.run(sql`delete from leases`)
    const made = await article()
    // The base it was made against is kept with the version.
    expect(
      (
        await first<{ source_url: string }>(
          db,
          sql`select source_url from article_versions where article_id = 1`,
        )
      )?.source_url,
    ).toBe(server.url('/feed.xml'))
    // The feed moves; the post is made again.
    await db.batch([
      db.run(
        sql`update feeds set feed_url = ${server.url('/moved/feed.xml')} where id = ${feedId}`,
      ),
      db.run(sql`update article_versions set pipeline_version = 0, content_key = 'older'
        where article_id = 1`),
      db.run(sql`update articles set content_key = 'older' where id = 1`),
    ] as never)
    await reprocessArticleJob(ctx(), await claim('article.reprocess', 1))
    expect((await article())?.content_key).toBe(made?.content_key)
  })
})
