import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { articles } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { createHttpClient, ensureFeed, fetchFeed } from '@tela/ingest'
import { eq } from 'drizzle-orm'
import type { Job } from 'pg-boss'
import type { WorkerContext } from '../src/context'
import { handleArticleExtract } from '../src/jobs/extract-article'
import { type ArticleExtractJob, QUEUES } from '../src/queues'
import { FixtureServer, rss } from './fixture-server'

let t: TestDb
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
}, 120_000)

afterAll(async () => {
  await server.stop()
  await t?.stop()
})

beforeEach(async () => {
  server.reset()
  await resetDatabase(t.db)
})

async function summaryArticle(): Promise<number> {
  server.text(
    '/feed.xml',
    rss({
      link: server.url('/'),
      items: [
        { guid: 'p1', link: server.url('/posts/1'), title: 'Post 1', description: '<p>Teaser</p>' },
      ],
    }),
  )
  const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
  await fetchFeed(t.db, http, feedId)
  const [article] = await t.db.select().from(articles).where(eq(articles.feedId, feedId))
  return article?.id as number
}

const ctx = () => ({ db: t.db, http }) as unknown as WorkerContext
const job = (articleId: number) =>
  ({
    id: crypto.randomUUID(),
    name: QUEUES.articleExtract,
    data: { articleId },
  }) as Job<ArticleExtractJob>

describe('handleArticleExtract', () => {
  test('throws on a transient failure so pg-boss retries, and completes a final one', async () => {
    const articleId = await summaryArticle()
    server.text('/posts/1', 'busy', { status: 503 })
    await expect(handleArticleExtract(ctx(), [job(articleId)])).rejects.toThrow(/http 503/)
    let [row] = await t.db.select().from(articles).where(eq(articles.id, articleId))
    expect(row?.extractCheckedAt).toBeNull()

    server.text('/posts/1', 'gone', { status: 410 })
    await handleArticleExtract(ctx(), [job(articleId)])
    ;[row] = await t.db.select().from(articles).where(eq(articles.id, articleId))
    expect(row?.extractCheckedAt).not.toBeNull()
  })
})
