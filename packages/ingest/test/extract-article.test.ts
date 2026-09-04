import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { articleContents, articles } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { eq } from 'drizzle-orm'
import { ensureFeed } from '../src/ensure-feed'
import { extractArticleContent } from '../src/extract-article'
import { fetchFeed } from '../src/fetch-feed'
import { createHttpClient } from '../src/http'
import { FixtureServer, longHtml, rss } from './fixture-server'

let t: TestDb
let server: FixtureServer
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
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

async function summaryOnlyArticle() {
  server.text(
    '/feed.xml',
    rss({
      link: server.url('/'),
      items: [
        {
          guid: 'p1',
          link: server.url('/posts/1'),
          title: 'Post 1',
          description: '<p>Just a teaser…</p>',
        },
      ],
    }),
  )
  const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
  await fetchFeed(t.db, http, feedId)
  const [article] = await t.db.select().from(articles).where(eq(articles.feedId, feedId))
  if (!article) throw new Error('no article')
  return article
}

describe('extractArticleContent', () => {
  test('replaces a summary with the extracted page body', async () => {
    const article = await summaryOnlyArticle()
    server.set('/posts/1', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<html><head><title>Post 1</title></head><body>
        <nav><a href="/">Home</a></nav>
        <article><h1>Post 1</h1>${longHtml(6)}</article>
      </body></html>`)
    })
    const result = await extractArticleContent(t.db, http, article.id)
    expect(result).toMatchObject({ status: 'extracted' })
    const [updated] = await t.db.select().from(articles).where(eq(articles.id, article.id))
    expect(updated?.contentVersion).toBe(2)
    expect(updated?.wordCount).toBeGreaterThan(100)
    const [contents] = await t.db
      .select()
      .from(articleContents)
      .where(eq(articleContents.articleId, article.id))
    expect(contents?.extractedFrom).toBe('readability')
    expect(contents?.html).toContain('Paragraph 6.')
    expect(updated?.extractCheckedAt).not.toBeNull()
  })

  test('keeps the feed content when the page has nothing better', async () => {
    const article = await summaryOnlyArticle()
    server.set('/posts/1', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><a href="/">home</a></body></html>')
    })
    expect(await extractArticleContent(t.db, http, article.id)).toMatchObject({ status: 'failed' })
    const [same] = await t.db.select().from(articles).where(eq(articles.id, article.id))
    expect(same?.contentVersion).toBe(1)
    // Stamped anyway, so the reader does not queue this article again on every open.
    expect(same?.extractCheckedAt).not.toBeNull()
  })

  test('reports fetch failures', async () => {
    const article = await summaryOnlyArticle()
    server.text('/posts/1', 'nope', { status: 500 })
    expect(await extractArticleContent(t.db, http, article.id)).toMatchObject({
      status: 'failed',
      error: 'http 500',
    })
  })
})
