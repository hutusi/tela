import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { first, startLease, type TelaDb } from '@tela/data'
import { createTestDb } from '@tela/data/testing'
import { createHttpClient } from '@tela/ingest'
import { registerFeed } from '@tela/ingest/pipeline'
import type { JobMessage } from '@tela/platform'
import { fakeClock, memoryBlobs, memoryJobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { FixtureServer, longHtml, rss } from '../../../packages/ingest/test/fixture-server'
import { type JobQueues, KINDS } from '../src/kinds'
import { cycle, drain, type PortableContext } from '../src/portable'
import { runJob, SAME_HOST_GAP_SECONDS, tick } from '../src/runner'

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

  test("a host's summary articles are extracted one after another, a gap apart, not one a tick", async () => {
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
    // take() hands messages out and forgets them, so note each extraction's delay as it is sent.
    const delays: number[] = []
    const sendBatch = ctx.jobs.sendBatch.bind(ctx.jobs)
    ctx.jobs.sendBatch = (async (
      queue: keyof JobQueues & string,
      messages: JobMessage<unknown>[],
    ) => {
      if (queue === 'extract') delays.push(...messages.map((m) => m.delaySeconds ?? 0))
      return sendBatch(queue, messages as never)
    }) as typeof ctx.jobs.sendBatch
    clock.advance(MIN)
    const { tick: claimed } = await cycle(ctx)
    // The tick takes one per host; each success claims the next on that host.
    expect(claimed['article.extract']).toBe(1)
    const done = await first<{ n: number }>(
      db,
      sql`select count(*) as n from articles where extract_state = 'done'`,
    )
    expect(done?.n).toBe(3)
    expect(delays).toEqual([0, SAME_HOST_GAP_SECONDS, SAME_HOST_GAP_SECONDS])
    expect(await count('leases')).toBe(0)
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
    // It never started, so waiting in the queue cost it no attempt.
    expect(await first<{ attempts: number }>(db, sql`select attempts from leases`)).toEqual({
      attempts: 0,
    })
    expect(await count('articles')).toBe(0)
    await drain(ctx)
    expect(await count('articles')).toBe(3)
  })

  test('a job that dies without reporting is counted, then retired rather than retried for ever', async () => {
    server.text('/feed.xml', summaries())
    await registerFeed(db, { feedUrl: server.url('/feed.xml'), now: clock.now() })
    const spec = KINDS['feed.fetch']!
    for (let attempt = 1; attempt <= spec.backoff.maxAttempts; attempt++) {
      expect((await tick(ctx))['feed.fetch']).toBe(1)
      const [message] = ctx.jobs.take('fetch')
      // runJob starts the attempt, then the invocation is killed (CPU, memory, eviction): no
      // result, no failLease, only a lease that expires.
      expect((await startLease(db, message!, clock.now(), spec.ttlMs))?.attempts).toBe(attempt)
      clock.advance(spec.ttlMs + MIN)
    }
    expect((await tick(ctx))['feed.fetch']).toBe(0)
    expect(ctx.jobs.take('fetch')).toEqual([])
    const dead = await first<{ attempts: number; error: string }>(
      db,
      sql`select attempts, error from dead_letters where kind = 'feed.fetch'`,
    )
    expect(dead?.attempts).toBe(spec.backoff.maxAttempts)
    expect(dead?.error).toMatch(/died or overran its lease/)
    expect(await count('leases')).toBe(0)
    const feed = await first<{ next_fetch_at: number }>(db, sql`select next_fetch_at from feeds`)
    expect(feed?.next_fetch_at).toBe(clock.now() + 24 * 60 * MIN)
  })
})
