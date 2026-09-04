import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { articles } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { createHttpClient, ensureFeed } from '@tela/ingest'
import { createMockTranslator } from '@tela/llm'
import { eq, sql } from 'drizzle-orm'
import { type Job, PgBoss } from 'pg-boss'
import type { WorkerContext } from '../src/context'
import { handleFeedFetch } from '../src/jobs/fetch-feed'
import { ensureQueues, type FeedFetchJob, QUEUES } from '../src/queues'
import { FixtureServer, longHtml, rss } from './fixture-server'

let t: TestDb
let boss: PgBoss
let server: FixtureServer
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 500,
})

beforeAll(async () => {
  t = await startTestDb()
  server = await FixtureServer.start()
  boss = new PgBoss({ connectionString: t.url, schema: 'pgboss', max: 2 })
  await boss.start()
  await ensureQueues(boss)
}, 120_000)

afterAll(async () => {
  await boss?.stop({ graceful: false })
  await server.stop()
  await t?.stop()
})

beforeEach(async () => {
  server.reset()
  await resetDatabase(t.db)
  await t.db.execute(sql`delete from pgboss.job where name = ${QUEUES.translateTitle}`)
})

function ctx(): WorkerContext {
  return {
    db: t.db,
    boss,
    http,
    translator: createMockTranslator(),
    assets: null,
    config: { WEBSUB_ENABLED: false, RELAY_CONTROL_URL: 'https://example.invalid/' },
  } as unknown as WorkerContext
}

describe('handleFeedFetch', () => {
  test('queues title jobs with the articles, one per reading language the article is not in', async () => {
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [1, 2].map((n) => ({
          guid: `post-${n}`,
          link: server.url(`/posts/${n}`),
          title: `Post ${n}`,
          description: `Summary ${n}`,
          content: longHtml(4),
          date: `Thu, 0${n} Sep 2026 08:00:00 GMT`,
        })),
      }),
    )
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    const job = {
      id: crypto.randomUUID(),
      name: QUEUES.feedFetch,
      data: { feedId },
    } as Job<FeedFetchJob>
    await handleFeedFetch(ctx(), [job])

    const stored = await t.db
      .select({ id: articles.id, sourceLang: articles.sourceLang })
      .from(articles)
      .where(eq(articles.feedId, feedId))
    expect(stored).toHaveLength(2)
    expect(stored.every((a) => a.sourceLang === 'en')).toBe(true)
    const queued = await t.db.execute<{ singleton_key: string }>(
      sql`select singleton_key from pgboss.job where name = ${QUEUES.translateTitle} order by singleton_key`,
    )
    expect(queued.map((q) => q.singleton_key)).toEqual(stored.map((a) => `${a.id}:zh-Hans`).sort())

    // Same body again: nothing new is stored and nothing new is queued.
    await handleFeedFetch(ctx(), [job])
    const again = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.translateTitle}`,
    )
    expect(again[0]?.n).toBe(2)
  })
})
