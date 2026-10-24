import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { claimDue, dueReprocessing, first, type Lease, type TelaDb } from '@tela/data'
import { createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { PIPELINE_VERSION } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createHttpClient } from '../src/http'
import { type IngestContext, ingestFeed, registerFeed, reprocessArticleJob } from '../src/pipeline'
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
})
