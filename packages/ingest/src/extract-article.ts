import { processArticleHtml } from '@tela/content'
import { extractArticle } from '@tela/content/extract'
import { articleContents, articles, type Db, feeds } from '@tela/db'
import { eq } from 'drizzle-orm'
import { type HttpClient, HttpError } from './http'

export type ExtractResult =
  | { status: 'extracted'; chars: number }
  | { status: 'skipped'; reason: string }
  /** `retryable`: the page may answer later (timeout, network, 5xx), so nothing is recorded. */
  | { status: 'failed'; error: string; retryable: boolean }

/**
 * Fetch an article's page and replace summary-only content with the extracted body.
 * Keeps the existing content when extraction is not clearly better. A final outcome stamps
 * `articles.extract_checked_at`, so the reader queues extraction for an article once; a
 * transient failure leaves it unstamped so the job can retry and a later open can ask again.
 */
export async function extractArticleContent(
  db: Db,
  http: HttpClient,
  articleId: number,
): Promise<ExtractResult> {
  const [row] = await db
    .select({
      article: articles,
      feed: { feedUrl: feeds.feedUrl, fetchRegion: feeds.fetchRegion, language: feeds.title },
      contentsLength: articleContents.html,
      blocks: articleContents.blocks,
    })
    .from(articles)
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .leftJoin(articleContents, eq(articleContents.articleId, articles.id))
    .where(eq(articles.id, articleId))
  if (!row) return { status: 'skipped', reason: 'article not found' }
  const { article } = row
  const result = await attempt(db, http, row)
  if (!(result.status === 'failed' && result.retryable)) {
    await db
      .update(articles)
      .set({ extractCheckedAt: new Date() })
      .where(eq(articles.id, article.id))
  }
  return result
}

type ArticleRow = {
  article: typeof articles.$inferSelect
  feed: { feedUrl: string; fetchRegion: 'global' | 'cn'; language: string | null }
  contentsLength: string | null
  blocks: (typeof articleContents.$inferSelect)['blocks'] | null
}

async function attempt(db: Db, http: HttpClient, row: ArticleRow): Promise<ExtractResult> {
  const { article } = row
  if (!article.url) return { status: 'skipped', reason: 'article has no url' }

  let page: Awaited<ReturnType<HttpClient['get']>>
  try {
    page = await http.get(article.url, {
      region: row.feed.fetchRegion,
      accept: 'text/html, application/xhtml+xml, */*;q=0.5',
    })
  } catch (err) {
    if (err instanceof HttpError) {
      return {
        status: 'failed',
        error: `${err.kind}: ${err.message}`,
        retryable: err.kind === 'timeout' || err.kind === 'network',
      }
    }
    throw err
  }
  if (page.status !== 200 || !page.body) {
    return {
      status: 'failed',
      error: `http ${page.status}`,
      retryable: page.status >= 500 || page.status === 429 || page.status === 408,
    }
  }

  const extracted = extractArticle(page.body, page.finalUrl)
  if (!extracted) return { status: 'failed', error: 'no article content found', retryable: false }

  const processed = await processArticleHtml({
    html: extracted.contentHtml,
    baseUrl: page.finalUrl,
    langHint: article.sourceLang ?? extracted.lang,
    title: article.title,
  })
  const currentChars = row.blocks?.reduce((n, b) => n + (b.skip ? 0 : b.chars), 0) ?? 0
  if (processed.text.length <= currentChars * 1.2) {
    return { status: 'skipped', reason: 'extraction is not longer than the feed content' }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(articles)
      .set({
        author: article.author ?? extracted.byline,
        sourceLang: processed.lang === 'und' ? article.sourceLang : processed.lang,
        excerpt: processed.excerpt || article.excerpt,
        contentHash: processed.contentHash,
        contentVersion: article.contentVersion + 1,
        wordCount: processed.wordCount,
        readingMinutes: processed.readingMinutes,
      })
      .where(eq(articles.id, article.id))
    await tx
      .insert(articleContents)
      .values({
        articleId: article.id,
        html: processed.html,
        blocks: processed.blocks,
        extractedFrom: 'readability',
      })
      .onConflictDoUpdate({
        target: articleContents.articleId,
        set: {
          html: processed.html,
          blocks: processed.blocks,
          extractedFrom: 'readability',
          updatedAt: new Date(),
        },
      })
  })
  return { status: 'extracted', chars: processed.text.length }
}
