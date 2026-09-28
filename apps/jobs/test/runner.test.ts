import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { first, type TelaDb } from '@tela/data'
import { createTestDb } from '@tela/data/testing'
import { createHttpClient } from '@tela/ingest'
import { registerFeed } from '@tela/ingest/pipeline'
import { fakeClock, memoryBlobs, memoryJobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { FixtureServer, longHtml, rss } from '../../../packages/ingest/test/fixture-server'
import { type JobQueues, KINDS } from '../src/kinds'
import { cycle, drain, type PortableContext } from '../src/portable'
import { runJob, tick } from '../src/runner'

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
let ctx: PortableContext
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
  clock = fakeClock(NOW)
  ctx = {
    db,
    blobs: memoryBlobs(),
    http,
    clock,
    random: () => 0.5,
    jobs: memoryJobs<JobQueues>(),
  }
})

const count = async (table: string) =>
  (await first<{ n: number }>(db, sql.raw(`select count(*) as n from ${table}`)))?.n ?? 0

function summaries() {
  return rss({
    link: server.url('/'),
    items: [1, 2, 3].map((n) => ({
      guid: `p${n}`,
      link: server.url(`/posts/${n}`),
      title: `Post ${n}`,
      description: `<p>Teaser ${n}…</p>`,
      date: `Thu, 0${n} Sep 2026 08:00:00 GMT`,
    })),
  })
}

describe('tick and runJob', () => {
  test('a new feed is claimed by the next tick, fetched, and not due again', async () => {
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [
          { guid: 'a', link: server.url('/a'), title: 'A', description: 'a', content: longHtml(4) },
        ],
      }),
    )
    await registerFeed(db, { feedUrl: server.url('/feed.xml'), now: clock.now() })
    const first1 = await tick(ctx)
    expect(first1['feed.fetch']).toBe(1)
    expect(ctx.jobs.sent.map((j) => j.queue)).toEqual(['fetch'])
    const outcomes = await drain(ctx)
    expect(outcomes).toMatchObject([{ status: 'done', result: { status: 'fetched' } }])
    expect(await count('articles')).toBe(1)
    expect(await count('leases')).toBe(0)
    // Scheduled a day out: the next tick finds nothing to do.
    clock.advance(MIN)
    expect((await tick(ctx))['feed.fetch']).toBe(0)
    const beat = await first<{ at: number }>(
      db,
      sql`select at from ops_heartbeats where name = 'tick'`,
    )
    expect(beat?.at).toBe(NOW + MIN)
  })

  test('summary articles are extracted, one per host per cycle', async () => {
    server.text('/feed.xml', summaries())
    for (const n of [1, 2, 3]) {
      server.set(`/posts/${n}`, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<html><body><nav>Home</nav><article><h1>Post ${n}</h1>${longHtml(6)}</article></body></html>`,
        )
      })
    }
    await registerFeed(db, { feedUrl: server.url('/feed.xml'), now: clock.now() })
    await cycle(ctx) // fetch
    const extracted = async () =>
      (
        await first<{ n: number }>(
          db,
          sql`select count(*) as n from articles where extract_state = 'done'`,
        )
      )?.n ?? 0
    for (const expected of [1, 2, 3]) {
      clock.advance(MIN)
      await cycle(ctx)
      expect(await extracted()).toBe(expected)
    }
  })

  test('a step that keeps throwing backs off, then becomes a dead letter that retires its row', async () => {
    // One short item: an unknown-mode feed still extracts it, and only it can be claimed.
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [
          {
            guid: 'only',
            link: server.url('/posts/1'),
            title: 'Only',
            description: '<p>Teaser…</p>',
          },
        ],
      }),
    )
    await registerFeed(db, { feedUrl: server.url('/feed.xml'), now: clock.now() })
    await cycle(ctx)
    // Every extraction attempt blows up inside the step.
    const broken: PortableContext = {
      ...ctx,
      http: {
        get: async () => {
          throw new TypeError('boom')
        },
      },
    }
    const spec = KINDS['article.extract']!
    const outcomes: string[] = []
    for (let attempt = 0; attempt < spec.backoff.maxAttempts; attempt++) {
      // Past each backoff (5, 10, 20 min), and well short of the feed's own next fetch.
      clock.advance(61 * MIN)
      const { outcomes: ran } = await cycle(broken)
      outcomes.push(...ran.map((o) => o.status))
    }
    expect(outcomes).toEqual(['retrying', 'retrying', 'retrying', 'dead'])
    const dead = await first<{ kind: string; key: string; error: string }>(
      db,
      sql`select kind, key, error from dead_letters`,
    )
    expect(dead).toMatchObject({ kind: 'article.extract', error: 'TypeError: boom' })
    const retired = await first<{ extract_state: string }>(
      db,
      sql`select extract_state from articles where id = ${Number(dead?.key)}`,
    )
    expect(retired?.extract_state).toBe('failed')
  })

  test('a message whose claim was superseded does nothing', async () => {
    server.text('/feed.xml', summaries())
    await registerFeed(db, { feedUrl: server.url('/feed.xml'), now: clock.now() })
    await tick(ctx)
    const [message] = ctx.jobs.take('fetch')
    // The claim expires before the message is handled; the next tick claims it again.
    clock.advance(KINDS['feed.fetch']!.ttlMs + MIN)
    await tick(ctx)
    expect(await runJob(ctx, message!)).toEqual({ status: 'lost' })
    expect(await count('articles')).toBe(0)
    await drain(ctx)
    expect(await count('articles')).toBe(3)
  })
})
