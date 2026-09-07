import { type ArticleDetail, readingRevision } from '@tela/db/queries'

/**
 * What an open article is still waiting on, as one string, built from the row the page already
 * has. A reader tab polls `/api/reading/state` for this instead of re-rendering the page to find
 * out whether a translation or a full-text fetch has moved.
 */
export function articleRevision(article: ArticleDetail): string {
  return readingRevision({
    contentHash: article.contentHash,
    extractCheckedAt: article.extractCheckedAt,
    translation: article.translation
      ? { status: article.translation.status, contentHash: article.translation.contentHash }
      : null,
  })
}
